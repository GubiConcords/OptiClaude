import type { ContextBreakdown } from '../types'
import type { BigBlock, Call, Category, Entry, Location, SessionLog, Shape } from './logParser'
import { type PriceTable, PRICES, ratesFor, usd, writeRate } from './pricing'

// What fills the context now, read from the log. Real numbers anchor it; the
// local token counter only fills the gaps between them.
//
// - Total: the size of the main loop's last request (input + cache read +
//   cache write, the API's own usage), plus that response's output, plus
//   local estimates of what came after it (tool results, attachments, the
//   next prompt). The engine counts the same way: a compaction's `preTokens`
//   equals the last request plus its output.
// - System prompt and tool definitions: the first request on the chain is
//   almost all of them. Their size is that request minus a local estimate of
//   the few messages before it, carried forward unchanged. Newer logs record
//   what each request carried (`api-request-shape`): the size is then split
//   into system prompt, built-in and MCP tools in the recorded proportions,
//   and follows a change in the tool set. Older logs record none of it: the
//   size goes to `other`, never guessed into a category.
// - Messages: the last request minus the system prompt and tools, split
//   between messages, skill listings, tool listings and MCP instructions in
//   proportion to their estimates (a response weighs its output tokens).
//
// Responses are never summed to get the messages: the API may clear old
// thinking or tool results from the context (`context_management`), and on
// real logs the sum of outputs can exceed the last request.

export type Basis =
  /** Anchored on a real request; system prompt and tools split by the recorded request shape. */
  | 'request'
  /** Anchored on a real request; system prompt and tools unknown, in `other`. */
  | 'transcript'
  /** Compacted since the last request: anchored on the compaction's own count. */
  | 'compaction'
  /** No request yet: everything estimated, system prompt and tools not counted. */
  | 'estimate'

export type Offender = BigBlock & { where: Location; at: number | null }

export type ContextAnalysis = {
  basis: Basis
  contextTokens: number
  breakdown: ContextBreakdown
  /** Real tokens per estimated token of the tool definitions and system prompt; 1 when nothing calibrates it. */
  scale: number
  /** The request the numbers are anchored on. */
  anchor: { callId: string; realTokens: number } | null
  /** The largest blocks in the context now, biggest first (local estimates). */
  offenders: Offender[]
  /** Tool definitions of the anchoring request, scaled; null when the log does not record them. */
  toolDefs: { name: string; tokens: number }[] | null
  chain: Entry[]
  warnings: string[]
}

/** A tool-definition scale outside this range means the shape estimate is off: say so. */
export const SCALE_RANGE = [0.6, 1.6] as const
export const TOP_OFFENDERS = 10

export function isMcpTool(name: string): boolean {
  return name.startsWith('mcp__')
}

/** The calls the main loop made, by response id. */
export function mainCalls(log: SessionLog): Map<string, Call> {
  const out = new Map<string, Call>()
  for (const call of log.calls) {
    if (!call.isSidechain) {
      out.set(call.id, call)
    }
  }

  return out
}

/**
 * The records in the context, oldest first: walk back from `fromUuid` (by
 * default the newest main-loop record) through `parentUuid`. A record left on
 * an abandoned branch (a rewind, an edited prompt) is not on the walk. At a
 * compaction boundary the walk stops; the messages the compaction preserved
 * (`compactMetadata.preservedMessages.uuids`) follow the boundary.
 */
export function contextChain(log: SessionLog, fromUuid?: string, warnings: string[] = []): Entry[] {
  let leaf: Entry | undefined
  if (fromUuid !== undefined) {
    leaf = log.entries.get(fromUuid)
  } else {
    for (let i = log.order.length - 1; i >= 0 && !leaf; i--) {
      const e = log.entries.get(log.order[i] as string)
      if (e && !e.isSidechain) {
        leaf = e
      }
    }
  }
  const chain: Entry[] = []
  const seen = new Set<string>()
  let at = leaf
  while (at && !seen.has(at.uuid)) {
    seen.add(at.uuid)
    chain.push(at)
    if (at.compaction) {
      const kept = at.compaction.preserved
        .map((uuid) => log.entries.get(uuid))
        .filter((e): e is Entry => e !== undefined && !seen.has(e.uuid))
      // Reversed with the rest below: boundary first, then the kept messages.
      chain.splice(chain.length - 1, 0, ...kept.reverse())
      break
    }
    if (at.parent === null) {
      break
    }
    const parent = log.entries.get(at.parent)
    if (!parent) {
      // Resumed or forked sessions point into another file.
      warnings.push(`the conversation continues in a record not in this log (${at.parent}); older messages are not counted`)
      break
    }
    at = parent
  }

  return chain.reverse()
}

function promptOf(call: Call): number {
  return call.input + call.cacheRead + call.cacheWrite5m + call.cacheWrite1h
}

function shapeFor(log: SessionLog, call: Call): Shape | null {
  const hash = call.requestRef ? log.requests.get(call.requestRef)?.shapeHash : null

  return hash ? (log.shapes.get(hash) ?? null) : null
}

function shapeParts(shape: Shape) {
  let builtin = 0
  let mcp = 0
  for (const tool of shape.tools) {
    if (isMcpTool(tool.name)) {
      mcp += tool.tokens
    } else {
      builtin += tool.tokens
    }
  }

  return { systemPrompt: shape.systemTokens, systemTools: builtin, mcpTools: mcp, total: shape.systemTokens + builtin + mcp }
}

/** The response an entry belongs to, when it is a main-loop request. */
function callOf(e: Entry, calls: Map<string, Call>): Call | undefined {
  return e.kind === 'assistant' && e.messageId ? calls.get(e.messageId) : undefined
}

/** Entries a compaction's `postTokens` already counts: its boundary, summary and preserved messages. */
function coveredByCompaction(chain: Entry[]): { post: number; covered: Set<Entry> } {
  const boundary = chain[0]?.compaction ? chain[0] : undefined
  const covered = new Set<Entry>()
  if (!boundary?.compaction) {
    return { post: 0, covered }
  }
  const kept = new Set(boundary.compaction.preserved)
  for (const e of chain) {
    if (e === boundary || e.isCompactSummary || kept.has(e.uuid)) {
      covered.add(e)
    }
  }

  return { post: boundary.compaction.postTokens ?? 0, covered }
}

type Fixed = { total: number; systemPrompt: number; systemTools: number; mcpTools: number; other: number; scale: number; toolDefs: { name: string; tokens: number }[] | null }

/**
 * System prompt and tool definitions at `anchor`, measured on the first
 * request of `chain`: that request minus the messages before it.
 */
function fixedPart(log: SessionLog, chain: Entry[], calls: Map<string, Call>, anchor: Call, warnings: string[]): Fixed | null {
  const { post, covered } = coveredByCompaction(chain)
  // A preserved response is older than the compaction: its request measured the old context.
  let firstIdx = chain.findIndex((e) => !covered.has(e) && callOf(e, calls) !== undefined)
  // A chain that does not reach the conversation's start (a resumed session
  // whose start is in another file) has no first request to measure: measure
  // on the anchor, against estimates of every message before it. So too when
  // the chain holds no request of its own (`anchor` comes after it).
  const isComplete = chain[0]?.parent === null || chain[0]?.compaction != null
  if (!isComplete) {
    warnings.push('the start of the conversation is not in this log: system prompt and tools are measured against estimated messages')
  }
  let first = firstIdx < 0 ? undefined : callOf(chain[firstIdx] as Entry, calls)
  if (!isComplete || !first) {
    first = anchor
    firstIdx = chain.findIndex((e) => !covered.has(e) && e.messageId === anchor.id)
    if (firstIdx < 0) {
      firstIdx = chain.length
    }
  }
  const before = post + sum(weigh(chain.slice(0, firstIdx), calls, covered))
  let total = promptOf(first) - before
  if (total <= 0) {
    warnings.push('the first request is smaller than the local estimate of its messages; system prompt and tools are not counted')
    total = 0
  }

  const firstShape = shapeFor(log, first)
  const anchorShape = shapeFor(log, anchor) ?? firstShape
  if (!firstShape || !anchorShape) {
    return { total, systemPrompt: 0, systemTools: 0, mcpTools: 0, other: total, scale: 1, toolDefs: null }
  }
  const measured = shapeParts(firstShape)
  const now = shapeParts(anchorShape)
  // Measured against a whole history of estimates the scale means little:
  // the recorded shape, uncalibrated, is closer (×1.0 to ×1.3 on real logs).
  let scale = !isComplete ? 1 : measured.total > 0 && total > 0 ? total / measured.total : 1
  if (scale < SCALE_RANGE[0] || scale > SCALE_RANGE[1]) {
    warnings.push(`tool and system prompt estimate is off by ×${scale.toFixed(2)} against the first request; their split is less reliable`)
  }
  if (!Number.isFinite(scale) || scale <= 0) {
    scale = 1
  }

  return {
    total: now.total * scale,
    systemPrompt: now.systemPrompt * scale,
    systemTools: now.systemTools * scale,
    mcpTools: now.mcpTools * scale,
    other: 0,
    scale,
    toolDefs: anchorShape.tools.map((t) => ({ name: t.name, tokens: Math.round(t.tokens * scale) })),
  }
}

type Weights = Record<Category, number>

function weigh(entries: Entry[], calls: Map<string, Call>, skip: Set<Entry> = new Set()): Weights {
  const w: Weights = { messages: 0, systemTools: 0, mcpTools: 0, skills: 0 }
  const counted = new Set<string>()
  for (const e of entries) {
    if (skip.has(e)) {
      continue
    }
    const call = callOf(e, calls)
    if (call) {
      if (!counted.has(call.id)) {
        counted.add(call.id)
        w.messages += call.output
      }
    } else {
      w[e.category] += e.tokens
    }
  }

  return w
}

function sum(w: Weights): number {
  return w.messages + w.systemTools + w.mcpTools + w.skills
}

/** Spreads `total` over the categories in proportion to `w`. */
function spread(total: number, w: Weights): Weights {
  const s = sum(w)
  if (s <= 0) {
    return { messages: total, systemTools: 0, mcpTools: 0, skills: 0 }
  }

  return {
    messages: (total * w.messages) / s,
    systemTools: (total * w.systemTools) / s,
    mcpTools: (total * w.mcpTools) / s,
    skills: (total * w.skills) / s,
  }
}

function build(fixed: Fixed | null, messages: Weights, contextTokens: number): ContextBreakdown {
  const out = {
    messages: Math.round(messages.messages),
    systemTools: Math.round((fixed?.systemTools ?? 0) + messages.systemTools),
    mcpTools: Math.round((fixed?.mcpTools ?? 0) + messages.mcpTools),
    skills: Math.round(messages.skills),
    systemPrompt: Math.round(fixed?.systemPrompt ?? 0),
  }
  const named = out.messages + out.systemTools + out.mcpTools + out.skills + out.systemPrompt
  let other = contextTokens - named
  // Rounding can leave a token or two below zero: fold it into messages.
  if (other < 0) {
    out.messages = Math.max(0, out.messages + other)
    other = 0
  }

  return { ...out, other }
}

function offenders(chain: Entry[], skip: Set<Entry> = new Set()): Offender[] {
  const out: Offender[] = []
  for (const e of chain) {
    if (!skip.has(e)) {
      for (const b of e.bigBlocks) {
        out.push({ ...b, where: e.where, at: e.at })
      }
    }
  }

  return out.sort((a, b) => b.tokens - a.tokens).slice(0, TOP_OFFENDERS)
}

/** The context now: total, categories and the biggest blocks. */
export function analyzeContext(log: SessionLog): ContextAnalysis {
  const warnings: string[] = []
  const chain = contextChain(log, undefined, warnings)
  const calls = mainCalls(log)

  // The newest request on the chain anchors the count; never one a
  // compaction preserved, which measured the context before it.
  const { covered: compacted } = coveredByCompaction(chain)
  let anchor: Call | undefined
  for (let i = chain.length - 1; i >= 0 && !anchor; i--) {
    const e = chain[i] as Entry
    anchor = compacted.has(e) ? undefined : callOf(e, calls)
  }

  if (anchor) {
    const a = anchor
    const anchorIdx = chain.findIndex((e) => !compacted.has(e) && e.messageId === a.id)
    const fixed = fixedPart(log, chain, calls, a, warnings) as Fixed
    const real = promptOf(a)
    // Records after the anchor's request: its own response, exact, then the rest estimated.
    const after = weigh(chain.slice(anchorIdx), calls)
    const contextTokens = Math.round(real + sum(after))
    let inMessages = real - fixed.total
    if (inMessages < 0) {
      warnings.push('system prompt and tools measure larger than the last request; messages counted as 0')
      inMessages = 0
    }
    // A compaction's summary and kept messages weigh their `postTokens`.
    const { post, covered } = coveredByCompaction(chain)
    const w = weigh(chain.slice(0, anchorIdx), calls, covered)
    w.messages += post
    const before = spread(inMessages, w)
    const messages: Weights = {
      messages: before.messages + after.messages,
      systemTools: before.systemTools + after.systemTools,
      mcpTools: before.mcpTools + after.mcpTools,
      skills: before.skills + after.skills,
    }

    return {
      basis: fixed.toolDefs ? 'request' : 'transcript',
      contextTokens,
      breakdown: build(fixed, messages, contextTokens),
      scale: fixed.scale,
      anchor: { callId: a.id, realTokens: real },
      offenders: offenders(chain),
      toolDefs: fixed.toolDefs,
      chain,
      warnings,
    }
  }

  // Compacted since the last request: the compaction's `postTokens` counts the
  // summary and the preserved messages, not the system prompt or tools (the
  // next request shows them coming back from the cache). Those are carried
  // over from the requests before the compaction.
  const boundary = chain[0]?.compaction ? chain[0] : undefined
  const post = boundary?.compaction?.postTokens ?? null
  if (boundary && post !== null) {
    const last = [...calls.values()].filter((c) => (c.at ?? 0) <= (boundary.at ?? Infinity)).at(-1)
    let fixed: Fixed | null = null
    if (last) {
      const parent = log.entries.get(last.firstUuid)?.parent
      fixed = fixedPart(log, parent ? contextChain(log, parent) : [], calls, last, warnings)
    }
    if (!fixed) {
      warnings.push('no request before the compaction: system prompt and tools are not counted')
    }
    const { covered } = coveredByCompaction(chain)
    const after = weigh(chain, calls, covered)
    const contextTokens = Math.round(post + (fixed?.total ?? 0) + sum(after))

    return {
      basis: 'compaction',
      contextTokens,
      breakdown: build(fixed, { ...after, messages: post + after.messages }, contextTokens),
      scale: fixed?.scale ?? 1,
      anchor: null,
      offenders: offenders(chain, covered),
      toolDefs: fixed?.toolDefs ?? null,
      chain,
      warnings,
    }
  }

  warnings.push('no request in the log yet: the context is estimated, system prompt and tools are not counted')
  const w = weigh(chain, calls)
  const contextTokens = Math.round(sum(w))

  return {
    basis: 'estimate',
    contextTokens,
    breakdown: build(null, w, contextTokens),
    scale: 1,
    anchor: null,
    offenders: offenders(chain),
    toolDefs: null,
    chain,
    warnings,
  }
}

/**
 * The tokens a compaction leaves as messages. The default is the mean
 * `postTokens` of the six compactions in the author's own logs (12,962 to
 * 18,845, mean ≈ 16,200); a session's own past compactions replace it.
 */
export const DEFAULT_SUMMARY_TOKENS = 16_000

export type CompactionEstimate = {
  /** Message tokens now, and what a compaction would likely leave. */
  messagesTokens: number
  summaryTokens: number
  /** Where `summaryTokens` comes from. */
  summaryFrom: 'this session' | 'default'
  /** Fewer tokens re-read by every later request. */
  savesTokens: number
  /** That saving per request and per turn, warm cache; null without prices. */
  savesUsdPerRequest: number | null
  savesUsdPerTurn: number | null
  /** Requests per finished turn in this session, at least 1. */
  requestsPerTurn: number
  /**
   * What compacting costs once: reading the whole context and writing the
   * summary, then writing the new context to the cache. Null without prices.
   */
  oneTimeUsd: number | null
}

/** "Compaction would save ~X tokens / ~$Y per message." */
export function estimateCompaction(
  log: SessionLog,
  context: ContextAnalysis,
  model: string,
  requestsPerTurn: number,
  ttlMs: number,
  prices: PriceTable = PRICES,
): CompactionEstimate {
  const own = [...log.entries.values()]
    .map((e) => e.compaction?.postTokens)
    .filter((n): n is number => typeof n === 'number')
  const summaryTokens = own.length > 0 ? own.reduce((a, b) => a + b, 0) / own.length : DEFAULT_SUMMARY_TOKENS
  // Messages, plus the listings that ride in them and come back after a compaction anyway.
  const messagesTokens = context.breakdown.messages
  const savesTokens = Math.max(0, Math.round(messagesTokens - summaryTokens))
  const rates = ratesFor(model, prices)
  const perRequest = rates ? usd(savesTokens, rates.cacheRead) : null
  const kept = Math.min(messagesTokens, summaryTokens)

  return {
    messagesTokens,
    summaryTokens: Math.round(summaryTokens),
    summaryFrom: own.length > 0 ? 'this session' : 'default',
    savesTokens,
    savesUsdPerRequest: perRequest,
    savesUsdPerTurn: perRequest === null ? null : perRequest * Math.max(1, requestsPerTurn),
    requestsPerTurn: Math.max(1, requestsPerTurn),
    oneTimeUsd: rates
      ? usd(context.contextTokens, rates.cacheRead) + usd(kept, rates.output) + usd(kept, writeRate(rates, ttlMs))
      : null,
  }
}
