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

declare module 'claude-code' {
  interface PluginState {
    opticlaude: {
      draft: string
      scratch: string
      isAuto: boolean
      armed: Advice | null
      lastModel: string | null
      calibration: Calibration
    }
  }
}
