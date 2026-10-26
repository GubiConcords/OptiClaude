import type { Call, SessionLog } from './logParser'
import { type PriceTable, PRICES, ratesFor, usd } from './pricing'

// Prompt-cache activity per request, read from the API's own usage figures.
//
// Assumptions about cache semantics:
// - A cache entry lives `ttl` after it was last used, and a read is a use: a
//   hit renews the entry for another full `ttl` at no write cost. So the
//   cache stays warm until max(last write, last read) + ttl.
// - The ttl is the one the request asked for, read from
//   `usage.cache_creation` (`ephemeral_5m_input_tokens` /
//   `ephemeral_1h_input_tokens`). A request that only read keeps the ttl of
//   the last write. A request that wrote both kinds counts as 5 minutes: after
//   that, part of the prefix is gone and the next request rewrites it.
// - With no write in the log at all the ttl is the API's default, 5 minutes.
// - The clock starts when the request was sent (see `sentAt` in logParser),
//   not when the response finished.
// - Each subagent has its own prefix, so its cache is tracked apart and never
//   warms or cools the main loop's.
// - Hit rate is cache read / (uncached input + cache read + cache write): the
//   share of the prompt served from the cache.
// - Saved: each cache-read token would otherwise have cost the input rate.
//   Writing to the cache costs more than plain input; that premium is
//   reported and subtracted for the net figure.

export const DEFAULT_TTL_MS = 5 * 60_000
export const HOUR_TTL_MS = 60 * 60_000

export type CacheRequest = {
  callId: string
  model: string
  sentAt: number | null
  input: number
  read: number
  write5m: number
  write1h: number
  hitRate: number
  /** The ttl this request left the cache with. */
  ttlMs: number
  /** Time since the previous request of the same loop touched the cache. */
  gapMs: number | null
  /** The gap outran the previous ttl: the cache had expired before this request. */
  expired: boolean
  /** Nothing was read though the cache should have been warm (a model switch, a changed prefix). */
  missed: boolean
}

export type CacheSavings = {
  /** What the cache reads saved against paying the input rate. */
  grossUsd: number
  /** What the writes cost beyond the input rate. */
  writePremiumUsd: number
  netUsd: number
  /** Requests left out because their model has no prices. */
  unpricedRequests: number
}

export type CacheReport = {
  requests: CacheRequest[]
  ttlMs: number
  ttlFrom: 'usage' | 'default'
  lastWriteAt: number | null
  lastReadAt: number | null
  totals: { input: number; read: number; write5m: number; write1h: number }
  hitRate: number
  expiries: number
  /** Null when no request has prices. */
  savings: CacheSavings | null
  /** Per subagent id, the same report for its own requests. */
  subagents: Record<string, Omit<CacheReport, 'subagents'>>
}

function ttlOf(call: Call, previous: number | null): number | null {
  if (call.cacheWrite5m > 0) {
    return DEFAULT_TTL_MS
  }
  if (call.cacheWrite1h > 0) {
    return HOUR_TTL_MS
  }

  return previous
}

function hit(input: number, read: number, write: number): number {
  const total = input + read + write

  return total > 0 ? read / total : 0
}

function track(calls: Call[], prices: PriceTable): Omit<CacheReport, 'subagents'> {
  const requests: CacheRequest[] = []
  const totals = { input: 0, read: 0, write5m: 0, write1h: 0 }
  let ttl: number | null = null
  let touched: number | null = null
  let lastWriteAt: number | null = null
  let lastReadAt: number | null = null
  let expiries = 0
  let gross = 0
  let premium = 0
  let unpriced = 0
  let priced = 0

  for (const call of calls) {
    const at = call.sentAt
    const gapMs = at !== null && touched !== null ? Math.max(0, at - touched) : null
    const expired = gapMs !== null && gapMs > (ttl ?? DEFAULT_TTL_MS)
    const missed = !expired && touched !== null && call.cacheRead === 0
    if (expired) {
      expiries++
    }
    ttl = ttlOf(call, ttl)
    if (at !== null && (call.cacheRead > 0 || call.cacheWrite5m + call.cacheWrite1h > 0)) {
      touched = touched === null ? at : Math.max(touched, at)
      if (call.cacheRead > 0) {
        lastReadAt = lastReadAt === null ? at : Math.max(lastReadAt, at)
      }
      if (call.cacheWrite5m + call.cacheWrite1h > 0) {
        lastWriteAt = lastWriteAt === null ? at : Math.max(lastWriteAt, at)
      }
    }
    totals.input += call.input
    totals.read += call.cacheRead
    totals.write5m += call.cacheWrite5m
    totals.write1h += call.cacheWrite1h

    const rates = ratesFor(call.model, prices)
    if (rates) {
      priced++
      gross += usd(call.cacheRead, rates.input - rates.cacheRead)
      premium += usd(call.cacheWrite5m, rates.cacheWrite - rates.input) + usd(call.cacheWrite1h, rates.cacheWrite1h - rates.input)
    } else {
      unpriced++
    }

    requests.push({
      callId: call.id,
      model: call.model,
      sentAt: at,
      input: call.input,
      read: call.cacheRead,
      write5m: call.cacheWrite5m,
      write1h: call.cacheWrite1h,
      hitRate: hit(call.input, call.cacheRead, call.cacheWrite5m + call.cacheWrite1h),
      ttlMs: ttl ?? DEFAULT_TTL_MS,
      gapMs,
      expired,
      missed,
    })
  }

  return {
    requests,
    ttlMs: ttl ?? DEFAULT_TTL_MS,
    ttlFrom: ttl === null ? 'default' : 'usage',
    lastWriteAt,
    lastReadAt,
    totals,
    hitRate: hit(totals.input, totals.read, totals.write5m + totals.write1h),
    expiries,
    savings: priced === 0 ? null : { grossUsd: gross, writePremiumUsd: premium, netUsd: gross - premium, unpricedRequests: unpriced },
  }
}

/** Cache writes, reads, ttl and savings for the main loop, and each subagent apart. */
export function trackCache(log: SessionLog, prices: PriceTable = PRICES): CacheReport {
  const main: Call[] = []
  const agents = new Map<string, Call[]>()
  for (const call of log.calls) {
    if (call.isSidechain) {
      const id = call.agentId ?? 'subagent'
      agents.set(id, [...(agents.get(id) ?? []), call])
    } else {
      main.push(call)
    }
  }
  const bySent = (a: Call, b: Call) => (a.sentAt ?? 0) - (b.sentAt ?? 0)
  const subagents: CacheReport['subagents'] = {}
  for (const [id, calls] of agents) {
    subagents[id] = track(calls.sort(bySent), prices)
  }

  return { ...track(main.sort(bySent), prices), subagents }
}
