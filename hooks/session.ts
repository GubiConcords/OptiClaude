import type { EngineInterface } from 'claude-code'

import type { Effort, SessionSnapshot, TurnOutput } from '../types'
import { type CacheReport, trackCache } from './cacheTracking'
import { type CompactionEstimate, type ContextAnalysis, analyzeContext, estimateCompaction, mainCalls } from './contextBreakdown'
import { type LogIssue, type SessionLog, createSessionLogReader } from './logParser'
import { type PriceTable, PRICES } from './pricing'
import { type ToolAudit, auditTools } from './toolAudit'

/** The seam the estimators read from: one call, one snapshot. */
export type SnapshotProvider = () => Promise<SessionSnapshot>

/** Everything the log says beyond the snapshot, and how far to trust it. */
export type SessionReport = {
  context: ContextAnalysis
  cache: CacheReport
  tools: ToolAudit
  compaction: CompactionEstimate
  /** Tokens per model from the log, subagents included. */
  models: Record<string, { requests: number; input: number; output: number; thinking: number; cacheRead: number; cacheWrite: number }>
  /** The engine's own running totals when the log carries them (`cost-state`), to check ours against. */
  engineTotals: SessionLog['costState']
  issues: LogIssue[]
  /** Each figure that rests on something the log does not say. */
  assumptions: string[]
}

export type SnapshotOptions = {
  now: number
  /** The context window when the caller knows it (the panel does); else it is inferred. */
  contextWindow?: number
  prices?: PriceTable
}

const EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max'])
const WINDOW = 200_000
const LARGE_WINDOW = 1_000_000

/**
 * Output per finished turn of the main loop. A turn runs from a prompt the
 * person typed to the next one; it is finished once the next one exists or
 * its last response ended with `end_turn`. Requests before the first prompt
 * (a resumed log) make a turn of their own.
 */
export function turnOutputs(log: SessionLog): { turns: TurnOutput[]; requestsPerTurn: number } {
  const calls = mainCalls(log)
  const stop = new Map<string, string>()
  type Turn = TurnOutput & { requests: number; last: string | null }
  const all: Turn[] = []
  let current: Turn | null = null
  const counted = new Set<string>()
  for (const uuid of log.order) {
    const e = log.entries.get(uuid)
    if (!e || e.isSidechain) {
      continue
    }
    if (e.isPrompt) {
      current = { output: 0, thinking: 0, requests: 0, last: null }
      all.push(current)
      continue
    }
    if (e.kind !== 'assistant' || !e.messageId) {
      continue
    }
    if (e.stopReason) {
      stop.set(e.messageId, e.stopReason)
    }
    const call = calls.get(e.messageId)
    if (!call || counted.has(call.id)) {
      continue
    }
    counted.add(call.id)
    if (!current) {
      current = { output: 0, thinking: 0, requests: 0, last: null }
      all.push(current)
    }
    current.output += call.output - call.thinking
    current.thinking += call.thinking
    current.requests++
    current.last = call.id
  }
  const finished = all.filter((t, i) => t.requests > 0 && (i < all.length - 1 || (t.last !== null && stop.get(t.last) === 'end_turn')))
  const requests = finished.reduce((a, t) => a + t.requests, 0)

  return {
    turns: finished.map(({ output, thinking }) => ({ output, thinking })),
    requestsPerTurn: finished.length > 0 ? requests / finished.length : 1,
  }
}

/** The snapshot the estimators read, and the report behind it. */
export function snapshotFromLog(log: SessionLog, options: SnapshotOptions): { snapshot: SessionSnapshot; report: SessionReport } {
  const prices = options.prices ?? PRICES
  const assumptions: string[] = []
  const context = analyzeContext(log)
  const cache = trackCache(log, prices)
  const tools = auditTools(log, context)
  const { turns, requestsPerTurn } = turnOutputs(log)

  const main = [...mainCalls(log).values()]
  const last = main.at(-1)
  let effort: Effort | null = null
  for (let i = log.order.length - 1; i >= 0; i--) {
    const e = log.entries.get(log.order[i] as string)
    if (e && !e.isSidechain && e.kind === 'assistant' && e.effort !== null) {
      effort = EFFORTS.has(e.effort) ? (e.effort as Effort) : null
      break
    }
  }
  if (effort === null) {
    assumptions.push('effort: the log does not say; output is not scaled by effort')
  }

  let contextWindow = options.contextWindow
  if (contextWindow === undefined) {
    // A request or compaction past 200k can only happen in a 1M window.
    const biggest = Math.max(
      context.contextTokens,
      ...main.map((c) => c.input + c.cacheRead + c.cacheWrite5m + c.cacheWrite1h),
      ...[...log.entries.values()].map((e) => e.compaction?.preTokens ?? 0),
    )
    contextWindow = biggest > WINDOW ? LARGE_WINDOW : WINDOW
    assumptions.push(`context window: not in the log, taken as ${contextWindow.toLocaleString('en-US')} from the largest request`)
  }
  if (cache.ttlFrom === 'default') {
    assumptions.push('cache ttl: no cache write in the log, taken as the 5-minute default')
  }
  if (context.basis === 'transcript') {
    assumptions.push('context: this log does not record the system prompt or tool definitions; their share is in "other"')
  }
  if (context.basis === 'estimate') {
    assumptions.push('context: no request yet, so the total is a local estimate without system prompt and tools')
  }
  assumptions.push(...context.warnings)

  const models: SessionReport['models'] = {}
  for (const call of log.calls) {
    const m = (models[call.model] ??= { requests: 0, input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0 })
    m.requests++
    m.input += call.input
    m.output += call.output
    m.thinking += call.thinking
    m.cacheRead += call.cacheRead
    m.cacheWrite += call.cacheWrite5m + call.cacheWrite1h
  }

  const snapshot: SessionSnapshot = {
    now: options.now,
    model: last?.model ?? 'unknown',
    effort,
    contextTokens: context.contextTokens,
    contextWindow,
    breakdown: context.breakdown,
    cache: { lastWriteAt: cache.lastWriteAt, lastReadAt: cache.lastReadAt, ttlMs: cache.ttlMs },
    turns,
  }

  return {
    snapshot,
    report: {
      context,
      cache,
      tools,
      compaction: estimateCompaction(log, context, snapshot.model, requestsPerTurn, cache.ttlMs, prices),
      models,
      engineTotals: log.costState,
      issues: log.issues,
      assumptions,
    },
  }
}

// Reading the files. `$.fs.read` takes files up to 4 MiB in one piece; a
// larger log is streamed through a child process instead, piece by piece.

/** The part of `$` the reader uses; the engine's `$` is one. */
export type Host = {
  fs: Pick<EngineInterface['fs'], 'read' | 'stat' | 'list' | 'exists'>
  process: Pick<EngineInterface['process'], 'spawn'>
  session: Pick<EngineInterface['session'], 'id' | 'root'>
  clock: Pick<EngineInterface['clock'], 'now'>
  env?: Pick<EngineInterface['env'], 'get'>
}

export const FS_READ_LIMIT = 4 * 1024 * 1024

/** Where Claude Code keeps a project's transcripts: every character but letters and digits becomes `-`. */
export function projectSlug(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, '-')
}

function join(...parts: string[]): string {
  const sep = parts[0]?.includes('\\') ? '\\' : '/'

  return parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, ''))).join(sep)
}

async function configDir($: Host): Promise<string | null> {
  // Not every host gives a plugin the environment (the test kit does not).
  if (typeof $.env?.get !== 'function') {
    return null
  }
  const own = await $.env.get('CLAUDE_CONFIG_DIR')
  if (own) {
    return own
  }
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))

  return home ? join(home, '.claude') : null
}

export type Locate = {
  /** The transcript's path, as the engine gives it to hook events (`transcript_path`). */
  transcriptPath?: string
  /** Claude Code's configuration folder; else `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  configDir?: string
}

function subagentsOf($: Host, transcript: string): Promise<string[]> {
  const agents = join(transcript.replace(/\.jsonl$/, ''), 'subagents')

  return $.fs
    .list(agents)
    .then((entries) => entries.filter((e) => e.kind === 'file' && e.name.endsWith('.jsonl')).map((e) => join(agents, e.name)))
    .catch(() => [])
}

/** The session's transcript and its subagents' transcripts, main first; empty when not found. */
export async function findTranscripts($: Host, locate: Locate = {}): Promise<string[]> {
  if (locate.transcriptPath && (await $.fs.exists(locate.transcriptPath))) {
    return [locate.transcriptPath, ...(await subagentsOf($, locate.transcriptPath))]
  }
  const config = locate.configDir ?? (await configDir($))
  if (!config) {
    return []
  }
  const id = await $.session.id()
  const projects = join(config, 'projects')
  let dir = join(projects, projectSlug(await $.session.root()))
  if (!(await $.fs.exists(join(dir, `${id}.jsonl`)))) {
    // The folder name rule may change: look in every project folder.
    const found = await $.fs.list(projects).catch(() => [])
    const match = await Promise.all(
      found.filter((d) => d.kind === 'dir').map(async (d) => ((await $.fs.exists(join(projects, d.name, `${id}.jsonl`))) ? d.name : null)),
    )
    const name = match.find((m) => m !== null)
    if (!name) {
      return []
    }
    dir = join(projects, name)
  }
  const main = join(dir, `${id}.jsonl`)

  return [main, ...(await subagentsOf($, main))]
}

async function streamInto($: Host, path: string, push: (chunk: string) => void): Promise<void> {
  const size = (await $.fs.stat(path)).size
  if (size <= FS_READ_LIMIT) {
    push(await $.fs.read(path))

    return
  }
  const isWindows = /^[A-Za-z]:|\\/.test(path)
  const argv = isWindows ? ['cmd', '/d', '/c', 'type', path] : ['cat', '--', path]
  const child = $.process.spawn({ argv })[Symbol.asyncIterator]()
  let stderr = ''
  for (;;) {
    const piece = await child.next()
    if (piece.done) {
      // A reader that failed part way left a partial log: say so rather than parse it as whole.
      if (piece.value.code !== 0) {
        throw new Error(`${argv[0]} exited ${piece.value.code ?? piece.value.signal}: ${stderr.slice(0, 200)}`)
      }

      return
    }
    if (piece.value.stream === 'stdout') {
      push(piece.value.text)
    } else {
      stderr += piece.value.text
    }
  }
}

/** Reads the transcripts into one log; a file that cannot be read becomes an issue, never a throw. */
export async function readSessionLog($: Host, paths: string[]): Promise<SessionLog> {
  const reader = createSessionLogReader()
  const failed: LogIssue[] = []
  for (const path of paths) {
    const source = reader.source(path)
    try {
      await streamInto($, path, (chunk) => source.push(chunk))
    } catch (error) {
      failed.push({ source: path, line: 0, kind: 'bad-field', detail: `could not read: ${String(error)}` })
    }
    source.end()
  }
  const log = reader.result()
  log.issues.push(...failed)

  return log
}

export type ProviderOptions = Locate & {
  /** The context window when the caller knows it (the panel reads it from `$.session.usage()`). */
  contextWindow?: () => Promise<number | undefined>
}

/**
 * The real provider: reads this session's logs from disk, re-reading only
 * when a file's size or time changed.
 */
export function logProvider($: Host, options: ProviderOptions = {}) {
  let key = ''
  let log: SessionLog | null = null

  const load = async (): Promise<SessionLog | null> => {
    const paths = await findTranscripts($, options)
    if (paths.length === 0) {
      return null
    }
    const stats = await Promise.all(paths.map((p) => $.fs.stat(p).then((s) => `${p}:${s.size}:${s.mtimeMs}`).catch(() => p)))
    const now = stats.join('|')
    if (now !== key || log === null) {
      log = await readSessionLog($, paths)
      key = now
    }

    return log
  }

  return {
    /** Snapshot and report; null when the transcript is not found. */
    async read(): Promise<{ snapshot: SessionSnapshot; report: SessionReport } | null> {
      const current = await load()
      if (!current) {
        return null
      }

      return snapshotFromLog(current, { now: await $.clock.now(), contextWindow: await options.contextWindow?.() })
    },
  }
}

const NOW = Date.parse('2026-10-26T12:00:00Z')

/** Realistic fake data with a warm cache, for tests; override any field to build a case. */
export function stubSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    now: NOW,
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    contextTokens: 62_000,
    contextWindow: 200_000,
    breakdown: { messages: 38_000, systemTools: 11_000, mcpTools: 6_000, skills: 2_000, systemPrompt: 5_000, other: 0 },
    cache: { lastWriteAt: NOW - 3 * 60_000, lastReadAt: NOW - 90_000, ttlMs: 5 * 60_000 },
    turns: [
      { output: 800, thinking: 1_500 },
      { output: 1_400, thinking: 3_000 },
      { output: 600, thinking: 0 },
      { output: 2_200, thinking: 5_500 },
    ],
    ...overrides,
  }
}

/** A provider that always answers with the stub, for tests. */
export const stubProvider: SnapshotProvider = async () => stubSnapshot()
