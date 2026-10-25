import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Advice, Calibration, Tier } from '../types'
import { advise, compact, countTokens } from './estimate'
import { LOGO_SVG, barSvg } from './logo'

// OptiClaude never calls a model, the token-count API or a slash command that
// writes to the transcript: every figure comes from local counting and from
// `$.session.usage()`, whose plain call is free. Using the mod costs 0 tokens.

const PANE = 'opticlaude'
const STORE_KEY = 'calibration'

const draft = atom({ plugin: 'opticlaude', key: 'draft' } as const, '')
const scratch = atom({ plugin: 'opticlaude', key: 'scratch' } as const, '')
const isAuto = atom({ plugin: 'opticlaude', key: 'isAuto' } as const, false)
const armed = atom({ plugin: 'opticlaude', key: 'armed' } as const, null)
const lastModel = atom({ plugin: 'opticlaude', key: 'lastModel' } as const, null)
const calibration = atom({ plugin: 'opticlaude', key: 'calibration' } as const, {
  trivial: { tokens: 0, percent: 0, n: 0 },
  moderate: { tokens: 0, percent: 0, n: 0 },
  heavy: { tokens: 0, percent: 0, n: 0 },
} satisfies Calibration)

const LIMITS: Record<string, string> = {
  five_hour: 'Session limit',
  seven_day: 'Weekly · all models',
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

  on('session.start', async ($, e, next) => {
    const saved = (await $.store.get(STORE_KEY)) as Calibration | undefined
    if (saved?.trivial && saved.moderate && saved.heavy) {
      await update($, calibration, () => saved)
    }

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

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      return yield* next(e)
    }
    if (routing) {
      return yield* next({ ...e, model: routing.model, effort: routing.effort })
    }
    await update($, lastModel, () => e.model)

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
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

        <Text dimColor size="caption">
          Estimated locally · costs 0 tokens
        </Text>
      </Box>
    )
  })
}
