import type { ModelId } from '../types'

// Everything here runs locally: prices are read from this file, never fetched.

/** USD per million tokens. null means "not filled in yet". */
export type Rates = {
  input: number | null
  output: number | null
  cacheWrite: number | null
  cacheRead: number | null
}

export type FullRates = { [K in keyof Rates]: number }

export type PriceTable = Record<ModelId, Rates>

/**
 * TODO: fill every null from the official Anthropic pricing page.
 * Prices are deliberately not guessed: until a model's four values are all
 * numbers, cost estimates for it come back with null USD figures.
 */
export const PRICES: PriceTable = {
  'claude-haiku-5-5': { input: null /* TODO */, output: null /* TODO */, cacheWrite: null /* TODO */, cacheRead: null /* TODO */ },
  'claude-sonnet-5-5': { input: null /* TODO */, output: null /* TODO */, cacheWrite: null /* TODO */, cacheRead: null /* TODO */ },
  'claude-opus-5-5': { input: null /* TODO */, output: null /* TODO */, cacheWrite: null /* TODO */, cacheRead: null /* TODO */ },
}

export const MODEL_IDS = Object.keys(PRICES) as ModelId[]

export const MODEL_LABELS: Record<ModelId, string> = {
  'claude-haiku-5-5': 'Haiku 5.5',
  'claude-sonnet-5-5': 'Sonnet 5.5',
  'claude-opus-5-5': 'Opus 5.5',
}

/** A model's rates when all four are filled in, else null. */
export function ratesFor(model: ModelId, table: PriceTable = PRICES): FullRates | null {
  const r = table[model]
  if (r.input === null || r.output === null || r.cacheWrite === null || r.cacheRead === null) {
    return null
  }

  return { input: r.input, output: r.output, cacheWrite: r.cacheWrite, cacheRead: r.cacheRead }
}

/** Tokens × USD-per-million. */
export function usd(tokens: number, perMillion: number): number {
  return (Math.max(0, tokens) * perMillion) / 1_000_000
}
