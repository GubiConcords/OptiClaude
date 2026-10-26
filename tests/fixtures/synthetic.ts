// Builders for synthetic session-log records, shaped like Claude Code's own
// (see the real samples beside this file). Each returns one JSON line.

export const T0 = Date.parse('2026-10-26T10:00:00Z')

export const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString()

type Usage = {
  input?: number
  read?: number
  write5m?: number
  write1h?: number
  output?: number
  thinking?: number
  /** Leave out `cache_creation`, as older logs do. */
  noSplit?: boolean
}

export function usage(u: Usage) {
  const write = (u.write5m ?? 0) + (u.write1h ?? 0)

  return {
    input_tokens: u.input ?? 2,
    cache_creation_input_tokens: write,
    cache_read_input_tokens: u.read ?? 0,
    output_tokens: u.output ?? 100,
    output_tokens_details: { thinking_tokens: u.thinking ?? 0 },
    ...(u.noSplit ? {} : { cache_creation: { ephemeral_5m_input_tokens: u.write5m ?? 0, ephemeral_1h_input_tokens: u.write1h ?? 0 } }),
  }
}

const line = (r: object) => JSON.stringify(r)

export function prompt(uuid: string, parent: string | null, s: number, text: string, extra: object = {}) {
  return line({ type: 'user', uuid, parentUuid: parent, timestamp: at(s), isSidechain: false, message: { role: 'user', content: text }, ...extra })
}

/** One content block of an assistant response; blocks of one response share `msgId` and usage. */
export function reply(
  uuid: string,
  parent: string,
  s: number,
  msgId: string,
  u: Usage,
  block: object = { type: 'text', text: 'Done.' },
  extra: object = {},
) {
  return line({
    type: 'assistant',
    uuid,
    parentUuid: parent,
    timestamp: at(s),
    isSidechain: false,
    effort: 'medium',
    message: { id: msgId, model: 'claude-sonnet-5-5', role: 'assistant', content: [block], stop_reason: 'end_turn', usage: usage(u) },
    ...extra,
  })
}

export const toolUse = (id: string, name: string, input: object) => ({ type: 'tool_use', id, name, input })

export function toolResult(uuid: string, parent: string, s: number, toolUseId: string, content: string) {
  return line({
    type: 'user',
    uuid,
    parentUuid: parent,
    timestamp: at(s),
    isSidechain: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  })
}

export function attachment(uuid: string, parent: string, s: number, type: string, rendered: string | null, extra: object = {}) {
  return line({
    type: 'attachment',
    uuid,
    parentUuid: parent,
    timestamp: at(s),
    isSidechain: false,
    attachment: { type, ...extra },
    rendered: rendered === null ? [] : [{ content: rendered }],
  })
}

export function boundary(uuid: string, s: number, logicalParent: string, pre: number, post: number, preserved: string[] = []) {
  return line({
    type: 'system',
    subtype: 'compact_boundary',
    uuid,
    parentUuid: null,
    logicalParentUuid: logicalParent,
    timestamp: at(s),
    compactMetadata: { trigger: 'manual', preTokens: pre, postTokens: post, preservedMessages: { uuids: preserved } },
  })
}

export function summary(uuid: string, parent: string, s: number, text: string) {
  return line({
    type: 'user',
    uuid,
    parentUuid: parent,
    timestamp: at(s),
    isSidechain: false,
    isCompactSummary: true,
    message: { role: 'user', content: text },
  })
}

/** A text of roughly `tokens` tokens by the local counter (one 4-letter word is one token). */
export const words = (tokens: number) => 'word '.repeat(tokens).trim()

export const join = (...lines: string[]) => lines.join('\n') + '\n'
