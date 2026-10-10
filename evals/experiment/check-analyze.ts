import type { CheckCommand } from './check-analysis.ts'
import type { AttemptMetric } from './report.ts'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareCheckStudies, summarizeCheckCommands } from './check-analysis.ts'
import { parseManifest, sha256 } from './manifest.ts'

const [baselineDirectory, candidateDirectory, out] = process.argv.slice(2)
function load(directory: string) {
  const manifestText = readFileSync(join(directory, 'manifest.json'), 'utf8')
  const parsed = parseManifest(JSON.parse(manifestText))
  if (parsed._tag === 'Err')
    throw new Error(parsed.message)
  if (!existsSync(join(directory, 'report.json')) || !existsSync(join(directory, 'report.sha256')))
    throw new Error('Complete both registered studies before comparing. Preserve interrupted evidence separately.')
  const reportText = readFileSync(join(directory, 'report.json'), 'utf8')
  const report = JSON.parse(reportText) as { attempts: AttemptMetric[], manifestHash: string }
  if (sha256(manifestText) !== report.manifestHash)
    throw new Error('The report does not match its frozen manifest.')
  if (sha256(reportText) !== readFileSync(join(directory, 'report.sha256'), 'utf8').trim())
    throw new Error('The recorded report hash does not match.')
  const attempts = report.attempts.map((attempt) => {
    const path = join(directory, `${attempt.task}-${attempt.repeat}-${attempt.mode}`, 'check-commands.jsonl')
    return { ...attempt, commands: existsSync(path) ? summarizeCheckCommands(readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as CheckCommand)) : { _tag: 'Unavailable', reason: 'No command records.' } }
  })
  return { manifest: parsed.value, manifestHash: report.manifestHash, attempts }
}
const baseline = load(baselineDirectory)
const candidate = load(candidateDirectory)
const compared = compareCheckStudies(baseline.manifest, candidate.manifest, baseline.attempts, candidate.attempts)
const result = { baseline, candidate, comparison: compared }
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify(compared, null, 2))
if (compared._tag === 'Err')
  process.exitCode = 1
