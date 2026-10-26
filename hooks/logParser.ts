import { countTokens } from './estimate'

// Reads Claude Code session logs (JSON Lines, one record per line) into a
// compact model of the session. Pure and incremental: feed it text in pieces
// of any size with `push`, call `end` once per source. Only small summaries of
// each record are kept, never the record's text, so memory follows the number
// of records rather than the size of the file. Nothing here calls a model.
//
// Assumptions about the log format, each pinned by a test in tests/log.test.ts:
// - An assistant response is written as one record per content block; every
//   record of one response repeats the same `message.id` and the same usage.
//   Usage is counted once per `message.id`.
// - `usage.output_tokens` already includes thinking;
//   `output_tokens_details.thinking_tokens` is the part of it that was thinking.
// - A record with `isSidechain: true` or an `agentId` belongs to a subagent,
//   as does every record of a source named `agent-*.jsonl`.
// - An attachment reaches the model only when its `rendered` list is not empty;
//   its text is `rendered[].content`.
// - `model: "<synthetic>"` marks a message the client wrote itself (an error
//   notice): no request was made, so its usage is ignored.

export type IssueKind =
  | 'malformed-json'
  | 'not-an-object'
  | 'partial-line'
  | 'duplicate-uuid'
  | 'usage-mismatch'
  | 'bad-field'
  | 'broken-chain'

export type LogIssue = { source: string; line: number; kind: IssueKind; detail: string }

/** Where a record sits, so the panel can point at it. */
export type Location = { source: string; line: number; uuid: string | null }

export type Category = 'messages' | 'systemTools' | 'mcpTools' | 'skills'

export type OffenderKind = 'tool-result' | 'file-read' | 'paste' | 'attachment' | 'image' | 'tool-input'

/** A content block big enough to be worth naming. Tokens are estimates. */
export type BigBlock = {
  kind: OffenderKind
  tokens: number
  /** The tool that produced a result, or the attachment's type. */
  label: string
  filePath: string | null
  toolUseId: string | null
  preview: string
}

export type ToolUse = { id: string; name: string; inputTokens: number; filePath: string | null }

/** One record that is, or once was, part of the conversation the model reads. */
export type Entry = {
  uuid: string
  parent: string | null
  kind: 'user' | 'assistant' | 'attachment' | 'system'
  at: number | null
  where: Location
  isSidechain: boolean
  agentId: string | null
  /** Assistant records: the response they belong to. */
  messageId: string | null
  /** Estimated tokens this record adds to the context; 0 when it is never sent. */
  tokens: number
  category: Category
  /** A prompt the person typed (not a tool result, meta row or compact summary). */
  isPrompt: boolean
  isCompactSummary: boolean
  compaction: Compaction | null
  bigBlocks: BigBlock[]
  toolUses: ToolUse[]
  /** tool_use_id → estimated tokens of its result. */
  toolResults: { toolUseId: string; tokens: number }[]
  stopReason: string | null
  effort: string | null
}

export type Compaction = {
  at: number | null
  trigger: string | null
  /** The engine's own context count just before compacting. */
  preTokens: number | null
  /** The messages kept after compacting (summary and preserved messages), no system prompt or tools. */
  postTokens: number | null
  preserved: string[]
}

/** One request to the API, counted once. */
export type Call = {
  id: string
  model: string
  /** When the response was written (its first record). */
  at: number | null
  /** When the request was sent, when the log says; see `sentAt` in the cache notes. */
  sentAt: number | null
  input: number
  cacheRead: number
  cacheWrite5m: number
  cacheWrite1h: number
  /** Output including thinking, as billed. */
  output: number
  thinking: number
  isSidechain: boolean
  agentId: string | null
  requestRef: string | null
  firstUuid: string
  where: Location
}

export type ToolDef = { name: string; tokens: number }

/** What a request carried besides messages, from `api-request-shape` records (newer logs only). */
export type Shape = { systemTokens: number; tools: ToolDef[] }

export type CostState = {
  /** When the process that wrote it started: its totals cover only requests since then. */
  startedAt: number | null
  totalUsd: number | null
  models: Record<string, { input: number; output: number; thinking: number; cacheRead: number; cacheWrite: number; usd: number | null }>
}

export type SessionLog = {
  entries: Map<string, Entry>
  /** Entry uuids in the order they were read. */
  order: string[]
  calls: Call[]
  /** Newest last; `api-request` id → its shape hash and send time. */
  requests: Map<string, { shapeHash: string | null; at: number | null }>
  shapes: Map<string, Shape>
  costState: CostState | null
  /** Deferred tool names announced, minus the ones removed again. */
  deferredTools: Set<string>
  /** Lines read per source, and records by type, for the report. */
  lines: Record<string, number>
  types: Record<string, number>
  issues: LogIssue[]
}

/** Tokens an image costs. Its size is not in the log; this is the cost of a ~1.1 megapixel image, the most the API keeps. */
export const IMAGE_TOKENS = 1_600
/** Blocks from this many estimated tokens are kept as `bigBlocks`. */
export const BIG_BLOCK_TOKENS = 500
/** At most this many issues are kept; the rest are only counted. */
export const MAX_ISSUES = 200

const SKILL_ATTACHMENTS = new Set(['skill_listing', 'invoked_skills'])
const TOOL_ATTACHMENTS = new Set(['deferred_tools_delta', 'agent_listing_delta'])
const MCP_ATTACHMENTS = new Set(['mcp_instructions_delta'])
const FILE_READ_TOOLS = new Set(['Read', 'NotebookRead'])

type Json = Record<string, unknown>

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function time(v: unknown): number | null {
  const t = typeof v === 'string' ? Date.parse(v) : NaN

  return Number.isNaN(t) ? null : t
}

function preview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > 80 ? `${flat.slice(0, 79)}…` : flat
}

/** Splits text pieces into lines and parses each as JSON. Handles CRLF, a BOM and a last line still being written. */
export function createLineReader(
  onRecord: (value: Json, line: number) => void,
  onIssue: (line: number, kind: IssueKind, detail: string) => void,
) {
  let pending: string[] = []
  let line = 0
  let isFirst = true

  const emit = (raw: string, isLast: boolean) => {
    line++
    let text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (isFirst) {
      text = text.replace(/^﻿/, '')
      isFirst = false
    }
    if (text.trim() === '') {
      return
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      // A last line without its newline is most likely still being written.
      onIssue(line, isLast ? 'partial-line' : 'malformed-json', `${text.length} chars: ${preview(text.slice(0, 60))}`)

      return
    }
    if (!isObject(value)) {
      onIssue(line, 'not-an-object', preview(text.slice(0, 60)))

      return
    }
    onRecord(value, line)
  }

  return {
    push(chunk: string) {
      let start = 0
      for (;;) {
        const nl = chunk.indexOf('\n', start)
        if (nl < 0) {
          if (start < chunk.length) {
            pending.push(chunk.slice(start))
          }
          break
        }
        pending.push(chunk.slice(start, nl))
        const raw = pending.join('')
        pending = []
        emit(raw, false)
        start = nl + 1
      }
    },
    /** Flushes a last line that has no newline yet. Returns the number of lines seen. */
    end(): number {
      if (pending.length > 0) {
        const raw = pending.join('')
        pending = []
        emit(raw, true)
      }

      return line
    },
  }
}

type BlockContext = { toolUses: Map<string, ToolUse>; isPrompt: boolean }

/** Estimated tokens of one content block, noting it when it is big. */
function blockTokens(block: unknown, ctx: BlockContext, big: BigBlock[], uses: ToolUse[], results: Entry['toolResults']): number {
  if (typeof block === 'string') {
    const tokens = countTokens(block)
    if (tokens >= BIG_BLOCK_TOKENS) {
      big.push({ kind: ctx.isPrompt ? 'paste' : 'attachment', tokens, label: 'text', filePath: null, toolUseId: null, preview: preview(block) })
    }

    return tokens
  }
  if (!isObject(block)) {
    return 0
  }
  switch (block.type) {
    case 'text': {
      const text = str(block.text) ?? ''
      const tokens = countTokens(text)
      if (tokens >= BIG_BLOCK_TOKENS) {
        big.push({ kind: ctx.isPrompt ? 'paste' : 'attachment', tokens, label: 'text', filePath: null, toolUseId: null, preview: preview(text) })
      }

      return tokens
    }
    case 'image':
      big.push({ kind: 'image', tokens: IMAGE_TOKENS, label: 'image', filePath: null, toolUseId: null, preview: '' })

      return IMAGE_TOKENS
    case 'thinking':
      return countTokens(str(block.thinking) ?? '')
    case 'redacted_thinking':
      // Encrypted: about one token per four characters of its data.
      return Math.ceil((str(block.data)?.length ?? 0) / 4)
    case 'tool_use': {
      const name = str(block.name) ?? 'unknown'
      const input = isObject(block.input) ? block.input : {}
      const inputTokens = countTokens(name) + countTokens(JSON.stringify(input))
      const use: ToolUse = {
        id: str(block.id) ?? '',
        name,
        inputTokens,
        filePath: str(input.file_path) ?? str(input.notebook_path) ?? str(input.path),
      }
      uses.push(use)
      if (use.id) {
        ctx.toolUses.set(use.id, use)
      }
      if (inputTokens >= BIG_BLOCK_TOKENS) {
        // A Write or Edit carries the file's text in its input.
        big.push({ kind: 'tool-input', tokens: inputTokens, label: name, filePath: use.filePath, toolUseId: use.id || null, preview: '' })
      }

      return inputTokens
    }
    case 'tool_result': {
      const id = str(block.tool_use_id) ?? ''
      const use = ctx.toolUses.get(id)
      const inner: BigBlock[] = []
      const content = block.content
      let tokens = 0
      if (typeof content === 'string') {
        tokens = countTokens(content)
      } else if (Array.isArray(content)) {
        for (const part of content) {
          tokens += blockTokens(part, { ...ctx, isPrompt: false }, inner, uses, results)
        }
      }
      results.push({ toolUseId: id, tokens })
      if (tokens >= BIG_BLOCK_TOKENS) {
        const text = typeof content === 'string' ? content : ''
        big.push({
          kind: use && FILE_READ_TOOLS.has(use.name) ? 'file-read' : 'tool-result',
          tokens,
          label: use?.name ?? 'unknown tool',
          filePath: use?.filePath ?? null,
          toolUseId: id || null,
          preview: preview(text),
        })
      } else {
        // Images inside a small result are still worth naming.
        big.push(...inner.filter((b) => b.kind === 'image'))
      }

      return tokens
    }
    default:
      // tool_reference, server tool blocks and whatever comes next: count their JSON.
      return countTokens(JSON.stringify(block))
  }
}

function attachmentCategory(type: string | null): Category {
  if (type !== null && SKILL_ATTACHMENTS.has(type)) {
    return 'skills'
  }
  if (type !== null && TOOL_ATTACHMENTS.has(type)) {
    return 'systemTools'
  }
  if (type !== null && MCP_ATTACHMENTS.has(type)) {
    return 'mcpTools'
  }

  return 'messages'
}

function nonNegative(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

function shapeOf(shape: unknown): Shape | null {
  if (!isObject(shape)) {
    return null
  }
  let systemTokens = 0
  const system = shape.system
  if (typeof system === 'string') {
    systemTokens = countTokens(system)
  } else if (Array.isArray(system)) {
    for (const part of system) {
      systemTokens += isObject(part) ? countTokens(str(part.text) ?? '') : 0
    }
  }
  const tools: ToolDef[] = []
  if (Array.isArray(shape.tools)) {
    for (const tool of shape.tools) {
      if (isObject(tool)) {
        tools.push({ name: str(tool.name) ?? 'unknown', tokens: countTokens(JSON.stringify(tool)) })
      }
    }
  }

  return { systemTokens, tools }
}

/** An incremental reader over one or more log sources (the main transcript and its subagents' files). */
export function createSessionLogReader() {
  const log: SessionLog = {
    entries: new Map(),
    order: [],
    calls: [],
    requests: new Map(),
    shapes: new Map(),
    costState: null,
    deferredTools: new Set(),
    lines: {},
    types: {},
    issues: [],
  }
  const callsById = new Map<string, Call>()
  const usageKey = new Map<string, string>()
  const toolUses = new Map<string, ToolUse>()
  let dropped = 0

  const issue = (source: string, line: number, kind: IssueKind, detail: string) => {
    if (log.issues.length < MAX_ISSUES) {
      log.issues.push({ source, line, kind, detail })
    } else {
      dropped++
    }
  }

  const record = (source: string, isAgentFile: boolean, r: Json, line: number) => {
    const type = str(r.type) ?? '(none)'
    log.types[type] = (log.types[type] ?? 0) + 1

    if (type === 'api-request') {
      const id = str(r.id)
      if (id) {
        log.requests.set(id, { shapeHash: str(r.shapeHash), at: time(r.timestamp) })
      }

      return
    }
    if (type === 'api-request-shape') {
      const hash = str(r.shapeHash)
      const shape = shapeOf(r.shape)
      if (hash && shape) {
        log.shapes.set(hash, shape)
      }

      return
    }
    if (type === 'cost-state') {
      const models: CostState['models'] = {}
      if (isObject(r.modelUsage)) {
        for (const [model, u] of Object.entries(r.modelUsage)) {
          if (isObject(u)) {
            models[model] = {
              input: nonNegative(u.inputTokens) ?? 0,
              output: nonNegative(u.outputTokens) ?? 0,
              thinking: nonNegative(u.thinkingTokens) ?? 0,
              cacheRead: nonNegative(u.cacheReadInputTokens) ?? 0,
              cacheWrite: nonNegative(u.cacheCreationInputTokens) ?? 0,
              usd: nonNegative(u.costUSD),
            }
          }
        }
      }
      log.costState = { startedAt: nonNegative(r.startTime), totalUsd: nonNegative(r.totalCostUSD), models }

      return
    }
    if (type !== 'user' && type !== 'assistant' && type !== 'attachment' && type !== 'system') {
      return
    }
    const uuid = str(r.uuid)
    if (!uuid) {
      issue(source, line, 'bad-field', `${type} record without uuid`)

      return
    }
    const where: Location = { source, line, uuid }
    const isSidechain = isAgentFile || r.isSidechain === true || typeof r.agentId === 'string'
    const agentId = str(r.agentId) ?? (isAgentFile ? source.replace(/^.*[\\/]/, '').replace(/\.jsonl$/, '') : null)
    const message = isObject(r.message) ? r.message : null
    const messageId = type === 'assistant' ? (str(message?.id) ?? str(r.requestId)) : null

    // An assistant response's later blocks share the first block's message id;
    // they are separate records with their own uuids, so only exact uuid
    // repeats are duplicates.
    if (log.entries.has(uuid)) {
      issue(source, line, 'duplicate-uuid', uuid)

      return
    }

    const isMeta = r.isMeta === true
    const isCompactSummary = r.isCompactSummary === true
    const content = message?.content
    const hasToolResult = Array.isArray(content) && content.some((b) => isObject(b) && b.type === 'tool_result')
    const isPrompt = type === 'user' && !isMeta && !isCompactSummary && !hasToolResult && !isSidechain

    const bigBlocks: BigBlock[] = []
    const uses: ToolUse[] = []
    const results: Entry['toolResults'] = []
    const ctx: BlockContext = { toolUses, isPrompt }
    let tokens = 0
    let category: Category = 'messages'
    let compaction: Compaction | null = null

    if (type === 'user' || type === 'assistant') {
      if (typeof content === 'string') {
        tokens = blockTokens(content, ctx, bigBlocks, uses, results)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          tokens += blockTokens(block, ctx, bigBlocks, uses, results)
        }
      } else if (message !== null) {
        issue(source, line, 'bad-field', `${type} message without content`)
      }
    } else if (type === 'attachment') {
      const attachment = isObject(r.attachment) ? r.attachment : null
      const attachmentType = str(attachment?.type)
      category = attachmentCategory(attachmentType)
      if (Array.isArray(r.rendered)) {
        for (const part of r.rendered) {
          const text = isObject(part) ? (str(part.content) ?? '') : typeof part === 'string' ? part : ''
          tokens += countTokens(text)
        }
      }
      if (tokens >= BIG_BLOCK_TOKENS && category === 'messages') {
        bigBlocks.push({
          kind: attachmentType === 'file' ? 'file-read' : 'attachment',
          tokens,
          label: attachmentType ?? 'attachment',
          filePath: str(attachment?.filename) ?? str(attachment?.path) ?? null,
          toolUseId: null,
          preview: '',
        })
      }
      if (attachmentType === 'deferred_tools_delta' && !isSidechain) {
        for (const name of Array.isArray(attachment?.addedNames) ? attachment.addedNames : []) {
          if (typeof name === 'string') {
            log.deferredTools.add(name)
          }
        }
        for (const name of Array.isArray(attachment?.removedNames) ? attachment.removedNames : []) {
          if (typeof name === 'string') {
            log.deferredTools.delete(name)
          }
        }
      }
    } else if (r.subtype === 'compact_boundary') {
      const meta = isObject(r.compactMetadata) ? r.compactMetadata : {}
      const kept = isObject(meta.preservedMessages) ? meta.preservedMessages.uuids : undefined
      compaction = {
        at: time(r.timestamp),
        trigger: str(meta.trigger),
        preTokens: nonNegative(meta.preTokens),
        postTokens: nonNegative(meta.postTokens),
        preserved: Array.isArray(kept) ? kept.filter((u): u is string => typeof u === 'string') : [],
      }
    }

    const entry: Entry = {
      uuid,
      parent: str(r.parentUuid),
      kind: type,
      at: time(r.timestamp),
      where,
      isSidechain,
      agentId,
      messageId,
      tokens,
      category,
      isPrompt,
      isCompactSummary,
      compaction,
      bigBlocks,
      toolUses: uses,
      toolResults: results,
      stopReason: str(message?.stop_reason),
      effort: str(r.effort),
    }
    log.entries.set(uuid, entry)
    log.order.push(uuid)

    const usage = isObject(message?.usage) ? message.usage : null
    if (type !== 'assistant' || usage === null || messageId === null || message?.model === '<synthetic>') {
      return
    }
    const fields = [usage.input_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens, usage.output_tokens]
    const key = JSON.stringify(fields)
    const seen = callsById.get(messageId)
    if (seen) {
      if (usageKey.get(messageId) !== key) {
        issue(source, line, 'usage-mismatch', `${messageId}: blocks of one response report different usage; the first is kept`)
      }

      return
    }
    if (fields.some((f) => f !== undefined && nonNegative(f) === null)) {
      issue(source, line, 'bad-field', `${messageId}: usage holds a value that is not a token count`)
    }
    const split = isObject(usage.cache_creation) ? usage.cache_creation : null
    const write = nonNegative(usage.cache_creation_input_tokens) ?? 0
    const write1h = nonNegative(split?.ephemeral_1h_input_tokens) ?? 0
    // Without the split, a write is taken as the default 5-minute kind.
    const write5m = split ? (nonNegative(split.ephemeral_5m_input_tokens) ?? 0) : write
    const details = isObject(usage.output_tokens_details) ? usage.output_tokens_details : null
    const output = nonNegative(usage.output_tokens) ?? 0
    const requestRef = str(r.requestRef)
    const call: Call = {
      id: messageId,
      model: str(message?.model) ?? 'unknown',
      at: entry.at,
      sentAt: null,
      input: nonNegative(usage.input_tokens) ?? 0,
      cacheRead: nonNegative(usage.cache_read_input_tokens) ?? 0,
      cacheWrite5m: write5m,
      cacheWrite1h: write1h,
      output,
      thinking: Math.min(output, nonNegative(details?.thinking_tokens) ?? 0),
      isSidechain,
      agentId,
      requestRef,
      firstUuid: uuid,
      where,
    }
    if (write5m + write1h !== write) {
      issue(source, line, 'bad-field', `${messageId}: cache write split ${write5m}+${write1h} does not add up to ${write}`)
    }
    callsById.set(messageId, call)
    usageKey.set(messageId, key)
    log.calls.push(call)
  }

  return {
    /** Starts reading one source; returns its own push and end. */
    source(name: string) {
      const isAgentFile = /(^|[\\/])agent-[^\\/]*\.jsonl$/.test(name)
      const lines = createLineReader(
        (value, line) => record(name, isAgentFile, value, line),
        (line, kind, detail) => issue(name, line, kind, detail),
      )

      return {
        push: (chunk: string) => lines.push(chunk),
        end: () => {
          log.lines[name] = lines.end()
        },
      }
    },
    /** The log read so far. Call after every source has ended. */
    result(): SessionLog {
      for (const call of log.calls) {
        call.sentAt = sentAt(log, call)
      }
      if (dropped > 0) {
        log.issues.push({ source: '', line: 0, kind: 'bad-field', detail: `${dropped} more issues not listed` })
      }

      return log
    },
  }
}

/**
 * When a request was sent. The cache entry's lifetime starts when the
 * request is processed, so this, not the response time, is when the cache
 * was last touched. Newer logs say it (`api-request.timestamp`); otherwise
 * the record the request answers (the response's parent) was written just
 * before sending, and its time is used; failing that, the response's own
 * time, which runs late by the length of the response.
 */
function sentAt(log: SessionLog, call: Call): number | null {
  const request = call.requestRef ? log.requests.get(call.requestRef) : undefined
  if (request?.at != null) {
    return request.at
  }
  const first = log.entries.get(call.firstUuid)
  const parent = first?.parent ? log.entries.get(first.parent) : undefined
  if (parent?.at != null && call.at !== null && parent.at <= call.at) {
    return parent.at
  }

  return call.at
}

/** Parses whole texts at once: `{ name: text }`. For tests and small logs. */
export function parseSessionLog(sources: Record<string, string>): SessionLog {
  const reader = createSessionLogReader()
  for (const [name, text] of Object.entries(sources)) {
    const s = reader.source(name)
    s.push(text)
    s.end()
  }

  return reader.result()
}
