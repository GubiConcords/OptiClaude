import type { Effort, ModelId, SessionSnapshot } from '../types'
import { type SendEstimate, estimateNextSend } from './costEstimate'
import { MODEL_IDS, type PriceTable } from './pricing'

export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']

export type ComparisonRow = {
  model: ModelId
  effort: Effort
  estimate: SendEstimate
  /** Expected total USD for the current cache state; null when prices are missing. */
  expectedUsd: number | null
  /** True for the cheapest priced row. */
  isCheapest: boolean
}

export type ComparisonOptions = {
  models?: ModelId[]
  efforts?: Effort[]
  prices?: PriceTable
}

/** The same drafted prompt priced on every model and effort, the cheapest flagged. */
export function compareModels(s: SessionSnapshot, promptTokens: number, options: ComparisonOptions = {}): ComparisonRow[] {
  const models = options.models ?? MODEL_IDS
  const efforts = options.efforts ?? EFFORTS
  const rows: ComparisonRow[] = []
  for (const model of models) {
    for (const effort of efforts) {
      const estimate = estimateNextSend(s, promptTokens, { model, effort, prices: options.prices })
      rows.push({ model, effort, estimate, expectedUsd: estimate.current.totalUsd?.expected ?? null, isCheapest: false })
    }
  }

  let best: ComparisonRow | null = null
  for (const row of rows) {
    if (row.expectedUsd !== null && (best === null || row.expectedUsd < (best.expectedUsd ?? Infinity))) {
      best = row
    }
  }
  if (best) {
    best.isCheapest = true
  }

  return rows
}
