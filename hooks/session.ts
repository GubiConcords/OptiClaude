import type { SessionSnapshot } from '../types'

/** The seam the session log parser will fill: one call, one snapshot. */
export type SnapshotProvider = () => SessionSnapshot

const NOW = Date.parse('2026-10-26T12:00:00Z')

/** Realistic fake data with a warm cache; override any field to build a case. */
export function stubSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    now: NOW,
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    contextTokens: 62_000,
    contextWindow: 200_000,
    breakdown: { messages: 38_000, systemTools: 11_000, mcpTools: 6_000, skills: 2_000, systemPrompt: 5_000 },
    cache: { lastWriteAt: NOW - 3 * 60_000, lastReadAt: NOW - 90_000, ttlMs: 5 * 60_000 },
    turns: [
      { output: 800, thinking: 1_500 },
      { output: 1_400, thinking: 3_000 },
      { output: 600, thinking: 0 },
      { output: 2_200, thinking: 5_500 },
    ],
    ...overrides,
  }
}

/** A provider that always answers with the stub. */
export const stubProvider: SnapshotProvider = () => stubSnapshot()
