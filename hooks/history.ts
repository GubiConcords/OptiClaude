// History view helpers: plain string and total builders over the stored turn spend.
// No model, network or logic module is involved.

export type SpendEntry = { at: number; session: string; usd: number }

export type SessionTotal = { session: string; first: number; last: number; turns: number; usd: number }

/** Each session's spend, in the order the sessions first appeared. */
export function sessionTotals(entries: SpendEntry[]): SessionTotal[] {
  const bySession = new Map<string, SessionTotal>()
  for (const entry of entries) {
    const total = bySession.get(entry.session)
    if (total) {
      total.last = Math.max(total.last, entry.at)
      total.turns += 1
      total.usd += entry.usd
    } else {
      bySession.set(entry.session, { session: entry.session, first: entry.at, last: entry.at, turns: 1, usd: entry.usd })
    }
  }

  return [...bySession.values()]
}

/** One CSV row per session: id, first and last activity in ISO time, turns, and USD to four places. */
export function sessionCsv(entries: SpendEntry[]): string {
  const rows = sessionTotals(entries).map(total =>
    [
      JSON.stringify(total.session),
      new Date(total.first).toISOString(),
      new Date(total.last).toISOString(),
      String(total.turns),
      total.usd.toFixed(4),
    ].join(','),
  )

  return ['session,started,last_activity,turns,usd', ...rows].join('\n')
}

/** Cumulative spend as a line over time, as an SVG; x is the time between the first and last turn. */
export function costSeriesSvg(entries: SpendEntry[], width: number, height: number, color = '#3b82f6'): string {
  const sorted = [...entries].sort((a, b) => a.at - b.at)
  const first = sorted[0]?.at ?? 0
  const span = Math.max(1, (sorted.at(-1)?.at ?? first) - first)
  let running = 0
  const points = sorted.map(entry => {
    running += entry.usd

    return { x: ((entry.at - first) / span) * width, total: running }
  })
  const top = Math.max(running, 1e-9)
  const coords = points
    .map(p => `${p.x.toFixed(1)},${(height - 2 - (p.total / top) * (height - 4)).toFixed(1)}`)
    .join(' ')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<polyline points="${coords}" fill="none" stroke="${color}" stroke-width="2"/>` +
    `</svg>`
  )
}
