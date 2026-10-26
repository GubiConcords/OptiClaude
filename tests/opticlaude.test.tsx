import { expect, test } from 'claude-code/testing'

import { advise, countTokens } from '../hooks/estimate'

const BAND = {
  plugin: 'opticlaude',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 60, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const PANE = {
  plugin: 'opticlaude',
  component: 'Pane',
  requestId: 'opticlaude',
  props: {
    title: 'OptiClaude',
    isFocused: false,
    bodyColumns: 44,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('advice fits the task', () => {
  expect(advise('fix all typos')?.modelLabel).toBe('Haiku 5.5')
  expect(advise('fix all typos')?.effort).toBe('low')
  expect(advise('fix the failing login test')?.modelLabel).toBe('Sonnet 5.5')
  expect(advise('migrate the entire backend from Express to Fastify and redesign the auth')?.modelLabel).toBe('Opus 5.5')
  expect(advise('   ')).toBe(null)
  expect(countTokens('')).toBe(0)
  expect(countTokens('Hello world, how are you?')).toBeGreaterThan(4)
})

test('the band and pane show the draft on every surface', async ($, on) => {
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.change', (_, e) => ({ text: e.text }))
  on('store.get', () => ({ value: undefined }))
  on('clock.now', () => ({ value: Date.parse('2026-10-25T21:00:00Z') }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 48_000, window: 200_000, percent: 24 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 26, resetsAt: '2026-10-25T23:45:00Z' },
        { kind: 'seven_day', percentUsed: 37, resetsAt: '2026-10-31T15:00:00Z' },
      ],
    },
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // The engine raises prompt.change; the kit dispatches it though `$` does not type it.
  const prompt = $.prompt as unknown as { change: (e: object) => Promise<unknown> }
  await prompt.change({ text: 'fix all typos in README.md', cursor: 0, origin: { kind: 'engine' } })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /Haiku/ }))?.text).toMatch(/tok · Haiku 5.5/)
    await band.unmount()

    const pane = await $.ui.mount({ ...PANE, surface })
    expect(await pane.find({ type: 'Text', text: /Session limit/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /costs 0 tokens/ })).toBeDefined()
    expect(await pane.find({ key: 'arm' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^v1.0.2$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Running total/ })).toBeDefined()
    await pane.unmount()
  }
})
