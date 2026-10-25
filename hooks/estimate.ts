import type { Advice, Tier } from '../types'

// Everything here runs locally: no model call, no token-count API, so it costs
// zero tokens. The figures are estimates, marked with ≈ wherever drawn.

const PIECE = /[A-Za-z]+|\d+|\s+|[぀-ヿ㐀-鿿가-힯]|[^\sA-Za-z\d]/g

/** Approximates Claude's tokenizer: ~4 characters per English token, denser for code and symbols. */
export function countTokens(text: string): number {
  if (text.length === 0) {
    return 0
  }
  let tokens = 0
  for (const [piece] of text.matchAll(PIECE)) {
    if (/^[A-Za-z]/.test(piece)) {
      tokens += Math.max(1, Math.ceil(piece.length / 4.5))
    } else if (/^\d/.test(piece)) {
      tokens += Math.ceil(piece.length / 3)
    } else if (/^\s/.test(piece)) {
      // A single space merges into the next word; runs of indentation or
      // blank lines cost a token or so each.
      tokens += piece.length > 1 ? Math.ceil(piece.length / 4) : 0
    } else {
      tokens += 1
    }
  }

  return tokens
}

type Rule = { tier: Tier; weight: number; pattern: RegExp; why: string }

const RULES: Rule[] = [
  { tier: 'trivial', weight: 3, pattern: /\b(typos?|spelling|misspell\w*|grammar)\b/i, why: 'spelling or typo fix' },
  { tier: 'trivial', weight: 3, pattern: /\b(rename|reformat|format|lint|prettier|indent\w*|whitespace)\b/i, why: 'mechanical formatting or rename' },
  { tier: 'trivial', weight: 2, pattern: /\b(add|update|remove|fix)\s+(a\s+)?(comments?|docstrings?|imports?|log(ging)?\s+line)\b/i, why: 'small, local edit' },
  { tier: 'trivial', weight: 2, pattern: /\b(bump|change)\s+(the\s+)?(version|color|colour|text|label|string|constant)\b/i, why: 'one-value change' },
  { tier: 'trivial', weight: 2, pattern: /^(what|where|which|how do i|is there)\b.{0,80}\?$/i, why: 'short lookup question' },
  { tier: 'trivial', weight: 1, pattern: /\b(translate|summari[sz]e|list)\b/i, why: 'simple transform or summary' },

  { tier: 'moderate', weight: 2, pattern: /\b(fix|debug)\b.{0,40}\b(bug|error|crash|exception|failing|test)\b/i, why: 'focused bug fix' },
  { tier: 'moderate', weight: 2, pattern: /\b(write|add|create)\s+(a\s+)?(unit\s+)?tests?\b/i, why: 'writing tests' },
  { tier: 'moderate', weight: 2, pattern: /\b(implement|add|write|create)\s+(a\s+)?(function|method|endpoint|component|hook|script|class)\b/i, why: 'one self-contained piece of code' },
  { tier: 'moderate', weight: 1, pattern: /\b(refactor|clean\s*up|explain|review)\b/i, why: 'refactor, review or explanation' },

  { tier: 'heavy', weight: 3, pattern: /\b(architect\w*|design\s+(a|the)\s+system|from\s+scratch|end[-\s]to[-\s]end)\b/i, why: 'architecture or greenfield build' },
  { tier: 'heavy', weight: 3, pattern: /\b(migrat\w+|port\s+(the|this|it)|rewrite\s+(the|all|entire))\b/i, why: 'migration or large rewrite' },
  { tier: 'heavy', weight: 2, pattern: /\b(race\s+condition|deadlock|memory\s+leak|concurren\w+|performance|optimi[sz]\w+|security|vulnerab\w+)\b/i, why: 'hard, cross-cutting problem' },
  { tier: 'heavy', weight: 2, pattern: /\b(whole|entire|across\s+(the\s+)?(codebase|repo|project)|every\s+file|all\s+(the\s+)?(files|modules|services))\b/i, why: 'touches the whole codebase' },
  { tier: 'heavy', weight: 2, pattern: /\b(plan|investigate|research|figure\s+out\s+why|root\s+cause)\b/i, why: 'open-ended investigation' },
  { tier: 'heavy', weight: 1, pattern: /\b(build|make)\s+(a|an|me\s+a)\s+(app|mod|plugin|extension|game|website|service|tool)\b/i, why: 'building a whole program' },
]

// "Fix all typos" mentions "all", but stays trivial: a mechanical sweep.
const SWEEP = /\b(typos?|spelling|format\w*|lint|rename|whitespace|indent\w*)\b/i

const MODELS: Record<Tier, Pick<Advice, 'model' | 'modelLabel' | 'effort' | 'turnLow' | 'turnHigh'>> = {
  trivial: { model: 'claude-haiku-5-5', modelLabel: 'Haiku 5.5', effort: 'low', turnLow: 2_000, turnHigh: 15_000 },
  moderate: { model: 'claude-sonnet-5-5', modelLabel: 'Sonnet 5.5', effort: 'medium', turnLow: 15_000, turnHigh: 80_000 },
  heavy: { model: 'claude-opus-5-5', modelLabel: 'Opus 5.5', effort: 'high', turnLow: 60_000, turnHigh: 400_000 },
}

/** Picks a model and effort for a draft from keywords, length and how much code it names. */
export function advise(text: string): Advice | null {
  const draft = text.trim()
  if (draft.length === 0) {
    return null
  }
  const score: Record<Tier, number> = { trivial: 0, moderate: 0, heavy: 0 }
  const reasons: Record<Tier, string[]> = { trivial: [], moderate: [], heavy: [] }
  for (const rule of RULES) {
    if (rule.pattern.test(draft)) {
      score[rule.tier] += rule.weight
      reasons[rule.tier].push(rule.why)
    }
  }

  const tokens = countTokens(draft)
  const files = draft.match(/[\w./\\-]+\.[a-z]{1,5}\b/gi)?.length ?? 0
  if (tokens > 400) {
    score.heavy += 2
    reasons.heavy.push('long, detailed prompt')
  } else if (tokens > 120) {
    score.moderate += 1
  } else if (tokens < 25 && score.heavy === 0) {
    score.trivial += 1
  }
  if (files >= 4) {
    score.heavy += 1
    reasons.heavy.push(`${files} files named`)
  }
  if (SWEEP.test(draft) && score.trivial >= score.heavy) {
    score.heavy = Math.max(0, score.heavy - 2)
  }

  const tier: Tier =
    score.heavy > score.moderate && score.heavy >= score.trivial
      ? 'heavy'
      : score.trivial > score.moderate && score.trivial >= score.heavy
        ? 'trivial'
        : 'moderate'
  const best = MODELS[tier]
  const effort =
    tier === 'heavy' && score.heavy >= 6 ? 'xhigh' : tier === 'moderate' && score.moderate === 0 ? 'low' : best.effort

  return {
    tier,
    ...best,
    effort,
    reason: reasons[tier][0] ?? (tier === 'moderate' ? 'ordinary coding task' : 'short prompt'),
  }
}

/** 48213 → "48.2k". */
export function compact(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`
  }
  if (n >= 10_000) {
    return `${Math.round(n / 1000)}k`
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}k`
  }

  return String(n)
}
