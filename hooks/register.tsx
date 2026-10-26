import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Advice, Calibration, Stats, Tier } from '../types'
import { type BudgetLimits, type BudgetSpend, type Period, budgetStatuses, percentOf } from './budgets'
import { cacheRemainingMs, estimateNextSend } from './costEstimate'
import { advise, compact, countTokens } from './estimate'
import { LOGO_SVG, barSvg } from './logo'
import { promptTips } from './promptTips'
import { costSeriesSvg, sessionCsv, sessionTotals } from './history'
import { logProvider } from './session'

// OptiClaude never calls a model, the token-count API or a slash command that
// writes to the transcript: every figure comes from local counting and from
// `$.session.usage()`, whose plain call is free. Using the mod costs 0 tokens.

const PANE = 'opticlaude'
const STORE_KEY = 'calibration'
const SHARE_KEY = 'contextShareAlert'
// Shares of the used context a category may take before it is highlighted.
const SHARE_STEPS = [25, 40, 60]
const BUDGET_KEY = 'budgets'
const DISMISSED_KEY = 'dismissedTips'
const HISTORY_KEY = 'history'
// Enough turns for a month of use; older spend is dropped.
const HISTORY_CAP = 5_000
const PERIODS: Period[] = ['session', 'daily', 'weekly']
const DEFAULT_LIMITS: BudgetLimits = { session: null, daily: null, weekly: null }
// Each press moves a budget to the next of these USD limits, then back to off.
const BUDGET_STEPS: Record<Period, (number | null)[]> = {
  session: [null, 1, 5, 20],
  daily: [null, 5, 20, 50],
  weekly: [null, 25, 100, 250],
}
// One finished main-loop turn's spend, kept for the daily and weekly budgets and the history.
type Spend = { at: number; session: string; usd: number }

const draft = atom({ plugin: 'opticlaude', key: 'draft' } as const, '')
const scratch = atom({ plugin: 'opticlaude', key: 'scratch' } as const, '')
const isAuto = atom({ plugin: 'opticlaude', key: 'isAuto' } as const, false)
const shareAlert = atom({ plugin: 'opticlaude', key: 'shareAlert' } as const, 40)
const dismissedTips = atom({ plugin: 'opticlaude', key: 'dismissedTips' } as const, [] as string[])
const copyNote = atom({ plugin: 'opticlaude', key: 'copyNote' } as const, '')
const showHistory = atom({ plugin: 'opticlaude', key: 'showHistory' } as const, false)
const armed = atom({ plugin: 'opticlaude', key: 'armed' } as const, null)
const lastModel = atom({ plugin: 'opticlaude', key: 'lastModel' } as const, null)
const calibration = atom({ plugin: 'opticlaude', key: 'calibration' } as const, {
  trivial: { tokens: 0, percent: 0, n: 0 },
  moderate: { tokens: 0, percent: 0, n: 0 },
  heavy: { tokens: 0, percent: 0, n: 0 },
} satisfies Calibration)
const EMPTY_STATS: Stats = {
  turn: null,
  live: { tools: 0, agents: 0 },
  sessionTokens: 0,
  sessionOutput: 0,
  models: {},
  bigTools: [],
  lastCallAt: null,
  burnFrom: null,
}
const stats = atom({ plugin: 'opticlaude', key: 'stats' } as const, EMPTY_STATS)
// Bumped every second so the cache countdown moves while the pane is up.
const tick = atom({ plugin: 'opticlaude', key: 'tick' } as const, 0)

const LIFETIME_KEY = 'lifetimeUsd'
// The prompt cache keeps an entry 5 minutes after its last use by default.
const CACHE_MS = 5 * 60_000
const SUBAGENT_TOOLS = new Set(['Agent', 'Task'])

const LIMITS: Record<string, string> = {
  five_hour: 'Session limit',
  seven_day: 'Weekly · all models',
}

// One colour per context category, in order of size; readable on light and dark themes.
const CATEGORY_COLORS = ['#3b82f6', '#a855f7', '#14b8a6', '#eab308', '#ec4899', '#64748b']
// Below this many columns (a narrow or collapsed sidebar) the pane shows only the key numbers.
const COMPACT_COLUMNS = 34

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) {
    return `${minutes} min`
  }

  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`
}

function usd(value: number): string {
  return value < 1 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`
}

function money(value: number | undefined): string {
  return value === undefined ? 'n/a' : usd(value)
}

function sessionPercent(limits: readonly SessionRateLimit[]): number | undefined {
  return limits.find(limit => limit.kind === 'five_hour')?.percentUsed
}

function resetLabel(resetsAt: string | undefined, now: number): string {
  const at = resetsAt ? Date.parse(resetsAt) : NaN
  if (Number.isNaN(at)) {
    return ''
  }
  const minutes = Math.max(0, Math.round((at - now) / 60_000))
  if (minutes < 24 * 60) {
    return `Resets in ${Math.floor(minutes / 60)} hr ${minutes % 60} min`
  }
  const date = new Date(at)
  const day = date.toLocaleDateString('en-US', { weekday: 'short' })
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

  return `Resets ${day} ${time}`
}

/** Runs the model or effort the person armed in the pane, or the advice when Auto is on. */
async function toApply($: EngineInterface, text: string): Promise<Advice | null> {
  const chosen = await read($, armed)
  if (chosen) {
    return chosen
  }

  return (await read($, isAuto)) ? advise(text) : null
}

export const register: Register = on => {
  // The advice in force for the running turn, and the session limit when it began.
  let routing: Advice | null = null
  let turnTier: Tier | null = null
  let percentAtStart: number | undefined
  let usdAtStart = 0
  let stopTicking: (() => void) | undefined
  // Reads the session's transcript for the cache countdown and the next-send cost; created on first render.
  let snapshots: ReturnType<typeof logProvider> | undefined

  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get(STORE_KEY)) as Calibration | undefined
    if (saved?.trivial && saved.moderate && saved.heavy) {
      await update($, calibration, () => saved)
    }
    const savedShare = (await $.store.get(SHARE_KEY)) as number | undefined
    if (typeof savedShare === 'number') {
      await update($, shareAlert, () => savedShare)
    }
    const savedDismissed = (await $.store.get(DISMISSED_KEY)) as string[] | undefined
    if (savedDismissed) {
      await update($, dismissedTips, () => savedDismissed)
    }
    stopTicking?.()
    const timer = $.clock.every(1000, () => void update($, tick, n => n + 1))
    stopTicking = () => timer.cancel()

    return next(e)
  })

  // The draft, live: typing and pastes come through `prompt.edit`, history,
  // clears and fills through `prompt.change`.
  on('prompt.edit', async ($, e, next) => {
    const box = await next(e)
    await update($, draft, () => box.text)

    return box
  })

  on('prompt.change', async ($, e, next) => {
    await update($, draft, () => e.text)

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'composer' && !e.isMeta && e.command === undefined) {
      const advice = advise(e.text)
      routing = await toApply($, e.text)
      turnTier = routing?.tier ?? advice?.tier ?? null
      percentAtStart = sessionPercent((await $.session.usage()).rateLimits)
      await update($, armed, () => null)
    }
    if (!e.isMeta && e.command === undefined) {
      usdAtStart = (await $.session.usage()).cost?.usd ?? 0
      await update($, stats, all => ({ ...all, live: { tools: 0, agents: 0 } }))
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(e)
    }
    if (!routing) {
      await update($, lastModel, () => e.model)
    }
    const result = yield* next(routing ? { ...e, model: routing.model, effort: routing.effort } : e)
    const at = await $.clock.now()
    await update($, stats, all => ({ ...all, lastCallAt: at }))

    return result
  })

  // Tool calls, subagents and the size of each result, counted locally.
  on('tool.call', async ($, e, next) => {
    const result = await next(e)
    const tokens = countTokens(result.text ?? '')
    const isAgent = SUBAGENT_TOOLS.has(e.tool)
    await update($, stats, all => ({
      ...all,
      live: {
        tools: all.live.tools + (e.agentId === undefined ? 1 : 0),
        agents: all.live.agents + (isAgent ? 1 : 0),
      },
      bigTools: [...all.bigTools, { name: e.tool, tokens }].sort((a, b) => b.tokens - a.tokens).slice(0, 3),
    }))

    return result
  })

  on('turn.complete', async ($, e, next) => {
    const spent = e.usage
    if (spent) {
      const total =
        spent.input_tokens + spent.output_tokens + spent.cache_read_input_tokens + spent.cache_creation_input_tokens
      const now = await $.clock.now()
      const usage = await $.session.usage()
      const percent = sessionPercent(usage.rateLimits)
      const turnUsd = e.agentId === undefined ? Math.max(0, (usage.cost?.usd ?? 0) - usdAtStart) : 0
      await update($, stats, all => ({
        ...all,
        turn:
          e.agentId === undefined
            ? {
                input: spent.input_tokens,
                output: spent.output_tokens,
                cacheRead: spent.cache_read_input_tokens,
                cacheWrite: spent.cache_creation_input_tokens,
                usd: turnUsd,
                tools: all.live.tools,
                agents: all.live.agents,
              }
            : all.turn,
        sessionTokens: all.sessionTokens + total,
        sessionOutput: all.sessionOutput + spent.output_tokens,
        models: { ...all.models, [spent.model]: (all.models[spent.model] ?? 0) + total },
        lastCallAt: now,
        burnFrom:
          percent === undefined
            ? all.burnFrom
            : all.burnFrom === null || percent < all.burnFrom.percent
              ? { at: now, percent }
              : all.burnFrom,
      }))
      if (turnUsd > 0) {
        const was = ((await $.store.get(LIFETIME_KEY)) as number | undefined) ?? 0
        await $.store.set(LIFETIME_KEY, was + turnUsd)
        const entries = ((await $.store.get(HISTORY_KEY)) as Spend[] | undefined) ?? []
        const session = await $.session.id()
        await $.store.set(HISTORY_KEY, [...entries, { at: now, session, usd: turnUsd }].slice(-HISTORY_CAP))
      }
    }
    if (e.agentId !== undefined || turnTier === null) {
      return next(e)
    }
    const tier = turnTier
    const startedAt = percentAtStart
    routing = null
    turnTier = null
    if (e.usage && !e.isAborted) {
      const used =
        e.usage.input_tokens +
        e.usage.output_tokens +
        e.usage.cache_read_input_tokens +
        e.usage.cache_creation_input_tokens
      const after = sessionPercent((await $.session.usage()).rateLimits)
      const rise = startedAt !== undefined && after !== undefined ? Math.max(0, after - startedAt) : 0
      const learned = await update($, calibration, all => {
        const was = all[tier]
        const n = Math.min(was.n + 1, 20)

        return {
          ...all,
          [tier]: {
            n,
            tokens: was.tokens + (used - was.tokens) / n,
            percent: was.percent + (rise - was.percent) / n,
          },
        }
      })
      await $.store.set(STORE_KEY, learned)
    }

    return next(e)
  })

  // The toggle, at the right end of the band above the prompt: beside Clawd.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const typed = await read($, draft)
    const advice = advise(typed)
    const toggle = async () => {
      const isUp = (await $.ui.panes()).some(pane => pane.id === PANE)
      if (isUp) {
        await $.ui.close({ id: PANE })
      } else {
        await $.ui.open({ id: PANE, title: 'OptiClaude', columns: 46 })
      }
    }

    return (
      <Box flexDirection="row" justifyContent="flex-end" alignItems="center" gap={1}>
        {typed.trim() ? (
          <Text dimColor>
            ≈{compact(countTokens(typed))} tok · {advice?.modelLabel}
          </Text>
        ) : (
          ''
        )}
        {/* A Button holds only strings and Text, so the OC mark is drawn as text. */}
        <Button key="opticlaude-toggle" label="OptiClaude" onPress={toggle}>
          <Text color="#ff4545" bold>
            OC
          </Text>
        </Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const typed = await read($, draft)
    const pasted = await read($, scratch)
    const text = typed.trim() ? typed : pasted
    const auto = await read($, isAuto)
    const chosen = await read($, armed)
    const model = await read($, lastModel)
    const learned = await read($, calibration)
    const usage = await $.session.usage()
    const now = await $.clock.now()
    const spent = await read($, stats)
    await read($, tick)
    const lifetime = ((await $.store.get(LIFETIME_KEY)) as number | undefined) ?? 0
    // `summary` estimates each category locally: no request, no tokens.
    const breakdown = (await $.session.usage({ breakdown: 'summary', columns: e.props.bodyColumns })).context.breakdown
    const alertAt = await read($, shareAlert)
    const dismissed = await read($, dismissedTips)
    const tips = promptTips(text).filter(tip => !dismissed.includes(tip.id))
    const setDismissed = (next: string[]) => {
      void $.store.set(DISMISSED_KEY, next)

      return update($, dismissedTips, () => next)
    }
    snapshots ??= logProvider($)
    const snap = await snapshots.read().catch(() => null)
    const sendNow = snap ? estimateNextSend(snap.snapshot, countTokens(text)) : null
    const caps = ((await $.store.get(BUDGET_KEY)) as BudgetLimits | undefined) ?? DEFAULT_LIMITS
    const history = ((await $.store.get(HISTORY_KEY)) as Spend[] | undefined) ?? []
    const sumSince = (from: number) => history.filter(h => h.at >= from).reduce((sum, h) => sum + h.usd, 0)
    const spend: BudgetSpend = {
      session: usage.cost?.usd ?? 0,
      daily: sumSince(new Date(now).setHours(0, 0, 0, 0)),
      weekly: sumSince(now - 7 * 24 * 3_600_000),
    }
    const note = await read($, copyNote)
    const showing = await read($, showHistory)
    const cacheLeft = snap ? cacheRemainingMs(snap.snapshot) : null
    const cacheLine =
      cacheLeft === null
        ? 'unknown'
        : cacheLeft > 0
          ? `warm, ${Math.floor(Math.ceil(cacheLeft / 1000) / 60)}:${String(Math.ceil(cacheLeft / 1000) % 60).padStart(2, '0')} left`
          : 'cold, the next prompt re-writes the context'
    const contextLine = breakdown
      ? `Context: ${compact(breakdown.totalTokens)} of ${compact(breakdown.rawMaxTokens)} tokens (${Math.round(percentOf(breakdown.totalTokens, breakdown.rawMaxTokens))}%)`
      : `Context: ${compact(usage.context.tokens ?? 0)} tokens`
    const summary = [
      'OptiClaude session summary',
      contextLine,
      `Cost this session: ${usd(usage.cost?.usd ?? 0)}`,
      `Cache: ${cacheLine}`,
      'Top 3 offenders:',
      ...(spent.bigTools.length > 0
        ? spent.bigTools.map((tool, i) => `${i + 1}. ${tool.name}, about ${compact(tool.tokens)} tokens`)
        : ['none yet']),
    ].join('\n')

    const tokens = countTokens(text)
    const advice = advise(text)
    const context = usage.context.tokens ?? 0
    const fit = advice ? learned[advice.tier] : undefined
    const isLearned = (fit?.n ?? 0) >= 2
    const switching = advice && model !== null && !model.startsWith(advice.model) && context > 20_000
    const width = Math.max(20, e.props.bodyColumns - 2)
    const isArmed = chosen !== null && advice !== null && chosen.model === advice.model

    const elements = $.ui.resolve(e)
    const { Box, Text, Button } = elements
    const Svg = 'Svg' in elements ? elements.Svg : undefined
    // The desktop app keeps its own prompt box; where the engine cannot see
    // it, the person pastes a draft into this field instead.
    const Input = 'Input' in elements ? elements.Input : undefined

    const row = (label: string, value: string) => (
      <Box flexDirection="row" justifyContent="space-between">
        <Text dimColor>{label}</Text>
        <Text tabular>{value}</Text>
      </Box>
    )

    const limits = usage.rateLimits.filter(limit => LIMITS[limit.kind])
    const header = (title: string) => (
      <Text bold size="footnote">
        {title}
      </Text>
    )
    const bar = (percent: number) => {
      if (Svg) {
        return <Svg source={barSvg(percent, 280)} alt={`${Math.round(percent)}% used`} width={280} />
      }
      const cells = Math.max(10, width - 6)
      const full = Math.round((Math.min(100, percent) / 100) * cells)

      return (
        <Text>
          <Text color="suggestion">{'█'.repeat(full)}</Text>
          <Text dimColor>{'░'.repeat(cells - full)}</Text>
        </Text>
      )
    }

    // Stacked bar of the used context: each category takes its share of the window.
    const contextBar = (parts: { tokens: number; color: string }[], whole: number) => {
      const cells = Math.max(10, width)
      let used = 0
      const drawn = parts.map(part => {
        const from = Math.round((used / whole) * cells)
        used += part.tokens
        const to = Math.min(cells, Math.round((used / whole) * cells))

        return { color: part.color, cells: Math.max(0, to - from) }
      })
      const filled = drawn.reduce((sum, part) => sum + part.cells, 0)

      return (
        <Text>
          {drawn.map((part, i) => (
            <Text key={`segment-${i}`} color={part.color}>
              {'█'.repeat(part.cells)}
            </Text>
          ))}
          <Text dimColor>{'░'.repeat(Math.max(0, cells - filled))}</Text>
        </Text>
      )
    }
    // A category above the share is amber, and red at twice the share; the rest keep their palette colour.
    const usedParts = breakdown
      ? breakdown.categories
          .filter(category => category.kind === 'used' && category.tokens > 0)
          .sort((a, b) => b.tokens - a.tokens)
          .map((category, i) => {
            const share = percentOf(category.tokens, breakdown.totalTokens)
            const palette = CATEGORY_COLORS[i % CATEGORY_COLORS.length] ?? '#64748b'
            const color = share >= alertAt * 2 ? '#ef4444' : share > alertAt ? '#f59e0b' : palette

            return { name: category.name, tokens: category.tokens, share, color }
          })
      : []
    const cycleShare = () => {
      const next = SHARE_STEPS[(SHARE_STEPS.indexOf(alertAt) + 1) % SHARE_STEPS.length] ?? 40
      void $.store.set(SHARE_KEY, next)

      return update($, shareAlert, () => next)
    }

    if (e.props.bodyColumns < COMPACT_COLUMNS) {
      const cells = Math.max(8, width)
      const contextPercentUsed = breakdown ? percentOf(breakdown.totalTokens, breakdown.rawMaxTokens) : 0
      const full = Math.round((Math.min(100, contextPercentUsed) / 100) * cells)
      const limit = usage.rateLimits.find(each => each.kind === 'five_hour')
      const cacheShort =
        cacheLeft === null ? 'n/a' : cacheLeft > 0 ? cacheLine.replace(/^warm, /, '').replace(' left', '') : 'cold'

      return (
        <Box flexDirection="column" gap={1}>
          <Text color="#ff4545" bold>
            OPTICLAUDE
          </Text>
          {breakdown && (
            <Box flexDirection="column">
              {row('Context', `${compact(breakdown.totalTokens)} of ${compact(breakdown.rawMaxTokens)}`)}
              <Text>
                <Text color="suggestion">{'█'.repeat(full)}</Text>
                <Text dimColor>{'░'.repeat(cells - full)}</Text>
              </Text>
            </Box>
          )}
          {row('Cache', cacheShort)}
          {usage.cost && row('Session', usd(usage.cost.usd))}
          {limit && row('Session limit', `${limit.percentUsed.toFixed(1)}%`)}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        {Svg ? (
          <Svg source={LOGO_SVG} alt="OptiClaude: unbeatable efficiency" width={330} />
        ) : (
          <Box flexDirection="column">
            <Text color="#ff4545" bold>
              OPTICLAUDE
            </Text>
            <Text dimColor>unbeatable efficiency</Text>
          </Box>
        )}

        <Box flexDirection="column">
          {header('Prompt estimate')}
          {text.trim() === '' && <Text dimColor>Start typing a prompt to see its cost.</Text>}
          {row('This prompt', `≈ ${compact(tokens)} tokens`)}
          {row('Context re-read on send', `${compact(context)} tokens`)}
          {advice &&
            row(
              'Expected whole turn',
              isLearned && fit
                ? `≈ ${compact(Math.round(fit.tokens))} tokens`
                : `${compact(advice.turnLow)}–${compact(advice.turnHigh)} tokens`,
            )}
          {advice && isLearned && fit && fit.percent > 0 && row('Session limit impact', `≈ +${fit.percent.toFixed(1)}%`)}
        </Box>

        {advice && (
          <Box flexDirection="column">
            {header('Recommended')}
            {row(advice.modelLabel, `${advice.effort} effort`)}
            <Text dimColor>Why: {advice.reason}</Text>
            {switching && (
              <Text color="warning">
                Switching from {model} re-reads {compact(context)} tokens without the cache.
              </Text>
            )}
            <Box flexDirection="row" gap={1}>
              <Button
                key="arm"
                variant={isArmed ? 'secondary' : 'primary'}
                label={isArmed ? 'Armed for next prompt' : 'Use for next prompt'}
                onPress={() => update($, armed, was => (was?.model === advice.model ? null : advice))}
              />
              <Button
                key="auto"
                label={auto ? 'Auto: on' : 'Auto: off'}
                onPress={() => update($, isAuto, was => !was)}
              />
            </Box>
          </Box>
        )}

        {Input && typed.trim() === '' && (
          <Input
            key="scratch"
            label="Or paste a draft to measure"
            placeholder="e.g. fix all typos in README.md"
            value={pasted}
            rows={3}
            submitLabel="Measure"
            onInput={next => void update($, scratch, () => next)}
            onSubmit={next => void update($, scratch, () => next)}
          />
        )}

        {tips.length > 0 && (
          <Box flexDirection="column">
            {tips.map(tip => (
              <Box key={tip.id} flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
                <Text color={tip.severity === 'warn' ? 'warning' : undefined} size="caption">
                  {tip.message}
                </Text>
                <Button key={`dismiss-${tip.id}`} label="×" onPress={() => setDismissed([...dismissed, tip.id])} />
              </Box>
            ))}
          </Box>
        )}
        {dismissed.length > 0 && (
          <Button key="tips-reset" label="Show tips again" onPress={() => setDismissed([])} />
        )}

        {limits.length > 0 && (
          <Box flexDirection="column" gap={1}>
            {header('Usage')}
            {limits.map(limit => (
              <Box flexDirection="column">
                <Box flexDirection="row" justifyContent="space-between">
                  <Text>{LIMITS[limit.kind]}</Text>
                  <Text dimColor tabular>
                    {resetLabel(limit.resetsAt, now)} {limit.percentUsed.toFixed(1)}%
                  </Text>
                </Box>
                {bar(limit.percentUsed)}
              </Box>
            ))}
          </Box>
        )}

        {(() => {
          // The transcript's own cache clock when it can be read; else our count from the last response.
          const left = snap
            ? cacheRemainingMs(snap.snapshot)
            : spent.lastCallAt === null
              ? null
              : CACHE_MS - (now - spent.lastCallAt)
          if (left === null) {
            return row('Cache', 'no request yet')
          }
          if (left <= 0) {
            return (
              <Box flexDirection="column">
                {header('Cache')}
                <Text color="warning">Expired: the next prompt re-writes {compact(context)} tokens.</Text>
              </Box>
            )
          }
          const seconds = Math.ceil(left / 1000)

          return (
            <Box flexDirection="column">
              {header('Cache')}
              {row('Warm, expires in', `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`)}
              {seconds < 60 && <Text color="warning">Send soon to keep the cache.</Text>}
            </Box>
          )
        })()}

        <Box flexDirection="column">
          {header('Cost')}
          {spent.turn && row('Last turn', usd(spent.turn.usd))}
          {usage.cost && row('This session', usd(usage.cost.usd))}
          {row('Running total', usd(Math.max(lifetime, usage.cost?.usd ?? 0)))}
          {sendNow &&
            row(
              'Next send · warm · cold',
              `${money(sendNow.warm.totalUsd?.expected)} · ${money(sendNow.cold.totalUsd?.expected)}`,
            )}
        </Box>

        <Box flexDirection="column">
          {header('Budgets')}
          {budgetStatuses(caps, spend).map(st => (
            <Box key={st.period} flexDirection="column">
              {row(`${st.period} · ${usd(st.spent)} of ${usd(st.limit)}`, `${Math.round(st.percent)}%`)}
              {bar(st.percent)}
              {st.exceeded && <Text color="#ef4444">{st.period} budget exceeded</Text>}
            </Box>
          ))}
          <Box flexDirection="row" gap={1}>
            {PERIODS.map(period => (
              <Button
                key={`budget-${period}`}
                label={`${period} ${caps[period] === null ? 'off' : `$${caps[period]}`}`}
                onPress={() => {
                  const steps = BUDGET_STEPS[period]
                  const next = steps[(steps.indexOf(caps[period]) + 1) % steps.length] ?? null

                  return $.store.set(BUDGET_KEY, { ...caps, [period]: next })
                }}
              />
            ))}
          </Box>
        </Box>

        {spent.turn && (
          <Box flexDirection="column">
            {header('Last turn')}
            {row('Input · cache read', `${compact(spent.turn.input)} · ${compact(spent.turn.cacheRead)}`)}
            {row('Cache written', compact(spent.turn.cacheWrite))}
            {row('Output (incl. thinking)', compact(spent.turn.output))}
            {row('Tool calls · subagents', `${spent.turn.tools} · ${spent.turn.agents}`)}
          </Box>
        )}
        {(spent.live.tools > 0 || spent.live.agents > 0) &&
          row('This turn so far', `${spent.live.tools} tools · ${spent.live.agents} agents`)}

        {(() => {
          const percent = sessionPercent(usage.rateLimits)
          const from = spent.burnFrom
          if (percent === undefined || from === null || now - from.at < 60_000 || percent <= from.percent) {
            return null
          }
          const perHour = ((percent - from.percent) / (now - from.at)) * 3_600_000
          const limit = usage.rateLimits.find(each => each.kind === 'five_hour')
          const reset = limit?.resetsAt ? Date.parse(limit.resetsAt) : NaN
          const hitIn = ((100 - percent) / perHour) * 3_600_000
          const isSafe = !Number.isNaN(reset) && now + hitIn > reset

          return (
            <Box flexDirection="column">
              {header('Burn rate')}
              {row('Session limit', `+${perHour.toFixed(1)}% / hr`)}
              {isSafe ? (
                <Text dimColor>At this pace you will not hit it before it resets.</Text>
              ) : (
                <Text color="warning">At this pace you hit it in {duration(hitIn)}.</Text>
              )}
            </Box>
          )
        })()}

        {breakdown && (
          <Box flexDirection="column">
            {header(`Context · ${compact(breakdown.totalTokens)} of ${compact(breakdown.rawMaxTokens)}`)}
            {contextBar(usedParts, Math.max(1, breakdown.rawMaxTokens))}
            {usedParts.map(part => (
              <Box key={part.name} flexDirection="row" justifyContent="space-between">
                <Text color={part.color}>
                  ■ {part.name} {Math.round(part.share)}%
                </Text>
                <Text tabular>{compact(part.tokens)}</Text>
              </Box>
            ))}
            <Button key="share" label={`Highlight above ${alertAt}%`} onPress={cycleShare} />
            {breakdown.isAutoCompactEnabled &&
              breakdown.autoCompactThreshold !== undefined &&
              breakdown.totalTokens >= breakdown.autoCompactThreshold * 0.8 && (
                <Text color="warning">
                  Auto-compaction soon ({compact(breakdown.autoCompactThreshold)}). Run /compact, or /clear for a new
                  task.
                </Text>
              )}
          </Box>
        )}

        {spent.bigTools.length > 0 && (
          <Box flexDirection="column">
            {header('Biggest tool outputs')}
            {spent.bigTools.map(each => row(each.name, `≈ ${compact(each.tokens)}`))}
          </Box>
        )}

        {spent.sessionTokens > 0 && (
          <Box flexDirection="column">
            {header('By model · this session')}
            {Object.entries(spent.models)
              .sort((a, b) => b[1] - a[1])
              .map(([id, tokens]) =>
                row(id.replace(/^claude-/, ''), `${Math.round((tokens / spent.sessionTokens) * 100)}% · ${compact(tokens)}`),
              )}
          </Box>
        )}

        <Box flexDirection="column">
          {showing && (
            <Box flexDirection="column">
              {header('History')}
              {history.length === 0 ? (
                <Text dimColor>No finished turns recorded yet.</Text>
              ) : (
                <Box flexDirection="column">
                  {Svg && (
                    <Svg source={costSeriesSvg(history, 280, 60)} alt="Cumulative cost over time" width={280} />
                  )}
                  {sessionTotals(history)
                    .slice(-5)
                    .map(total =>
                      row(`${total.session.slice(0, 8)} · ${total.turns} turns`, usd(total.usd)),
                    )}
                </Box>
              )}
              <Button
                key="history-csv"
                label="Copy CSV"
                onPress={press =>
                  $.ui
                    .copy({ text: sessionCsv(history), surface: press.surface })
                    .then(result => update($, copyNote, () => (result.isCopied ? 'CSV copied' : `Not copied: ${result.reason}`)))
                }
              />
            </Box>
          )}
          <Button
            key="history-toggle"
            label={showing ? 'Hide history' : 'Show history'}
            onPress={() => update($, showHistory, was => !was)}
          />
        </Box>
        <Button
          key="copy-summary"
          label="Copy summary"
          onPress={press =>
            $.ui
              .copy({ text: summary, surface: press.surface })
              .then(result => update($, copyNote, () => (result.isCopied ? 'Summary copied' : `Not copied: ${result.reason}`)))
          }
        />
        {note && (
          <Text dimColor size="caption">
            {note}
          </Text>
        )}
        <Text dimColor size="caption">
          Estimated locally · costs 0 tokens
        </Text>
        <Text dimColor size="caption">
          v1.0.2
        </Text>
      </Box>
    )
  })
}
