import { countTokens } from './estimate'

export type TipSeverity = 'info' | 'warn'

export type Tip = { id: string; severity: TipSeverity; message: string }

export type TipOptions = {
  /** A prompt this many tokens or more counts as a pasted blob. */
  blobTokens?: number
  /** List items from which a prompt counts as many tasks. */
  manyTasks?: number
}

export const DEFAULT_BLOB_TOKENS = 2_000
export const DEFAULT_MANY_TASKS = 4

const PATH = /(?:[\w.-]+[\\/])+[\w.-]+|\b[\w-]+\.[a-z]{1,5}\b/i
const ACTION = /\b(fix|refactor|update|change|add|implement|rename|debug|remove|move|rewrite|optimi[sz]e)\b/i
const VAGUE = /\b(make it (better|nicer|good|work)|fix (it|this|that|things)|improve (it|this|that)|clean (it|this) up|do (it|something))\b/i
const ITEM = /^\s*(?:[-*]|\d+[.)])\s+\S/gm

/** Cheap heuristics for the Measure box; nothing here calls a model. */
export function promptTips(text: string, options: TipOptions = {}): Tip[] {
  const draft = text.trim()
  if (draft.length === 0) {
    return []
  }
  const blobTokens = options.blobTokens ?? DEFAULT_BLOB_TOKENS
  const manyTasks = options.manyTasks ?? DEFAULT_MANY_TASKS
  const tokens = countTokens(draft)
  const words = draft.split(/\s+/).length
  const tips: Tip[] = []

  if (tokens >= blobTokens) {
    tips.push({
      id: 'large-paste',
      severity: 'warn',
      message: `~${tokens} tokens pasted: point at a file path or trim it to the relevant part`,
    })
  }
  if (words >= 4 && ACTION.test(draft) && !PATH.test(draft)) {
    tips.push({ id: 'no-file-path', severity: 'info', message: 'No file path named: Claude may search the repo to find where to work' })
  }
  if (words < 4 || VAGUE.test(draft)) {
    tips.push({ id: 'vague-prompt', severity: 'info', message: 'Vague prompt: say what to change, where, and how you will know it worked' })
  }
  if ((draft.match(ITEM)?.length ?? 0) >= manyTasks) {
    tips.push({
      id: 'many-tasks',
      severity: 'info',
      message: 'Several tasks in one prompt: separate prompts keep context smaller and results easier to check',
    })
  }

  return tips
}
