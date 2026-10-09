import type { Usage } from './core.ts'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { parseCodexEvents } from './codex-runner.ts'
import { parseEvents } from './core.ts'
import { sha256 } from './experiment/manifest.ts'
import { median } from './experiment/report.ts'

interface Row {
  caseName: string
  runner?: string
  arm: string
  passed: boolean
  seconds: number
  tokens: number
}
interface RawBatch {
  name: string
  saved: string | null
  directory: string
  matched: boolean
}
const sum = (rows: Row[], field: 'seconds' | 'tokens') => rows.reduce((total, row) => total + row[field], 0)
const reduction = (assisted: number, direct: number) => 100 * (1 - assisted / direct)
export function compareHistorical(rows: Row[]) {
  return [...new Set(rows.map(row => row.runner ?? 'opencode'))].map((runner) => {
    const all = rows.filter(row => (row.runner ?? 'opencode') === runner)
    const pairs = [...new Set(all.map(row => row.caseName))].map(name => ({ name, assisted: all.find(row => row.caseName === name && row.arm !== 'agent')!, direct: all.find(row => row.caseName === name && row.arm === 'agent')! }))
    const completed = pairs.filter(pair => pair.assisted?.passed && pair.direct?.passed)
    const assisted = completed.map(pair => pair.assisted)
    const direct = completed.map(pair => pair.direct)
    return { runner, completedPairs: completed.length, allAttempts: all.length, excludedPairs: pairs.filter(pair => !pair.assisted?.passed || !pair.direct?.passed).map(pair => pair.name), summed: { assistedSeconds: sum(assisted, 'seconds'), directSeconds: sum(direct, 'seconds'), assistedTokens: sum(assisted, 'tokens'), directTokens: sum(direct, 'tokens') }, reductionsPercent: { totalTokens: reduction(sum(assisted, 'tokens'), sum(direct, 'tokens')), seconds: reduction(sum(assisted, 'seconds'), sum(direct, 'seconds')), medianTaskTokens: median(completed.map(pair => reduction(pair.assisted.tokens, pair.direct.tokens))), medianTaskSeconds: median(completed.map(pair => reduction(pair.assisted.seconds, pair.direct.seconds))) }, allAttemptResources: { seconds: sum(all, 'seconds'), tokens: sum(all, 'tokens'), assistedSeconds: sum(all.filter(row => row.arm !== 'agent'), 'seconds'), directSeconds: sum(all.filter(row => row.arm === 'agent'), 'seconds') } }
  })
}
export function replayHistorical(batches: RawBatch[], root: string) {
  const evidence: {
    batch: string
    task: string
    runner: string
    arm: string
    sha256: string
    totalTokens: number
    input: number
    cachedInput: number
    output: number
    reasoning: number
    consistent: boolean
  }[] = []
  const comparisons = batches.map((batch) => {
    const rawRows = JSON.parse(readFileSync(join(batch.directory, 'summary.json'), 'utf8')) as Row[]
    const saved = batch.saved
      ? JSON.parse(readFileSync(join(root, batch.saved), 'utf8')) as {
        results: Row[]
      }
      : null
    const rows = saved?.results ?? rawRows
    for (const row of rows) {
      const directory = join(batch.directory, batch.matched ? `${row.caseName}-${row.runner}-${row.arm}` : `${row.caseName}-${row.arm}`)
      const bytes = readFileSync(join(directory, 'events.jsonl'))
      const execution = JSON.parse(readFileSync(join(directory, 'run.json'), 'utf8')) as Row
      const parsed = row.runner === 'codex' ? parseCodexEvents(bytes.toString()) : parseEvents(bytes.toString())
      if (!parsed.usage || parsed.issues.length)
        throw new Error(`Cannot replay exposed usage: ${batch.name}/${row.caseName}/${row.arm}.`)
      const usage: Usage = parsed.usage
      const raw = rawRows.find(raw => raw.caseName === row.caseName && raw.arm === row.arm && raw.runner === row.runner)
      const consistent = usage.total === row.tokens && execution.seconds === row.seconds && execution.passed === row.passed && raw?.tokens === row.tokens && raw.seconds === row.seconds && raw.passed === row.passed
      evidence.push({ batch: batch.name, task: row.caseName, runner: row.runner ?? 'opencode', arm: row.arm, sha256: sha256(bytes), totalTokens: usage.total, input: usage.input, cachedInput: usage.cacheRead, output: usage.output, reasoning: usage.reasoning, consistent })
      if (!consistent)
        throw new Error(`Saved resources disagree with raw evidence: ${batch.name}/${row.caseName}/${row.arm}.`)
    }
    return { batch: batch.name, attempts: rows.length, comparisons: compareHistorical(rows), savedHash: batch.saved ? sha256(readFileSync(join(root, batch.saved))) : null }
  })
  return { method: 'Replay every exposed completion event. Cross-check saved total tokens, seconds, pass state, raw summaries, and run records.', privacy: 'Only derived metrics and transcript hashes are exported. Plaintext native transcripts remain private.', attempts: evidence.length, comparisons, evidence }
}
function main() {
  const { values } = parseArgs({ options: { manifest: { type: 'string' }, out: { type: 'string' } } })
  if (!values.manifest || !values.out)
    throw new Error('Provide --manifest PRIVATE_PATH_MAP --out NEW_RESULT_FILE.')
  const batches = JSON.parse(readFileSync(values.manifest, 'utf8')) as RawBatch[]
  const report = replayHistorical(batches, process.cwd())
  writeFileSync(values.out, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(`${report.attempts} attempts agree with raw evidence.`)
}
if (process.argv[1]?.endsWith('replay-historical.ts'))
  main()
