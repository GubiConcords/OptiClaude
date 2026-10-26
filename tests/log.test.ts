import { expect, test } from 'claude-code/testing'

import { budgetAlerts } from '../hooks/budgets'
import { DEFAULT_TTL_MS, HOUR_TTL_MS, trackCache } from '../hooks/cacheTracking'
import { DEFAULT_SUMMARY_TOKENS, analyzeContext, contextChain } from '../hooks/contextBreakdown'
import { cacheRemainingMs, estimateNextSend } from '../hooks/costEstimate'
import { countTokens } from '../hooks/estimate'
import { createSessionLogReader, parseSessionLog } from '../hooks/logParser'
import { compareModels } from '../hooks/modelComparison'
import { type PriceTable, usd } from '../hooks/pricing'
import { projectSlug, snapshotFromLog, turnOutputs } from '../hooks/session'
import { auditTools, mcpServer } from '../hooks/toolAudit'
import { realCompaction } from './fixtures/realCompaction'
import { realHaiku } from './fixtures/realHaiku'
import { T0, at, attachment, boundary, join, prompt, reply, summary, toolResult, toolUse, words } from './fixtures/synthetic'

// Round made-up prices so the maths is checkable.
const FAKE: PriceTable = {
  'claude-haiku-5-5': { input: 1, output: 5, cacheWrite: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  'claude-sonnet-5-5': { input: 3, output: 15, cacheWrite: 3.75, cacheWrite1h: 6, cacheRead: 0.3 },
  'claude-opus-5-5': { input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5 },
}

function near(actual: number | null | undefined, expected: number) {
  expect(actual).toBeDefined()
  expect(actual).not.toBeNull()
  expect(Math.abs((actual as number) - expected)).toBeLessThan(1e-9)
}

const sumOf = (b: Record<string, number>) => Object.values(b).reduce((a, x) => a + x, 0)

// A small two-request session, every number chosen by hand:
//   p1 prompt (10 tokens) → msg1 reads a file (output 300, of it thinking 100)
//   → the file's result (800 tokens) → msg2 answers (output 50) → p2 prompt (5 tokens).
// msg1's prompt 5,002 is system prompt + tools + p1; msg2's 6,102 adds msg1's
// output and the result: 5,002 + 300 + 800.
const SESSION = join(
  prompt('p1', null, 0, words(10)),
  reply('a1', 'p1', 5, 'msg1', { write1h: 5_000, output: 300, thinking: 100 }, toolUse('t1', 'Read', { file_path: 'src/big.ts' })),
  reply('a1b', 'a1', 5, 'msg1', { write1h: 5_000, output: 300, thinking: 100 }, { type: 'text', text: 'Reading it.' }),
  toolResult('r1', 'a1b', 6, 't1', words(800)),
  reply('a2', 'r1', 10, 'msg2', { read: 5_000, write1h: 1_100, output: 50 }),
  prompt('p2', 'a2', 20, words(5)),
)

test('the local counter counts the synthetic words as one token each', () => {
  expect(countTokens(words(10))).toBe(10)
  expect(countTokens(words(800))).toBe(800)
})

test('lines: chunk boundaries, CRLF and a BOM change nothing', () => {
  const whole = parseSessionLog({ s: SESSION })
  const reader = createSessionLogReader()
  const src = reader.source('s')
  const text = `\uFEFF${SESSION.replaceAll('\n', '\r\n')}`
  for (let i = 0; i < text.length; i += 7) {
    src.push(text.slice(i, i + 7))
  }
  src.end()
  const chunked = reader.result()
  expect(chunked.issues).toEqual([])
  expect(chunked.order).toEqual(whole.order)
  expect(chunked.calls).toEqual(whole.calls)
})

test('lines: malformed, non-object and partial lines are skipped and reported, never thrown', () => {
  const text = [
    prompt('p1', null, 0, 'hi'),
    '{"type":"user","uuid":"broken", "message":',
    '[1,2,3]',
    '',
    'null',
    reply('a1', 'p1', 5, 'msg1', { write1h: 100 }),
    '{"type":"assistant","uuid":"a2","parentUuid":"a1","message":{"id":"m2","model":"x","usage":{"input_tokens":"lots"}}}',
    '{"type":"user","uuid":5}',
    '{"type":"attachment","uuid":"half","rendered":[{"conte', // no newline: still being written
  ].join('\n')
  const log = parseSessionLog({ s: text })
  expect(log.issues.map((i) => [i.kind, i.line])).toEqual([
    ['malformed-json', 2],
    ['not-an-object', 3],
    ['not-an-object', 5],
    // Line 7 twice: no content, and a token count that is not a number.
    ['bad-field', 7],
    ['bad-field', 7],
    ['bad-field', 8],
    ['partial-line', 9],
  ])
  expect(log.calls.map((c) => c.id)).toEqual(['msg1', 'm2'])
  expect(log.calls[1]?.input).toBe(0)

  // A complete record whose newline has not landed yet is read.
  expect(parseSessionLog({ s: prompt('p1', null, 0, 'hi') }).order).toEqual(['p1'])

  // Garbage of every kind: no throw.
  for (const junk of ['\u0000\u0001', '{', '}}}', '{"type":"assistant","uuid":"u","message":{"content":7,"usage":null}}', '"\\', '\n\n\n']) {
    expect(() => snapshotFromLog(parseSessionLog({ s: junk }), { now: 0 })).not.toThrow()
  }
})

test('assumption: the blocks of one response repeat its usage, counted once', () => {
  const log = parseSessionLog({ s: SESSION })
  expect(log.calls.map((c) => c.id)).toEqual(['msg1', 'msg2'])
  expect(log.calls[0]?.output).toBe(300)

  const odd = parseSessionLog({ s: SESSION + reply('a1c', 'a2', 11, 'msg1', { write1h: 9, output: 1 }) })
  expect(odd.calls).toHaveLength(2)
  expect(odd.calls[0]?.output).toBe(300)
  expect(odd.issues.map((i) => i.kind)).toEqual(['usage-mismatch'])
})

test('assumption: output_tokens includes thinking; turns split it out', () => {
  const log = parseSessionLog({ s: SESSION })
  // msg1: 300 output of which 100 thinking; msg2: 50 output, no thinking.
  expect(turnOutputs(log).turns).toEqual([{ output: 250, thinking: 100 }])
  expect(turnOutputs(log).requestsPerTurn).toBe(2)
  // A turn still running (no end_turn, no later prompt) is not finished.
  const running = parseSessionLog({
    s: join(prompt('p1', null, 0, 'go'), reply('a1', 'p1', 5, 'msg1', { output: 10 }, toolUse('t1', 'Bash', { command: 'ls' }), {})).replace(
      '"end_turn"',
      '"tool_use"',
    ),
  })
  expect(turnOutputs(running).turns).toEqual([])
})

test('assumption: <synthetic> messages made no request', () => {
  const text = SESSION + JSON.stringify({
    type: 'assistant',
    uuid: 'err',
    parentUuid: 'p2',
    timestamp: at(21),
    message: { id: 'syn', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'API Error' }], usage: { input_tokens: 0, output_tokens: 0 } },
  })
  expect(parseSessionLog({ s: text }).calls.map((c) => c.id)).toEqual(['msg1', 'msg2'])
})

test('context: anchored on the last request, its output exact, later records estimated', () => {
  const log = parseSessionLog({ s: SESSION })
  const c = analyzeContext(log)
  // 6,102 sent + msg2's 50 output + p2's 5.
  expect(c.contextTokens).toBe(6_157)
  expect(c.basis).toBe('transcript')
  expect(c.anchor).toEqual({ callId: 'msg2', realTokens: 6_102 })
  // No recorded shape: system prompt and tools are msg1's prompt minus p1, unattributed.
  expect(c.breakdown).toEqual({ messages: 1_165, systemTools: 0, mcpTools: 0, skills: 0, systemPrompt: 0, other: 4_992 })
  expect(sumOf(c.breakdown)).toBe(c.contextTokens)
})

test('context: the biggest blocks are named with enough to find them', () => {
  const big = analyzeContext(parseSessionLog({ 'session.jsonl': SESSION })).offenders
  expect(big).toHaveLength(1)
  expect(big[0]).toMatchObject({
    kind: 'file-read',
    tokens: 800,
    label: 'Read',
    filePath: 'src/big.ts',
    toolUseId: 't1',
    where: { source: 'session.jsonl', line: 4, uuid: 'r1' },
  })

  const write = join(
    prompt('p1', null, 0, 'go'),
    reply('a1', 'p1', 5, 'm1', { write1h: 100 }, toolUse('t1', 'Write', { file_path: 'out.txt', content: words(600) })),
    prompt('p2', 'a1', 9, words(2_500)),
  )
  expect(analyzeContext(parseSessionLog({ s: write })).offenders.map((o) => [o.kind, o.label, o.filePath])).toEqual([
    ['paste', 'text', null],
    ['tool-input', 'Write', 'out.txt'],
  ])
})

test('context: a rewound branch is not in the context', () => {
  const text = join(
    prompt('p1', null, 0, words(10)),
    reply('a1', 'p1', 5, 'msg1', { write1h: 1_000 }),
    prompt('abandoned', 'a1', 10, words(5_000)),
    prompt('p3', 'a1', 20, words(7)),
  )
  const log = parseSessionLog({ s: text })
  expect(contextChain(log).map((e) => e.uuid)).toEqual(['p1', 'a1', 'p3'])
  expect(analyzeContext(log).contextTokens).toBe(1_002 + 100 + 7)
})

test('context: a session resumed from another file says the start is missing', () => {
  const text = join(prompt('p9', 'elsewhere', 0, words(3)), reply('a9', 'p9', 5, 'm9', { read: 40_000, output: 10 }))
  const c = analyzeContext(parseSessionLog({ s: text }))
  expect(c.contextTokens).toBe(40_012)
  expect(c.warnings.some((w) => w.includes('not in this log'))).toBe(true)
})

test('context: subagents never count toward the main context', () => {
  const side = JSON.stringify({
    type: 'assistant',
    uuid: 'sa1',
    parentUuid: null,
    timestamp: at(7),
    isSidechain: true,
    agentId: 'agent1',
    message: { id: 'smsg', model: 'claude-haiku-5-5', role: 'assistant', content: [toolUse('st1', 'Grep', { pattern: 'x' })], usage: { input_tokens: 9_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 70 } },
  })
  const log = parseSessionLog({ main: SESSION + side, 'C:/x/subagents/agent-77.jsonl': reply('sb1', 'none', 8, 'smsg2', { write5m: 400 }) })
  expect(analyzeContext(log).contextTokens).toBe(6_157)
  const { report } = snapshotFromLog(log, { now: T0 })
  expect(Object.keys(report.cache.subagents).sort()).toEqual(['agent-77', 'agent1'])
  expect(report.cache.subagents.agent1?.totals.input).toBe(9_000)
  expect(report.cache.totals.input).toBe(4)
  expect(report.models['claude-haiku-5-5']?.input).toBe(9_000)
  expect(report.tools.tools.find((t) => t.name === 'Grep')?.calls).toBe(1)
})

// Compaction: msg1 (prompt 50,002: 49,992 system prompt and tools + p1) →
// p2 (100) → msg2 (prompt 50,304, output 300) → compact (post 2,000, msg2
// preserved) → summary → p3 (20) → later msg3 (prompt 52,012).
const BEFORE_COMPACTION = join(
  prompt('p1', null, 0, words(10)),
  reply('a1', 'p1', 5, 'msg1', { write1h: 50_000, output: 200 }),
  prompt('p2', 'a1', 10, words(100)),
  reply('a2', 'p2', 15, 'msg2', { read: 50_002, write1h: 300, output: 300 }),
)
const COMPACTED = join(
  BEFORE_COMPACTION.trimEnd(),
  boundary('b1', 100, 'a2', 50_604, 2_000, ['a2']),
  summary('s1', 'b1', 101, words(1_500)),
  prompt('p3', 's1', 102, words(20)),
)

test('assumption: the engine counts the context as last request + its output (preTokens)', () => {
  // The boundary records the engine's own count: 50,304 + 300.
  expect(analyzeContext(parseSessionLog({ s: BEFORE_COMPACTION })).contextTokens).toBe(50_604)
})

test('compaction: before the next request, postTokens plus the system prompt and tools carried over', () => {
  const c = analyzeContext(parseSessionLog({ s: COMPACTED }))
  expect(c.basis).toBe('compaction')
  // 2,000 post + 49,992 fixed + p3's 20. The preserved msg2 must not anchor: its request measured 50,304.
  expect(c.contextTokens).toBe(52_012)
  expect(c.breakdown).toEqual({ messages: 2_020, systemTools: 0, mcpTools: 0, skills: 0, systemPrompt: 0, other: 49_992 })
})

test('compaction: the next request anchors again, skipping the preserved response', () => {
  const text = COMPACTED + reply('a3', 'p3', 110, 'msg3', { read: 49_990, write1h: 2_020, output: 100 })
  const c = analyzeContext(parseSessionLog({ s: text }))
  expect(c.anchor).toEqual({ callId: 'msg3', realTokens: 52_012 })
  expect(c.contextTokens).toBe(52_112)
  expect(c.breakdown.other).toBe(49_992)
  expect(c.breakdown.messages).toBe(2_120)
})

test('compaction estimate: saving per request and turn, priced at cache-read rate', () => {
  const big = join(
    prompt('p1', null, 0, words(10)),
    reply('a1', 'p1', 5, 'msg1', { write1h: 20_000, output: 100 }),
    toolResult('r1', 'a1', 6, 'x', words(50_000)),
    reply('a2', 'r1', 9, 'msg2', { read: 20_002, write1h: 50_100, output: 100 }),
  )
  const { report } = snapshotFromLog(parseSessionLog({ s: big }), { now: T0, prices: FAKE })
  const e = report.compaction
  expect(e.summaryFrom).toBe('default')
  expect(e.summaryTokens).toBe(DEFAULT_SUMMARY_TOKENS)
  expect(e.savesTokens).toBe(e.messagesTokens - DEFAULT_SUMMARY_TOKENS)
  near(e.savesUsdPerRequest, usd(e.savesTokens, 0.3))
  expect(e.oneTimeUsd).toBeGreaterThan(0)

  // A session's own compactions set the summary size.
  const { report: own } = snapshotFromLog(parseSessionLog({ s: COMPACTED }), { now: T0, prices: FAKE })
  expect(own.compaction.summaryFrom).toBe('this session')
  expect(own.compaction.summaryTokens).toBe(2_000)
  expect(own.compaction.savesTokens).toBe(20)
})

test('cache: ttl from usage, read and write per request, hit rate', () => {
  const r = trackCache(parseSessionLog({ s: SESSION }), FAKE)
  expect(r.ttlMs).toBe(HOUR_TTL_MS)
  expect(r.ttlFrom).toBe('usage')
  expect(r.requests.map((x) => [x.read, x.write1h])).toEqual([
    [0, 5_000],
    [5_000, 1_100],
  ])
  near(r.hitRate, 5_000 / (4 + 5_000 + 6_100))
  // Sent when the record it answers was written (p1 at 0 s, r1 at 6 s).
  expect(r.requests.map((x) => x.sentAt)).toEqual([T0, T0 + 6_000])
  expect(r.lastReadAt).toBe(T0 + 6_000)
  // Saved: 5,000 read × (3 − 0.3); premium: 6,100 1h-written × (6 − 3).
  near(r.savings?.grossUsd, usd(5_000, 2.7))
  near(r.savings?.writePremiumUsd, usd(6_100, 3))
  near(r.savings?.netUsd, usd(5_000, 2.7) - usd(6_100, 3))
  expect(trackCache(parseSessionLog({ s: SESSION })).savings).toBeNull()
})

// 5-minute writes: msg1 at 0 s, msg2 sent at 400 s (after expiry), msg3 at 500 s.
const EXPIRY = join(
  prompt('p1', null, 0, 'a'),
  reply('a1', 'p1', 2, 'm1', { write5m: 1_000 }),
  prompt('p2', 'a1', 400, 'b'),
  reply('a2', 'p2', 402, 'm2', { write5m: 1_100 }),
  prompt('p3', 'a2', 500, 'c'),
  reply('a3', 'p3', 502, 'm3', { read: 1_100, write5m: 5 }),
)

test('cache: a gap past the ttl is an expiry; a read renews the ttl', () => {
  const log = parseSessionLog({ s: EXPIRY })
  const r = trackCache(log)
  expect(r.ttlMs).toBe(DEFAULT_TTL_MS)
  expect(r.requests.map((x) => [x.gapMs, x.expired])).toEqual([
    [null, false],
    [400_000, true],
    [100_000, false],
  ])
  expect(r.expiries).toBe(1)

  // 200 s after the last use at 500 s, 100 s of the 300 s ttl are left.
  const { snapshot } = snapshotFromLog(log, { now: T0 + 700_000 })
  expect(cacheRemainingMs(snapshot)).toBe(100_000)
  expect(cacheRemainingMs({ ...snapshot, now: T0 + 801_000 })).toBe(0)
})

test('assumption: a request writing both kinds keeps 5 minutes; no split means 5 minutes; no write at all is the default', () => {
  const both = trackCache(parseSessionLog({ s: join(prompt('p', null, 0, 'a'), reply('a', 'p', 1, 'm', { write5m: 10, write1h: 10 })) }))
  expect(both.ttlMs).toBe(DEFAULT_TTL_MS)
  const old = parseSessionLog({ s: join(prompt('p', null, 0, 'a'), reply('a', 'p', 1, 'm', { write5m: 70, noSplit: true })) })
  expect(old.calls[0]?.cacheWrite5m).toBe(70)
  const none = trackCache(parseSessionLog({ s: join(prompt('p', null, 0, 'a'), reply('a', 'p', 1, 'm', { read: 10 })) }))
  expect([none.ttlMs, none.ttlFrom]).toEqual([DEFAULT_TTL_MS, 'default'])
  // A read after a 1h write keeps the hour.
  const keep = trackCache(
    parseSessionLog({ s: join(prompt('p', null, 0, 'a'), reply('a', 'p', 1, 'm', { write1h: 10 }), prompt('q', 'a', 2, 'b'), reply('b', 'q', 3, 'n', { read: 10 })) }),
  )
  expect(keep.ttlMs).toBe(HOUR_TTL_MS)
})

test('assumption: an mcp__server__tool name splits at the first double underscore', () => {
  expect(mcpServer('mcp__ccd_session_mgmt__list_sessions')).toBe('ccd_session_mgmt')
  expect(mcpServer('mcp__plugin-authoring__scan_secrets')).toBe('plugin-authoring')
  expect(mcpServer('mcp__a__b__c')).toBe('a')
  expect(mcpServer('Read')).toBeNull()
})

test('tool audit: definition cost per tool and server, calls, and tools never called', () => {
  const shape = JSON.stringify({
    type: 'api-request-shape',
    shapeHash: 'h1',
    shape: {
      system: [{ type: 'text', text: words(3_000) }],
      tools: [
        { name: 'Read', description: words(500) },
        { name: 'mcp__srv_a__one', description: words(200) },
        { name: 'mcp__srv_a__two', description: words(300) },
      ],
    },
  })
  const text = join(
    shape,
    JSON.stringify({ type: 'api-request', id: 'req1', shapeHash: 'h1', timestamp: at(1) }),
    prompt('p1', null, 0, words(10)),
    attachment('d1', 'p1', 0, 'deferred_tools_delta', words(20), { addedNames: ['WebSearch', 'mcp__late__tool'], removedNames: [] }),
    reply('a1', 'd1', 5, 'msg1', { write1h: 4_100 }, toolUse('t1', 'mcp__srv_a__one', { q: 'x' }), { requestRef: 'req1' }),
    toolResult('r1', 'a1', 6, 't1', words(40)),
  )
  const log = parseSessionLog({ s: text })
  const context = analyzeContext(log)
  expect(context.basis).toBe('request')
  const audit = auditTools(log, context)
  expect(audit.definitionsKnown).toBe(true)
  const one = audit.tools.find((t) => t.name === 'mcp__srv_a__one')
  expect(one).toMatchObject({ server: 'srv_a', calls: 1, resultTokens: 40, isDeferred: false })
  expect(one?.definitionTokens).toBeGreaterThan(0)
  expect(audit.tools.find((t) => t.name === 'WebSearch')).toMatchObject({ isDeferred: true, definitionTokens: null })
  expect(audit.servers.map((s) => [s.server, s.tools, s.calls])).toEqual([
    ['srv_a', 2, 1],
    ['late', 1, 0],
  ])
  // Biggest definition first, then by name.
  expect(audit.neverCalled).toEqual(['Read', 'mcp__srv_a__two', 'mcp__late__tool', 'WebSearch'])

  // The recorded shape splits the fixed part: 3,000 system, 500 built-in, 500 MCP, scaled to the measured 4,072.
  const b = context.breakdown
  expect(sumOf(b)).toBe(context.contextTokens)
  expect(b.systemPrompt).toBeGreaterThan(b.systemTools)
  expect(b.mcpTools).toBeGreaterThan(0)
})

test('snapshot: effort, window and model as the log says, or flagged', () => {
  const { snapshot, report } = snapshotFromLog(parseSessionLog({ s: SESSION.replaceAll('"medium"', '"turbo"') }), { now: T0 })
  expect(snapshot.effort).toBeNull()
  expect(report.assumptions.some((a) => a.startsWith('effort'))).toBe(true)
  expect(snapshot.contextWindow).toBe(200_000)
  expect(snapshotFromLog(parseSessionLog({ s: SESSION }), { now: T0, contextWindow: 1_000_000 }).snapshot.contextWindow).toBe(1_000_000)
  const huge = join(prompt('p1', null, 0, 'a'), reply('a1', 'p1', 1, 'm', { read: 300_000 }))
  expect(snapshotFromLog(parseSessionLog({ s: huge }), { now: T0 }).snapshot.contextWindow).toBe(1_000_000)

  const empty = snapshotFromLog(parseSessionLog({}), { now: T0 })
  expect(empty.snapshot.model).toBe('unknown')
  expect(empty.report.context.basis).toBe('estimate')
})

test('project folders are named by replacing every non-alphanumeric character', () => {
  expect(projectSlug('G:\\Projects\\OptiClaude')).toBe('G--Projects-OptiClaude')
  expect(projectSlug('/home/me/my app')).toBe('-home-me-my-app')
})

// Real logs, sanitized: letters became x and digits 0, so the token
// estimates are those of the originals; ids, times and usage are untouched.

test('real log: a Haiku session, every total equal to the engine own cost-state', () => {
  const log = parseSessionLog({ s: realHaiku })
  expect(log.issues).toEqual([])
  const engine = log.costState?.models['claude-haiku-5-5']
  const calls = log.calls.filter((c) => (c.at ?? 0) >= (log.costState?.startedAt ?? 0))
  const total = (f: (c: (typeof calls)[number]) => number) => calls.reduce((a, c) => a + f(c), 0)
  expect(engine).toBeDefined()
  expect(total((c) => c.output)).toBe(engine?.output as number)
  expect(total((c) => c.thinking)).toBe(engine?.thinking as number)
  expect(total((c) => c.cacheRead)).toBe(engine?.cacheRead as number)
  expect(total((c) => c.cacheWrite5m + c.cacheWrite1h)).toBe(engine?.cacheWrite as number)
  expect(total((c) => c.input)).toBe(engine?.input as number)

  const { snapshot, report } = snapshotFromLog(log, { now: Date.parse('2026-10-26T15:00:00Z') })
  expect(report.context.basis).toBe('request')
  expect(snapshot.model).toBe('claude-haiku-5-5')
  expect(snapshot.cache.ttlMs).toBe(HOUR_TTL_MS)
  expect(snapshot.contextTokens).toBe(69_135)
  expect(sumOf(snapshot.breakdown)).toBe(snapshot.contextTokens)
  expect(snapshot.breakdown.systemPrompt).toBeGreaterThan(5_000)
  expect(snapshot.breakdown.mcpTools).toBeGreaterThan(5_000)
  expect(snapshot.turns).toEqual([{ output: 600, thinking: 396 }])
  expect(report.tools.definitionsKnown).toBe(true)
  expect(report.tools.neverCalled.length).toBeGreaterThan(0)
})

test('real log: context before a compaction equals the engine count; after it, the next request anchors', () => {
  const lines = realCompaction.split('\n')
  const cut = lines.findIndex((l) => l.includes('"compact_boundary"'))
  const pre = JSON.parse(lines[cut] as string).compactMetadata.preTokens as number
  expect(pre).toBe(122_410)
  const before = analyzeContext(parseSessionLog({ s: lines.slice(0, cut).join('\n') }))
  expect(before.contextTokens).toBe(pre)

  const after = analyzeContext(parseSessionLog({ s: realCompaction }))
  expect(after.basis).toBe('request')
  expect(after.anchor?.realTokens).toBe(81_495)
  expect(sumOf(after.breakdown)).toBe(after.contextTokens)
  expect(after.warnings).toEqual([])
})

test('end to end: real log → snapshot → cost, comparison and budget modules', () => {
  const { snapshot } = snapshotFromLog(parseSessionLog({ s: realHaiku }), { now: Date.parse('2026-10-26T14:00:00Z') })
  const e = estimateNextSend(snapshot, 1_000, { prices: FAKE })
  expect(e.model).toBe('claude-haiku-5-5')
  // The session writes 1-hour entries, so a cold send pays the 1-hour rate.
  near(e.cold.inputUsd, usd(snapshot.contextTokens + 1_000, 2))
  expect(e.hasHistory).toBe(true)
  expect(Number.isFinite(e.current.totalUsd?.expected)).toBe(true)
  const rows = compareModels(snapshot, 1_000, { prices: FAKE })
  expect(rows).toHaveLength(15)
  expect(rows.filter((r) => r.isCheapest)).toHaveLength(1)
  expect(budgetAlerts({ session: 1, daily: null, weekly: null }, { session: 0.6, daily: 0, weekly: 0 }, snapshot).map((a) => a.id)).toEqual([
    'budget-session-50',
  ])

  // A model the price table does not list prices to null, never a crash.
  const old = estimateNextSend({ ...snapshot, model: 'claude-opus-5', effort: null }, 1_000, { prices: FAKE, effort: 'high' })
  expect(old.current.totalUsd).toBeNull()
  expect(old.warm.outputTokens).toEqual(estimateNextSend({ ...snapshot, effort: null }, 1_000, { prices: FAKE }).warm.outputTokens)
})
