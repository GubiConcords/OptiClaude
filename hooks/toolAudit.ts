import type { ContextAnalysis } from './contextBreakdown'
import { isMcpTool } from './contextBreakdown'
import type { SessionLog } from './logParser'

// What each tool and MCP server costs: its definition, sent with every
// request, and what its calls put into the context (input the model wrote,
// results it read). Definitions come from the last request's recorded shape,
// newer logs only; deferred tools (listed by name, loaded on demand) cost
// only their line in the listing until loaded. Calls by subagents count too.

export type ToolStat = {
  name: string
  /** The MCP server, null for a built-in tool. */
  server: string | null
  calls: number
  inputTokens: number
  resultTokens: number
  /** Tokens of its definition on every request; null when not sent or not recorded. */
  definitionTokens: number | null
  /** Listed by name only, its definition loaded on demand. */
  isDeferred: boolean
}

export type ServerStat = {
  server: string
  tools: number
  calls: number
  definitionTokens: number
  inputTokens: number
  resultTokens: number
}

export type ToolAudit = {
  tools: ToolStat[]
  servers: ServerStat[]
  /** Defined or listed, never called this session; biggest definitions first. */
  neverCalled: string[]
  /** False for older logs: only called and deferred tools are known. */
  definitionsKnown: boolean
}

/**
 * `mcp__<server>__<tool>`. A server name may hold single underscores; one
 * holding a double underscore cannot be told apart and splits at the first.
 */
export function mcpServer(name: string): string | null {
  if (!isMcpTool(name)) {
    return null
  }
  const rest = name.slice('mcp__'.length)
  const cut = rest.indexOf('__')

  return cut > 0 ? rest.slice(0, cut) : rest
}

export function auditTools(log: SessionLog, context: ContextAnalysis): ToolAudit {
  const stats = new Map<string, ToolStat>()
  const stat = (name: string): ToolStat => {
    let s = stats.get(name)
    if (!s) {
      s = { name, server: mcpServer(name), calls: 0, inputTokens: 0, resultTokens: 0, definitionTokens: null, isDeferred: false }
      stats.set(name, s)
    }

    return s
  }

  for (const def of context.toolDefs ?? []) {
    stat(def.name).definitionTokens = def.tokens
  }
  for (const name of log.deferredTools) {
    const s = stat(name)
    s.isDeferred = s.definitionTokens === null
  }

  const results = new Map<string, number>()
  const seen = new Set<string>()
  for (const uuid of log.order) {
    const e = log.entries.get(uuid)
    for (const r of e?.toolResults ?? []) {
      results.set(r.toolUseId, (results.get(r.toolUseId) ?? 0) + r.tokens)
    }
  }
  for (const uuid of log.order) {
    for (const use of log.entries.get(uuid)?.toolUses ?? []) {
      if (use.id && seen.has(use.id)) {
        continue
      }
      seen.add(use.id)
      const s = stat(use.name)
      s.calls++
      s.inputTokens += use.inputTokens
      s.resultTokens += results.get(use.id) ?? 0
    }
  }

  const tools = [...stats.values()].sort(
    (a, b) => b.inputTokens + b.resultTokens + (b.definitionTokens ?? 0) - (a.inputTokens + a.resultTokens + (a.definitionTokens ?? 0)),
  )
  const servers = new Map<string, ServerStat>()
  for (const t of tools) {
    if (t.server === null) {
      continue
    }
    const s = servers.get(t.server) ?? { server: t.server, tools: 0, calls: 0, definitionTokens: 0, inputTokens: 0, resultTokens: 0 }
    s.tools++
    s.calls += t.calls
    s.definitionTokens += t.definitionTokens ?? 0
    s.inputTokens += t.inputTokens
    s.resultTokens += t.resultTokens
    servers.set(t.server, s)
  }

  return {
    tools,
    servers: [...servers.values()].sort((a, b) => b.definitionTokens + b.resultTokens - (a.definitionTokens + a.resultTokens)),
    neverCalled: tools
      .filter((t) => t.calls === 0)
      .sort((a, b) => (b.definitionTokens ?? 0) - (a.definitionTokens ?? 0) || a.name.localeCompare(b.name))
      .map((t) => t.name),
    definitionsKnown: context.toolDefs !== null,
  }
}
