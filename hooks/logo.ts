// The OPTICLAUDE wordmark: a 5-row pixel font in red with a dark-red drop to
// the right of every cell, a bar under it and the tagline, as one SVG.

const GLYPHS: Record<string, string[]> = {
  O: ['.##.', '#..#', '#..#', '#..#', '.##.'],
  P: ['###.', '#..#', '###.', '#...', '#...'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  I: ['#', '#', '#', '#', '#'],
  C: ['.###', '#...', '#...', '#...', '.###'],
  L: ['#..', '#..', '#..', '#..', '###'],
  A: ['.##.', '#..#', '####', '#..#', '#..#'],
  U: ['#..#', '#..#', '#..#', '#..#', '.##.'],
  D: ['###.', '#..#', '#..#', '#..#', '###.'],
  E: ['####', '#...', '###.', '#...', '####'],
}

const RED = '#ff4545'
const SHADE = '#a83a3a'
const CELL = 6
const DROP = 2

function wordmark(): string {
  const shades: string[] = []
  const cells: string[] = []
  let x = 0
  for (const letter of 'OPTICLAUDE') {
    const rows = GLYPHS[letter] ?? []
    rows.forEach((row, y) => {
      for (let i = 0; i < row.length; i += 1) {
        if (row[i] === '#') {
          const px = (x + i) * CELL
          shades.push(`<rect x="${px + DROP}" y="${y * CELL}" width="${CELL}" height="${CELL}"/>`)
          cells.push(`<rect x="${px}" y="${y * CELL}" width="${CELL}" height="${CELL}"/>`)
        }
      }
    })
    x += (rows[0]?.length ?? 0) + 1
  }
  const width = (x - 1) * CELL
  const barY = 6 * CELL
  shades.push(`<rect x="${DROP}" y="${barY}" width="${width}" height="${CELL}"/>`)
  cells.push(`<rect x="0" y="${barY}" width="${width}" height="${CELL}"/>`)
  const height = barY + CELL + 16

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width + DROP} ${height}" ` +
    `width="${width + DROP}" height="${height}" shape-rendering="crispEdges">` +
    `<g fill="${SHADE}">${shades.join('')}</g>` +
    `<g fill="${RED}">${cells.join('')}</g>` +
    `<text x="${width + DROP}" y="${height - 2}" text-anchor="end" ` +
    `font-family="ui-monospace, Consolas, monospace" font-size="10" fill="#9a9a9a">unbeatable efficiency</text>` +
    `</svg>`
  )
}

export const LOGO_SVG = wordmark()

/** A bar for a percentage, like the usage panel's. */
export function barSvg(percent: number, width: number, color = '#3b82f6'): string {
  const fill = Math.max(0, Math.min(100, percent)) / 100 * width

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 4" width="${width}" height="4">` +
    `<rect width="${width}" height="4" rx="2" fill="#80808040"/>` +
    `<rect width="${fill.toFixed(1)}" height="4" rx="2" fill="${color}"/>` +
    `</svg>`
  )
}
