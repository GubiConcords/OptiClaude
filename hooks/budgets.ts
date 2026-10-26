import type { SessionSnapshot } from '../types'

export type Period = 'session' | 'daily' | 'weekly'

/** USD limits; null or 0 means no limit for that period. */
export type BudgetLimits = Record<Period, number | null>

/** USD spent so far in each period. */
export type BudgetSpend = Record<Period, number>

export type Severity = 'info' | 'warn' | 'critical'

export type Alert = { id: string; severity: Severity; message: string }

export type BudgetStatus = {
  period: Period
  limit: number
  spent: number
  /** Unclamped, so 130 means 30% over. */
  percent: number
  /** The highest threshold crossed, null below the first. */
  crossed: number | null
  exceeded: boolean
}

export type BudgetOptions = {
  /** Percent marks that raise alerts, in any order. */
  thresholds?: number[]
  /** Raise a context alert at this percent of the window. */
  contextAlertPercent?: number
}

export const DEFAULT_THRESHOLDS = [50, 80]
export const DEFAULT_CONTEXT_ALERT_PERCENT = 80

const PERIODS: Period[] = ['session', 'daily', 'weekly']

export function percentOf(part: number, whole: number): number {
  return whole > 0 && Number.isFinite(part) ? (Math.max(0, part) / whole) * 100 : 0
}

/** Context fill in percent of the window; 0 without a window. */
export function contextPercent(s: SessionSnapshot): number {
  return percentOf(s.contextTokens, s.contextWindow)
}

/** Progress per limited period; periods without a limit are left out. */
export function budgetStatuses(limits: BudgetLimits, spend: BudgetSpend, thresholds = DEFAULT_THRESHOLDS): BudgetStatus[] {
  const marks = [...thresholds].sort((a, b) => a - b)
  const out: BudgetStatus[] = []
  for (const period of PERIODS) {
    const limit = limits[period]
    if (limit === null || !(limit > 0)) {
      continue
    }
    const spent = Math.max(0, spend[period])
    const percent = percentOf(spent, limit)
    out.push({
      period,
      limit,
      spent,
      percent,
      crossed: marks.filter((m) => percent >= m).at(-1) ?? null,
      exceeded: percent >= 100,
    })
  }

  return out
}

/** Budget and context alerts, most severe first. The caller decides when to show them. */
export function budgetAlerts(
  limits: BudgetLimits,
  spend: BudgetSpend,
  snapshot: SessionSnapshot | null,
  options: BudgetOptions = {},
): Alert[] {
  const marks = [...(options.thresholds ?? DEFAULT_THRESHOLDS)].sort((a, b) => a - b)
  const alerts: Alert[] = []

  for (const st of budgetStatuses(limits, spend, marks)) {
    if (st.exceeded) {
      alerts.push({
        id: `budget-${st.period}-exceeded`,
        severity: 'critical',
        message: `${st.period} budget exceeded (${Math.round(st.percent)}%)`,
      })
    } else if (st.crossed !== null) {
      // The first mark is a heads-up; any later one is a warning.
      alerts.push({
        id: `budget-${st.period}-${st.crossed}`,
        severity: marks.indexOf(st.crossed) === 0 ? 'info' : 'warn',
        message: `${st.period} budget at ${Math.round(st.percent)}% (passed ${st.crossed}%)`,
      })
    }
  }

  const mark = options.contextAlertPercent ?? DEFAULT_CONTEXT_ALERT_PERCENT
  if (snapshot && snapshot.contextWindow > 0) {
    const pct = contextPercent(snapshot)
    if (pct >= mark) {
      alerts.push({
        id: 'context-window',
        severity: pct >= 95 ? 'critical' : 'warn',
        message: `context window ${Math.round(pct)}% full`,
      })
    }
  }

  const rank: Record<Severity, number> = { critical: 0, warn: 1, info: 2 }

  return alerts.sort((a, b) => rank[a.severity] - rank[b.severity])
}
