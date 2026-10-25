export type Tier = 'trivial' | 'moderate' | 'heavy'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type Advice = {
  tier: Tier
  model: string
  modelLabel: string
  effort: Effort
  reason: string
  /** Expected tokens for the whole turn (input re-reads + output), low to high. */
  turnLow: number
  turnHigh: number
}

/** Learned averages per tier: whole-turn tokens and the rise of the session limit in percent points. */
export type Calibration = Record<Tier, { tokens: number; percent: number; n: number }>

/** What the session has spent, gathered from turn and tool events at no cost. */
export type Stats = {
  /** The last finished main-loop turn. */
  turn: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    usd: number
    tools: number
    agents: number
  } | null
  /** Tool calls and subagents of the turn running now. */
  live: { tools: number; agents: number }
  sessionTokens: number
  sessionOutput: number
  /** Tokens per model id, subagents included. */
  models: Record<string, number>
  /** The largest tool results this session, by estimated tokens. */
  bigTools: { name: string; tokens: number }[]
  /** When the last model response came back, for the cache countdown. */
  lastCallAt: number | null
  /** The first session-limit reading of this window, for the burn rate. */
  burnFrom: { at: number; percent: number } | null
}

declare module 'claude-code' {
  interface PluginState {
    opticlaude: {
      draft: string
      scratch: string
      isAuto: boolean
      armed: Advice | null
      lastModel: string | null
      calibration: Calibration
      stats: Stats
      tick: number
    }
  }
}
