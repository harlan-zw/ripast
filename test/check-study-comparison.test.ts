import type { Manifest } from '../evals/experiment/manifest.ts'
import type { AttemptMetric } from '../evals/experiment/report.ts'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareCheckStudies, parseManifest, sha256 } from '../evals/experiment/index.ts'

function fixture() {
  const parsed = parseManifest({
    id: 'comparison',
    study: 'pilot',
    pilotHash: null,
    seed: 42,
    repeats: 2,
    cache: 'uncontrolled',
    timeoutMs: 1000,
    repairs: 1,
    commonInstructions: 'Repair the named function.',
    artifacts: [],
    versions: [],
    tracing: 'strace',
    runners: Object.fromEntries(['direct', 'forced', 'hybrid'].map(mode => [mode, { model: 'scripted', reasoning: 'none', command: ['node', 'runner.ts'] }])),
    tasks: [{ id: 'repair', cohort: 'mixed', operation: 'repair', prompt: 'Repair.', source: { files: { 'src.ts': 'export const answer = 0' } }, expected: { 'src.ts': 'export const answer = 1' }, generatedDirectories: [], setup: [], checks: [], symbols: [], qualityGates: [] }],
  })
  if (parsed._tag === 'Err')
    throw new Error(parsed.message)
  return parsed.value
}
function attempts(manifest: Manifest): AttemptMetric[] {
  return manifest.tasks.flatMap(task => Array.from({ length: manifest.repeats }, (_, repeat) => ['direct', 'forced', 'hybrid'].map(mode => ({
    task: task.id,
    mode: mode as AttemptMetric['mode'],
    cohort: task.cohort,
    repeat,
    attempt: 0,
    quality: 'passed' as const,
    seconds: 10,
    usage: { _tag: 'Unavailable' as const, reason: 'No model usage.' },
  })))).flat()
}
describe('complete check study comparisons', () => {
  it('refuses interrupted checkpoints even when they contain every attempt', () => {
    const manifest = fixture()
    const root = mkdtempSync(join(tmpdir(), 'check-aborted-comparison-'))
    const input = join(root, 'input')
    mkdirSync(input)
    const text = `${JSON.stringify(manifest)}\n`
    writeFileSync(join(input, 'manifest.json'), text)
    writeFileSync(join(input, 'abort-checkpoint.json'), JSON.stringify({ manifestHash: sha256(text), attempts: attempts(manifest) }))
    const result = spawnSync(process.execPath, [join(process.cwd(), 'evals/experiment/check-analyze.ts'), input, input, join(root, 'comparison.json')], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Complete both registered studies before comparing.')
  })
  it.each(['baseline', 'candidate'])('refuses an empty %s instead of reporting zero pairs', (side) => {
    const manifest = fixture()
    const rows = attempts(manifest)
    expect(compareCheckStudies(manifest, manifest, side === 'baseline' ? [] : rows, side === 'candidate' ? [] : rows)).toMatchObject({ _tag: 'Err' })
  })
  it('refuses a missing repeat while retaining failed workflows in complete comparisons', () => {
    const manifest = fixture()
    const rows = attempts(manifest)
    expect(compareCheckStudies(manifest, manifest, rows, rows.slice(1))).toMatchObject({ _tag: 'Err' })
    const candidate = rows.map((row, index) => index === 0 ? { ...row, quality: 'failed' as const, seconds: 1 } : row)
    expect(compareCheckStudies(manifest, manifest, rows, candidate)).toMatchObject({ _tag: 'Ok', value: { decision: 'Reject' } })
  })
  it.each(['duplicate', 'unknown-task', 'unknown-mode', 'repeat', 'attempt-gap', 'over-budget'])('refuses invalid %s evidence', (kind) => {
    const manifest = fixture()
    const rows = attempts(manifest)
    const invalid = [...rows]
    if (kind === 'duplicate')
      invalid.push(rows[0])
    else
      invalid[0] = { ...rows[0], ...(kind === 'unknown-task' ? { task: 'other' } : kind === 'unknown-mode' ? { mode: 'other' as AttemptMetric['mode'] } : kind === 'repeat' ? { repeat: manifest.repeats } : { attempt: kind === 'attempt-gap' ? 1 : 2 }) }
    expect(compareCheckStudies(manifest, manifest, rows, invalid)).toMatchObject({ _tag: 'Err' })
  })
  it('orders repairs by attempt and includes failed repair costs', () => {
    const manifest = fixture()
    const before = attempts(manifest)
    const candidate = [{ ...before[0], attempt: 1, quality: 'passed' as const, seconds: 2 }, ...before.map((row, index) => index === 0 ? { ...row, quality: 'failed' as const, seconds: 3 } : row)]
    const result = compareCheckStudies(manifest, manifest, before, candidate)
    expect(result).toMatchObject({ _tag: 'Ok', value: { decision: 'Investigate' } })
    if (result._tag === 'Ok')
      expect(result.value.comparisons.find(row => row.mode === 'direct')).toMatchObject({ completedPairs: 2, candidatePassed: 2, medianPreparedSecondsChange: -2.5 })
  })
})
