import type { Effort, ModelId, SessionSnapshot } from '../types'
import { type PriceTable, PRICES, ratesFor, usd } from './pricing'

export type CacheState = 'warm' | 'cold'

export type Range = { low: number; expected: number; high: number }

export type Cost = {
  /** Tokens sent as input, whatever the cache does with them. */
  inputTokens: number
  /** Null when the model's prices are not filled in. */
  inputUsd: number | null
  /** Output plus thinking tokens per turn: min, mean, max of the history (zeros without history). */
  outputTokens: Range
  outputUsd: Range | null
  totalUsd: Range | null
}

export type SendEstimate = {
  model: ModelId
  effort: Effort
  /** The cache's state now; another model than the session's is always cold. */
  state: CacheState
  warm: Cost
  cold: Cost
  /** The cost for the current state. */
  current: Cost
  /** cold − warm, expected total; null when prices are missing. */
  differenceUsd: number | null
  /** False when the session has no finished turns to average. */
  hasHistory: boolean
}

export type EstimateOptions = {
  model?: ModelId
  effort?: Effort
  prices?: PriceTable
}

/**
 * A rough, tunable guess at how much more or less a model writes and thinks at
 * each effort. TODO: calibrate against real turns.
 */
export const EFFORT_OUTPUT_SCALE: Record<Effort, number> = { low: 0.5, medium: 1, high: 1.5, xhigh: 2, max: 3 }

/** Milliseconds until the cache expires: 0 when cold or never written. */
export function cacheRemainingMs(s: SessionSnapshot): number {
  const { lastWriteAt, lastReadAt, ttlMs } = s.cache
  if (lastWriteAt === null && lastReadAt === null) {
    return 0
  }
  const touched = Math.max(lastWriteAt ?? -Infinity, lastReadAt ?? -Infinity)

  return Math.max(0, touched + ttlMs - s.now)
}

export function cacheState(s: SessionSnapshot): CacheState {
  return cacheRemainingMs(s) > 0 ? 'warm' : 'cold'
}

/** Per-turn output plus thinking tokens: min, mean and max over the history. */
export function outputRange(s: SessionSnapshot): Range {
  const totals = s.turns.map((t) => Math.max(0, t.output) + Math.max(0, t.thinking))
  if (totals.length === 0) {
    return { low: 0, expected: 0, high: 0 }
  }
  const sum = totals.reduce((a, b) => a + b, 0)

  return { low: Math.min(...totals), expected: sum / totals.length, high: Math.max(...totals) }
}

function build(inputTokens: number, inputUsd: number | null, tokens: Range, rate: number | null): Cost {
  const outputUsd =
    rate === null ? null : { low: usd(tokens.low, rate), expected: usd(tokens.expected, rate), high: usd(tokens.high, rate) }
  const totalUsd =
    outputUsd === null || inputUsd === null
      ? null
      : { low: inputUsd + outputUsd.low, expected: inputUsd + outputUsd.expected, high: inputUsd + outputUsd.high }

  return { inputTokens, inputUsd, outputTokens: tokens, outputUsd, totalUsd }
}

/**
 * Cost of sending a prompt of `promptTokens` next. Warm: the context is read
 * from the cache and only the new prompt is written. Cold: the whole context
 * and the prompt are written afresh.
 */
export function estimateNextSend(s: SessionSnapshot, promptTokens: number, options: EstimateOptions = {}): SendEstimate {
  const model = options.model ?? s.model
  const effort = options.effort ?? s.effort
  const context = Math.max(0, s.contextTokens)
  const prompt = Math.max(0, promptTokens)
  const rates = ratesFor(model, options.prices ?? PRICES)

  const scale = EFFORT_OUTPUT_SCALE[effort] / EFFORT_OUTPUT_SCALE[s.effort]
  const base = outputRange(s)
  const tokens = { low: base.low * scale, expected: base.expected * scale, high: base.high * scale }
  const outRate = rates === null ? null : rates.output

  const warm = build(
    context + prompt,
    rates === null ? null : usd(context, rates.cacheRead) + usd(prompt, rates.cacheWrite),
    tokens,
    outRate,
  )
  const cold = build(context + prompt, rates === null ? null : usd(context + prompt, rates.cacheWrite), tokens, outRate)

  // A cache belongs to one model: a different model starts cold.
  const state: CacheState = model === s.model ? cacheState(s) : 'cold'
  const differenceUsd = warm.totalUsd && cold.totalUsd ? cold.totalUsd.expected - warm.totalUsd.expected : null

  return {
    model,
    effort,
    state,
    warm,
    cold,
    current: state === 'warm' ? warm : cold,
    differenceUsd,
    hasHistory: s.turns.length > 0,
  }
}
