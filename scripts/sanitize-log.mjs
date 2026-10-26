// Turns a slice of a real Claude Code session log into a test fixture.
//
//   node scripts/sanitize-log.mjs <log.jsonl> <first line> <last line> <out.ts> [export name]
//
// Structure, ids, timestamps, usage figures and tool names are kept; every
// letter of free text becomes x, every digit 0, other characters stay. The
// local token counter splits on letters, digits, spaces and symbols, so its
// estimates of the fixture equal those of the original. Image data is dropped
// (an image is counted at a fixed size anyway).
import fs from 'node:fs'

const [file, first, last, out, name = 'fixture'] = process.argv.slice(2)
if (!file || !first || !last || !out) {
  console.error('usage: node scripts/sanitize-log.mjs <log.jsonl> <first line> <last line> <out.ts> [export name]')
  process.exit(1)
}

// Values under these keys are identifiers or enums, not text anyone wrote.
const KEEP = new Set([
  'type', 'subtype', 'role', 'model', 'id', 'uuid', 'parentUuid', 'logicalParentUuid', 'requestId', 'requestRef',
  'messageId', 'shapeHash', 'hash', 'tool_use_id', 'name', 'stop_reason', 'timestamp', 'sessionId', 'version',
  'trigger', 'effort', 'perTurnEffort', 'agentId', 'querySource', 'ttl', 'scope', 'service_tier', 'speed',
  'headUuid', 'anchorUuid', 'tailUuid', 'leafUuid', 'base', 'entrypoint', 'userType', 'level', 'operation',
  'permissionMode', 'promptId', 'sourceToolAssistantUUID', 'sourceToolUseID', 'requestedModel', 'advisorModel',
  'renderedRole', 'media_type', 'inference_geo', 'thinkingDisplay', 'mode',
])
// Lists of names (tools, skills, servers), kept as they are.
const KEEP_LISTS = new Set(['addedNames', 'removedNames', 'names', 'uuids', 'allUuids', 'tail', 'betas', 'preCompactDiscoveredTools'])

const scrub = (s) => s.replace(/[A-Za-z]/g, 'x').replace(/\d/g, '0').replace(/[぀-ヿ㐀-鿿가-힯]/g, '一').replace(/[^\x00-\x7F一]/g, '?')

function walk(v, key) {
  if (typeof v === 'string') {
    return KEEP.has(key) ? v : scrub(v)
  }
  if (Array.isArray(v)) {
    return KEEP_LISTS.has(key) ? v : v.map((x) => walk(x, key))
  }
  if (v && typeof v === 'object') {
    if (v.type === 'base64' && typeof v.data === 'string') {
      return { ...v, data: '' }
    }
    const o = {}
    for (const [k, x] of Object.entries(v)) {
      // Keys that are free text themselves (wireToolInputs keyed by tool id is fine; file-history keyed by path is not).
      o[key === 'trackedFileBackups' ? scrub(k) : k] = walk(x, k)
    }

    return o
  }

  return v
}

const lines = fs.readFileSync(file, 'utf8').split('\n').slice(Number(first) - 1, Number(last))
const kept = lines.filter((l) => l.trim()).map((l) => JSON.stringify(walk(JSON.parse(l), '')))
const text = kept.join('\n') + '\n'
fs.writeFileSync(
  out,
  `// Sanitized slice of a real session log (lines ${first}-${last}), made by scripts/sanitize-log.mjs.\n` +
    `export const ${name} = ${JSON.stringify(text)}\n`,
)
console.log(`${kept.length} records, ${text.length} chars -> ${out}`)
