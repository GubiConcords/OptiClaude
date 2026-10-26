import { expect, test } from 'claude-code/testing'

import { budgetAlerts, budgetStatuses, contextPercent } from '../hooks/budgets'
import { cacheRemainingMs, cacheState, estimateNextSend, outputRange } from '../hooks/costEstimate'
import { compareModels } from '../hooks/modelComparison'
import { PRICES, type PriceTable, ratesFor, usd } from '../hooks/pricing'
import { promptTips } from '../hooks/promptTips'
import { stubProvider, stubSnapshot } from '../hooks/session'

// Made-up round numbers so the maths is checkable. The real prices live in hooks/pricing.ts.
const FAKE: PriceTable = {
  'claude-haiku-5-5': { input: 1, output: 5, cacheWrite: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  'claude-sonnet-5-5': { input: 3, output: 10, cacheWrite: 2, cacheWrite1h: 6, cacheRead: 0.1 },
  'claude-opus-5-5': { input: 15, output: 50, cacheWrite: 20, cacheWrite1h: 30, cacheRead: 1 },
}

function near(actual: number | undefined | null, expected: number) {
  expect(actual).toBeDefined()
  expect(Math.abs((actual as number) - expected)).toBeLessThan(1e-9)
}

test('stub provider returns a complete snapshot', async () => {
  const s = await stubProvider()
  expect(s.model).toBe('claude-sonnet-5-5')
  expect(s.turns.length).toBeGreaterThan(0)
  expect(Object.keys(s.breakdown)).toEqual(['messages', 'systemTools', 'mcpTools', 'skills', 'systemPrompt', 'other'])
  expect(stubSnapshot({ effort: 'max' }).effort).toBe('max')
})

test('pricing ships unfilled and refuses to guess', () => {
  expect(ratesFor('claude-opus-5-5')).toBeNull()
  for (const rates of Object.values(PRICES)) {
    expect(rates.input).toBeNull()
  }
  expect(ratesFor('claude-opus-5-5', FAKE)?.output).toBe(50)
  near(usd(1_000_000, 3), 3)
  expect(usd(0, 3)).toBe(0)
  expect(usd(-5, 3)).toBe(0)
})

test('cache state follows the ttl', () => {
  const warm = stubSnapshot()
  expect(cacheState(warm)).toBe('warm')
  expect(cacheRemainingMs(warm)).toBe(3 * 60_000 + 30_000) // the read 90 s ago renewed it

  const expired = stubSnapshot({ cache: { lastWriteAt: warm.now - 10 * 60_000, lastReadAt: null, ttlMs: 5 * 60_000 } })
  expect(cacheState(expired)).toBe('cold')
  expect(cacheRemainingMs(expired)).toBe(0)

  const never = stubSnapshot({ cache: { lastWriteAt: null, lastReadAt: null, ttlMs: 5 * 60_000 } })
  expect(cacheState(never)).toBe('cold')
})

test('output range comes from the session history', () => {
  expect(outputRange(stubSnapshot())).toEqual({ low: 600, expected: 3750, high: 7700 })
  expect(outputRange(stubSnapshot({ turns: [] }))).toEqual({ low: 0, expected: 0, high: 0 })
})

test('cost estimate: warm, cold and their difference', () => {
  const e = estimateNextSend(stubSnapshot(), 1_000, { prices: FAKE })
  expect(e.state).toBe('warm')
  near(e.warm.inputUsd, 0.0082)
  near(e.cold.inputUsd, 0.126)
  near(e.warm.outputUsd?.expected, 0.0375)
  near(e.warm.outputUsd?.low, 0.006)
  near(e.warm.outputUsd?.high, 0.077)
  near(e.warm.totalUsd?.expected, 0.0457)
  near(e.differenceUsd, 0.126 - 0.0082)
  expect(e.current).toBe(e.warm)
  expect(e.hasHistory).toBe(true)
})

test('cost estimate: expired cache prices the current send cold', () => {
  const s = stubSnapshot()
  const e = estimateNextSend({ ...s, now: s.now + 60 * 60_000 }, 1_000, { prices: FAKE })
  expect(e.state).toBe('cold')
  expect(e.current).toBe(e.cold)
})

test('cost estimate: missing prices and missing data', () => {
  const e = estimateNextSend(stubSnapshot(), 1_000)
  expect(e.warm.inputUsd).toBeNull()
  expect(e.cold.totalUsd).toBeNull()
  expect(e.differenceUsd).toBeNull()
  expect(e.warm.inputTokens).toBe(63_000)

  const zero = estimateNextSend(stubSnapshot({ contextTokens: 0, turns: [] }), 0, { prices: FAKE })
  expect(zero.hasHistory).toBe(false)
  near(zero.warm.totalUsd?.expected, 0)
  near(zero.cold.totalUsd?.high, 0)
  near(zero.differenceUsd, 0)

  const negative = estimateNextSend(stubSnapshot({ contextTokens: -5 }), -10, { prices: FAKE })
  expect(negative.warm.inputTokens).toBe(0)
})

test('cost estimate: effort scales output, another model is always cold', () => {
  const s = stubSnapshot()
  const base = estimateNextSend(s, 0, { prices: FAKE })
  const high = estimateNextSend(s, 0, { prices: FAKE, effort: 'high' })
  near(high.warm.outputTokens.expected, base.warm.outputTokens.expected * 1.5)

  const opus = estimateNextSend(s, 0, { prices: FAKE, model: 'claude-opus-5-5' })
  expect(opus.state).toBe('cold')
  expect(opus.model).toBe('claude-opus-5-5')
})

test('model comparison covers every model and effort', () => {
  const rows = compareModels(stubSnapshot(), 1_000, { prices: FAKE })
  expect(rows).toHaveLength(15)
  const cheapest = rows.filter((r) => r.isCheapest)
  expect(cheapest).toHaveLength(1)
  // The session's own model has a warm cache, so it beats cold Haiku at these prices.
  expect(cheapest[0]?.model).toBe('claude-sonnet-5-5')
  expect(cheapest[0]?.effort).toBe('low')
  expect(cheapest[0]?.estimate.state).toBe('warm')
  for (const r of rows) {
    expect(r.expectedUsd as number).toBeGreaterThanOrEqual(cheapest[0]?.expectedUsd as number)
  }

  const subset = compareModels(stubSnapshot(), 1_000, { prices: FAKE, models: ['claude-opus-5-5'], efforts: ['low', 'max'] })
  expect(subset).toHaveLength(2)
})

test('model comparison without prices flags nothing', () => {
  const rows = compareModels(stubSnapshot(), 1_000)
  expect(rows).toHaveLength(15)
  expect(rows.some((r) => r.isCheapest)).toBe(false)
  expect(rows[0]?.expectedUsd).toBeNull()
})

test('budgets: progress and thresholds', () => {
  const limits = { session: 10, daily: 20, weekly: null }
  const spend = { session: 5, daily: 17, weekly: 99 }
  const [session, daily, ...rest] = budgetStatuses(limits, spend)
  expect(rest).toHaveLength(0)
  expect(session?.percent).toBe(50)
  expect(session?.crossed).toBe(50)
  expect(daily?.percent).toBe(85)
  expect(daily?.crossed).toBe(80)
  expect(budgetStatuses({ session: 10, daily: null, weekly: null }, { session: 1, daily: 0, weekly: 0 })[0]?.crossed).toBeNull()
})

test('budgets: zero and missing limits are skipped, overspend is not clamped', () => {
  expect(budgetStatuses({ session: 0, daily: null, weekly: -1 }, { session: 5, daily: 5, weekly: 5 })).toHaveLength(0)
  const over = budgetStatuses({ session: 10, daily: null, weekly: null }, { session: 13, daily: 0, weekly: 0 })[0]
  expect(over?.percent).toBe(130)
  expect(over?.exceeded).toBe(true)
  expect(budgetStatuses({ session: 10, daily: null, weekly: null }, { session: -3, daily: 0, weekly: 0 })[0]?.percent).toBe(0)
})

test('budget alerts: defaults, custom thresholds and ordering', () => {
  const limits = { session: 10, daily: 20, weekly: 100 }
  const alerts = budgetAlerts(limits, { session: 12, daily: 17, weekly: 55 }, null)
  expect(alerts.map((a) => a.id)).toEqual(['budget-session-exceeded', 'budget-daily-80', 'budget-weekly-50'])
  expect(alerts.map((a) => a.severity)).toEqual(['critical', 'warn', 'info'])

  expect(budgetAlerts(limits, { session: 1, daily: 1, weekly: 1 }, null)).toEqual([])

  const custom = budgetAlerts(limits, { session: 3, daily: 0, weekly: 0 }, null, { thresholds: [90, 25] })
  expect(custom.map((a) => a.id)).toEqual(['budget-session-25'])
})

test('context-window alert', () => {
  expect(contextPercent(stubSnapshot())).toBe(31)
  expect(contextPercent(stubSnapshot({ contextWindow: 0 }))).toBe(0)

  const none = { session: null, daily: null, weekly: null }
  const zero = { session: 0, daily: 0, weekly: 0 }
  expect(budgetAlerts(none, zero, stubSnapshot())).toEqual([])

  const full = budgetAlerts(none, zero, stubSnapshot({ contextTokens: 170_000 }))
  expect(full.map((a) => a.id)).toEqual(['context-window'])
  expect(full[0]?.severity).toBe('warn')
  expect(budgetAlerts(none, zero, stubSnapshot({ contextTokens: 195_000 }))[0]?.severity).toBe('critical')
  expect(budgetAlerts(none, zero, stubSnapshot({ contextTokens: 100_000 }), { contextAlertPercent: 50 })).toHaveLength(1)
  expect(budgetAlerts(none, zero, stubSnapshot({ contextWindow: 0, contextTokens: 9 }))).toEqual([])
})

const ids = (text: string, options = {}) => promptTips(text, options).map((t) => t.id)

test('prompt tips: empty and healthy prompts raise nothing', () => {
  expect(promptTips('')).toEqual([])
  expect(promptTips('   \n ')).toEqual([])
  expect(ids('fix the null check in src/auth/login.ts so empty emails are rejected')).toEqual([])
})

test('prompt tips: large paste follows the threshold', () => {
  const blob = 'const value = compute(input) + other;\n'.repeat(400)
  expect(ids(`fix src/a.ts: ${blob}`)).toContain('large-paste')
  expect(ids(`fix src/a.ts: ${blob}`, { blobTokens: 1_000_000 })).not.toContain('large-paste')
  expect(promptTips(`fix src/a.ts: ${blob}`).find((t) => t.id === 'large-paste')?.severity).toBe('warn')
})

test('prompt tips: no file path and vague prompts', () => {
  expect(ids('refactor the login handler to use async await')).toEqual(['no-file-path'])
  expect(ids('refactor the login handler in auth/login.ts')).toEqual([])
  expect(ids('make it better')).toEqual(['vague-prompt'])
  expect(ids('help')).toEqual(['vague-prompt'])
  expect(ids('please fix it')).toContain('vague-prompt')
})

test('prompt tips: many tasks in one prompt', () => {
  const list = '1. add src/a.ts\n2. add src/b.ts\n3. add src/c.ts\n4. add src/d.ts'
  expect(ids(list)).toContain('many-tasks')
  expect(ids(list, { manyTasks: 5 })).not.toContain('many-tasks')
})
