import { expect, test } from 'claude-code/testing'

import { FS_READ_LIMIT, type Host, logProvider } from '../hooks/session'
import { T0, join, prompt, reply, words } from './fixtures/synthetic'

// The disk side of the provider, against a fake host: a file system, a
// child process that streams a file in pieces, and the session's id and root.

const CONFIG = '/home/me/.claude'
const PROJECTS = `${CONFIG}/projects`
const MAIN = join(prompt('p1', null, 0, words(10)), reply('a1', 'p1', 5, 'msg1', { write1h: 5_000, output: 300 }))

type Files = Record<string, { text: string; size?: number; mtimeMs?: number }>

function fakeHost(files: Files, options: { spawned?: string[][]; exitCode?: number; env?: Record<string, string> } = {}): Host {
  const below = (path: string) => [
    ...new Set(
      Object.keys(files)
        .filter((f) => f.startsWith(`${path}/`))
        .map((f) => f.slice(path.length + 1).split('/')[0] as string),
    ),
  ]
  const file = (path: string) => {
    const f = files[path]
    if (!f) {
      throw new Error(`ENOENT: ${path}`)
    }

    return f
  }
  const host = {
    fs: {
      exists: async (path: string) => path in files || below(path).length > 0,
      stat: async (path: string) => {
        const f = file(path)

        return { kind: 'file' as const, size: f.size ?? f.text.length, mtimeMs: f.mtimeMs ?? 1, isLink: false }
      },
      read: async (path: string) => {
        const f = file(path)
        if ((f.size ?? f.text.length) > FS_READ_LIMIT) {
          throw new Error('over 4 MiB')
        }

        return f.text
      },
      list: async (path: string) => {
        const names = below(path)
        if (names.length === 0) {
          throw new Error(`ENOENT: ${path}`)
        }

        return names.map((name) => ({ name, kind: `${path}/${name}` in files ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false }))
      },
    },
    process: {
      spawn: (request: { argv: readonly string[] }) => {
        options.spawned?.push([...request.argv])
        const text = files[request.argv.at(-1) as string]?.text ?? ''

        return (async function* () {
          // Pieces cut mid-line, as a pipe delivers them.
          for (let i = 0; i < text.length; i += 1_000) {
            yield { stream: 'stdout' as const, text: text.slice(i, i + 1_000) }
          }
          if (options.exitCode) {
            yield { stream: 'stderr' as const, text: 'read error' }
          }

          return { code: options.exitCode ?? 0, signal: null }
        })()
      },
    },
    session: { id: async () => 'sess', root: async () => '/work/my app' },
    clock: { now: async () => T0 + 60_000 },
    env: options.env ? { get: async (name: string) => options.env?.[name] } : undefined,
  }

  return host as unknown as Host
}

test('the provider finds the transcript by project folder and reads it', async () => {
  const read = await logProvider(fakeHost({ [`${PROJECTS}/-work-my-app/sess.jsonl`]: { text: MAIN } }), { configDir: CONFIG }).read()
  expect(read?.snapshot.contextTokens).toBe(5_002 + 300)
  expect(read?.report.issues).toEqual([])
})

test('the config folder comes from the environment when not given', async () => {
  const files = { [`${PROJECTS}/-work-my-app/sess.jsonl`]: { text: MAIN } }
  expect(await logProvider(fakeHost(files, { env: { HOME: '/home/me' } })).read()).not.toBeNull()
  expect(await logProvider(fakeHost(files, { env: { CLAUDE_CONFIG_DIR: CONFIG, HOME: '/nowhere' } })).read()).not.toBeNull()
  // No folder given and no environment to ask: nothing found, no throw.
  expect(await logProvider(fakeHost(files)).read()).toBeNull()
})

test('a transcript in a folder named some other way is still found, with its subagents', async () => {
  const agent = reply('s1', 'none', 3, 'smsg', { write5m: 700, output: 5 })
  const host = fakeHost({
    [`${PROJECTS}/renamed/sess.jsonl`]: { text: MAIN },
    [`${PROJECTS}/renamed/sess/subagents/agent-a1.jsonl`]: { text: agent },
    [`${PROJECTS}/other/x.jsonl`]: { text: '' },
  })
  const read = await logProvider(host, { configDir: CONFIG }).read()
  expect(read?.snapshot.contextTokens).toBe(5_302)
  expect(Object.keys(read?.report.cache.subagents ?? {})).toEqual(['agent-a1'])
})

test('the transcript path the engine gives is used as is', async () => {
  const host = fakeHost({ '/elsewhere/t.jsonl': { text: MAIN }, '/elsewhere/t/subagents/agent-z.jsonl': { text: '' } })
  const read = await logProvider(host, { transcriptPath: '/elsewhere/t.jsonl' }).read()
  expect(read?.snapshot.contextTokens).toBe(5_302)
  expect(read?.report.issues).toEqual([])
})

test('no transcript: null, no throw', async () => {
  expect(await logProvider(fakeHost({}), { configDir: CONFIG }).read()).toBeNull()
})

test('a log over the 4 MiB read limit is streamed through a child process', async () => {
  const spawned: string[][] = []
  const path = `${PROJECTS}/-work-my-app/sess.jsonl`
  const read = await logProvider(fakeHost({ [path]: { text: MAIN, size: FS_READ_LIMIT + 1 } }, { spawned }), { configDir: CONFIG }).read()
  expect(spawned).toEqual([['cat', '--', path]])
  expect(read?.snapshot.contextTokens).toBe(5_302)

  const windows: string[][] = []
  const winPath = 'C:\\Users\\me\\t.jsonl'
  await logProvider(fakeHost({ [winPath]: { text: MAIN, size: FS_READ_LIMIT + 1 } }, { spawned: windows }), { transcriptPath: winPath }).read()
  expect(windows).toEqual([['cmd', '/d', '/c', 'type', winPath]])
})

test('a streaming read that fails is reported, not taken as the whole log', async () => {
  const host = fakeHost({ [`${PROJECTS}/-work-my-app/sess.jsonl`]: { text: MAIN, size: FS_READ_LIMIT + 1 } }, { exitCode: 1 })
  const read = await logProvider(host, { configDir: CONFIG }).read()
  expect(read?.report.issues.some((i) => i.detail.includes('could not read') && i.detail.includes('read error'))).toBe(true)
})

test('the log is read again only when it changed', async () => {
  const path = `${PROJECTS}/-work-my-app/sess.jsonl`
  const files: Files = { [path]: { text: MAIN, mtimeMs: 1 } }
  const provider = logProvider(fakeHost(files), { configDir: CONFIG })
  expect((await provider.read())?.snapshot.turns).toHaveLength(1)
  // Same size and time: the cached parse stands even though the text differs.
  files[path] = { text: MAIN.replace('"end_turn"', '"tool_use"'), mtimeMs: 1, size: MAIN.length }
  expect((await provider.read())?.snapshot.turns).toHaveLength(1)
  files[path] = { text: MAIN.replace('"end_turn"', '"tool_use"'), mtimeMs: 2 }
  expect((await provider.read())?.snapshot.turns).toHaveLength(0)
})
