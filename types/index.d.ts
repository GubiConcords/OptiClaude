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

export type ModelId = 'claude-haiku-5-5' | 'claude-sonnet-5-5' | 'claude-opus-5-5'

/**
 * Where the context tokens go, in tokens. The five named categories plus
 * `other` add up to `SessionSnapshot.contextTokens`.
 */
export type ContextBreakdown = {
  messages: number
  systemTools: number
  mcpTools: number
  skills: number
  systemPrompt: number
  /**
   * What the log cannot attribute: older logs record no system prompt or tool
   * definitions, so their share of the real total lands here instead of
   * being guessed into a category.
   */
  other: number
}

/**
 * Output tokens of one finished turn, split. The API's `output_tokens`
 * already includes thinking, so `output` here is the non-thinking part and
 * `output + thinking` is what was billed as output.
 */
export type TurnOutput = { output: number; thinking: number }

/** Everything the estimators need from a session, filled by the session log parser. */
export type SessionSnapshot = {
  /** Epoch ms the snapshot was taken, so the estimators stay pure. */
  now: number
  /** The main loop's last model as the log spells it; may be one the price table does not know. */
  model: ModelId | (string & {})
  /** Null when the log does not say. */
  effort: Effort | null
  contextTokens: number
  contextWindow: number
  breakdown: ContextBreakdown
  cache: {
    /** Epoch ms of the last cache write and read, null when none happened. */
    lastWriteAt: number | null
    lastReadAt: number | null
    ttlMs: number
  }
  /** Oldest first. */
  turns: TurnOutput[]
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
      shareAlert: number
      dismissedTips: string[]
      copyNote: string
      showHistory: boolean
      armed: Advice | null
      lastModel: string | null
      calibration: Calibration
      stats: Stats
      tick: number
    }
  }
}
