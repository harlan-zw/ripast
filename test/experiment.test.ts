import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { aggregateAttempts, buildSchedule, checkChangedVerifiedPlan, combineUsage, freezeManifest, gradeProject, pairAttempts, parseManifest, parseUsage, recordCommand, verifyFrozenManifest } from '../evals/experiment/index.ts'

function fixture() {
  return {
    id: 'fixture',
    study: 'pilot',
    pilotHash: null,
    seed: 42,
    repeats: 6,
    cache: 'uncontrolled',
    timeoutMs: 10000,
    repairs: 1,
    commonInstructions: 'Preserve unrelated source.',
    artifacts: [],
    versions: [],
    tracing: 'strace',
    runners: { direct: { model: 'scripted', reasoning: 'none', command: [process.execPath, '{runner}'] }, forced: { model: 'scripted', reasoning: 'none', command: [process.execPath, '{runner}'] }, hybrid: { model: 'scripted', reasoning: 'none', command: [process.execPath, '{runner}'] } },
    tasks: [{ id: 'rename', cohort: 'mechanical', operation: 'rename', prompt: 'Rename old to next.', source: { files: { 'src.ts': 'export const old = 1\n' } }, expected: { 'src.ts': 'export const next = 1\n' }, generatedDirectories: [], setup: [], checks: [], symbols: [], qualityGates: [] }],
  }
}
describe('registered experiments', () => {
  it('counterbalances every mode in each serial position', () => {
    const parsed = parseManifest(fixture())
    if (parsed._tag !== 'Ok')
      throw new Error(parsed.message)
    const schedule = buildSchedule(parsed.value)
    expect(schedule.filter(r => r.mode === 'direct').map(r => r.position).sort()).toEqual([0, 0, 1, 1, 2, 2])
    expect(new Set(schedule.map(r => `${r.repeat}:${r.mode}`)).size).toBe(18)
  })
  it('refuses held-out runs without a frozen pilot analysis', () => {
    expect(parseManifest({ ...fixture(), study: 'held-out' })).toMatchObject({ _tag: 'Err' })
  })
  it('detects changed preregistration before execution', () => {
    const dir = mkdtempSync(join(tmpdir(), 'experiment-freeze-'))
    const parsed = parseManifest(fixture())
    if (parsed._tag !== 'Ok')
      throw new Error(parsed.message)
    const frozen = freezeManifest(parsed.value, dir)
    chmodSync(frozen.path, 0o600)
    writeFileSync(frozen.path, '{}\n')
    expect(verifyFrozenManifest(frozen)).toMatchObject({ _tag: 'Err' })
  })
  it('records complete streams and a failing child exit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'experiment-record-'))
    const script = join(dir, 'child.ts')
    writeFileSync(script, 'process.stdout.write("x".repeat(200000)); process.stderr.write("failure"); process.exitCode = 17\n')
    const result = await recordCommand({ command: [process.execPath, script], cwd: dir, directory: join(dir, 'record'), phase: 'mechanical', role: 'arm', timeoutMs: 10000, tracing: 'strace' })
    expect(result.exit).toEqual({ _tag: 'Exited', code: 17 })
    expect(readFileSync(result.stdout.path).length).toBe(200000)
    expect(readFileSync(result.stderr.path, 'utf8')).toBe('failure')
    expect(result.processTrace._tag).toBe('Recorded')
  })
  it('rejects changed comments, unrelated bindings, and non-source files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'experiment-grade-'))
    writeFileSync(join(dir, 'src.ts'), 'export const next = 1 // changed\nfunction unrelated(){const next=2;return next}\n')
    writeFileSync(join(dir, 'notes.txt'), 'changed')
    const expected = { 'src.ts': 'export const next = 1 // old\nfunction unrelated(){const old=2;return old}\n', 'notes.txt': 'original' }
    expect(gradeProject(dir, expected, [], [])._tag).toBe('Failed')
  })
  it('retains failed and repair cost rather than counting only successful attempts', () => {
    const rows = [{ task: 'one', mode: 'direct' as const, cohort: 'mechanical' as const, repeat: 0, attempt: 0, quality: 'failed' as const, seconds: 10, usage: { _tag: 'Unavailable' as const, reason: 'No provider event in this fixture.' } }, { task: 'one', mode: 'direct' as const, cohort: 'mechanical' as const, repeat: 0, attempt: 1, quality: 'passed' as const, seconds: 5, usage: { _tag: 'Unavailable' as const, reason: 'No provider event in this fixture.' } }]
    expect(aggregateAttempts(rows, 42)[0]).toMatchObject({ attempts: 2, failures: 1, repairs: 1, totalSeconds: 15, completedWorkflows: 1, charges: { _tag: 'Unavailable' } })
  })
  it('rejects a reference to a same-named unrelated binding', () => {
    const dir = mkdtempSync(join(tmpdir(), 'experiment-symbol-'))
    const files = { 'api.ts': 'export const next = 1\n', 'consumer.ts': 'import { next } from "./api"\nexport function local(){const next=2;return next}\n' }
    for (const [path, text] of Object.entries(files))
      writeFileSync(join(dir, path), text)
    const grade = gradeProject(dir, files, [], [{ declaration: { file: 'api.ts', name: 'next', occurrence: 0 }, references: [{ file: 'consumer.ts', name: 'next', occurrence: 2 }] }])
    expect(grade).toMatchObject({ _tag: 'Failed', issues: [expect.stringContaining('another symbol')] })
  })
  it('deduplicates native response usage and includes only completed records within a numeric cutoff', () => {
    const row = (id: string, at: string, input: number) => JSON.stringify({ type: 'token_usage_record', timestamp: at, payload: { response_id: id, usage: { input_tokens: input, cached_input_tokens: 5, output_tokens: 2 } } })
    const result = parseUsage([row('one', '2026-10-09T03:14:29.026Z', 10), row('one', '2026-10-09T03:14:29.113Z', 20), row('later', '2026-10-09T03:14:30.001Z', 100)].join('\n'), '2026-10-09T03:14:29.994Z')
    expect(result).toMatchObject({ _tag: 'Ok', value: { tokens: { uncachedInput: 15, cachedInput: 5, output: 2, total: 22 }, charges: { _tag: 'Unavailable' } } })
  })
  it('reports missing protected-plan capabilities explicitly', async () => {
    expect(await checkChangedVerifiedPlan(null)).toMatchObject({ _tag: 'Unavailable' })
  })
  it('keeps infrastructure rejection separate from verified-plan validation refusal', async () => {
    const common = { plan: async () => 1, tamper: () => 2, snapshot: () => 'unchanged' }
    expect(await checkChangedVerifiedPlan({ ...common, commit: async () => ({ _tag: 'Unavailable', reason: 'Missing dependency.' }) })).toMatchObject({ _tag: 'Unavailable' })
    expect(await checkChangedVerifiedPlan({ ...common, commit: async () => ({ _tag: 'ValidationRefused', reason: 'Changed verification hash.' }) })).toEqual({ _tag: 'Passed' })
    await expect(checkChangedVerifiedPlan({ ...common, commit: async () => {
      throw new Error('Server failed.')
    } })).rejects.toThrow('Server failed.')
  })
  it('deduplicates actual charge receipts and refuses conflicting receipts', () => {
    const usage = { type: 'turn.completed', timestamp: '2026-10-09T01:00:00Z', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } }
    const receipt = { type: 'provider_charge', timestamp: usage.timestamp, amount: 0.25, currency: 'USD', receiptId: 'receipt-one' }
    const lines = [usage, receipt, receipt].map(r => JSON.stringify(r)).join('\n')
    expect(parseUsage(lines, usage.timestamp)).toMatchObject({ _tag: 'Ok', value: { charges: { _tag: 'Recorded', amount: 0.25, receipts: ['receipt-one'] } } })
    expect(parseUsage(`${lines}\n${JSON.stringify({ ...receipt, amount: 1 })}`, usage.timestamp)).toMatchObject({ _tag: 'Err' })
    expect(parseUsage(lines, 'invalid')).toMatchObject({ _tag: 'Err' })
    expect(parseUsage(JSON.stringify({ ...usage, timestamp: undefined }), usage.timestamp)).toMatchObject({ _tag: 'Err' })
  })
  it('imports observed Codex and OpenCode completion events without inventing reasoning tokens', () => {
    const cutoff = '2026-10-09T01:00:00Z'
    const codex = JSON.stringify({ type: 'turn.completed', _observedCompleted: cutoff, usage: { input_tokens: 20, cached_input_tokens: 8, output_tokens: 5 } })
    expect(parseUsage(codex, cutoff)).toMatchObject({ _tag: 'Ok', value: { tokens: { uncachedInput: 12, cachedInput: 8, output: 5, reasoning: 0, total: 25 } } })
    const openCode = JSON.stringify({ type: 'step_finish', _observedCompleted: cutoff, part: { id: 'one', tokens: { input: 12, output: 5, reasoning: 3, cache: { read: 8, write: 2 }, total: 30 } } })
    expect(parseUsage(openCode, cutoff)).toMatchObject({ _tag: 'Ok', value: { tokens: { uncachedInput: 12, cachedInput: 8, cacheWrite: 2, output: 8, reasoning: 3, total: 30 } } })
  })
  it('terminates a long-running process when output recording fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'experiment-stream-failure-'))
    const script = join(dir, 'child.ts')
    const pidPath = join(dir, 'pid.txt')
    writeFileSync(script, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));process.stdout.write('ready');setInterval(()=>process.stdout.write('alive'),100)\n`)
    const failed = () => new Writable({ write(_chunk, _encoding, callback) {
      callback(new Error('Output sink failed.'))
    } })
    await expect(recordCommand({ command: [process.execPath, script], cwd: dir, directory: join(dir, 'record'), phase: 'mechanical', role: 'arm', timeoutMs: 10000, tracing: 'top-level' }, { openOutput: failed })).rejects.toThrow('Output sink failed.')
    const pid = Number(readFileSync(pidPath, 'utf8'))
    const status = `/proc/${pid}/stat`
    if (existsSync(status)) {
      const text = readFileSync(status, 'utf8')
      // SIGKILL has completed. Linux can retain an exited orphan until its subreaper collects it.
      expect(text.slice(text.lastIndexOf(')') + 2, text.lastIndexOf(')') + 3)).toBe('Z')
    }
  })
  it('records real provider usage shapes with completion observation timestamps', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'experiment-provider-'))
    for (const [provider, total] of [['codex', 30122], ['opencode', 7416]] as const) {
      const input = readFileSync(new URL(`./fixtures/experiment/${provider}.jsonl`, import.meta.url), 'utf8')
      const script = join(directory, `${provider}.ts`)
      writeFileSync(script, `process.stdout.write(${JSON.stringify(input)})\n`)
      const recorded = await recordCommand({ command: [process.execPath, script], cwd: directory, directory: join(directory, provider), phase: 'mechanical', role: 'arm', timeoutMs: 10000, tracing: 'strace' })
      expect(parseUsage(readFileSync(recorded.observedEvents.path, 'utf8'), recorded.completed)).toMatchObject({ _tag: 'Ok', value: { tokens: { total } } })
      expect(recorded.childLifecycle).toEqual({ _tag: 'ProvenComplete' })
    }
  })
  it('keeps paired repairs and missing workflows visible', () => {
    const rows = [{ task: 'one', mode: 'forced' as const, cohort: 'mechanical' as const, repeat: 0, attempt: 0, quality: 'failed' as const, seconds: 3, usage: { _tag: 'Unavailable' as const, reason: 'No provider event in this fixture.' } }]
    expect(pairAttempts(rows, 42)[0].comparisons[1]).toMatchObject({ completePairs: 0, allAttemptPairedDifference: { _tag: 'Unavailable' } })
  })
  it('rejects overlapping imported phase response IDs', () => {
    const cutoff = '2026-10-09T01:00:00Z'
    const native = JSON.stringify({ type: 'token_usage_record', timestamp: cutoff, payload: { response_id: 'one', usage: { input_tokens: 20, cached_input_tokens: 8, output_tokens: 5 } } })
    const usage = parseUsage(native, cutoff)
    expect(combineUsage([usage, usage])).toMatchObject({ _tag: 'Err', message: expect.stringContaining('overlap') })
  })
  it('terminates ignored-stdio descendants after a fast parent exits', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'experiment-descendant-'))
    const script = join(directory, 'parent.ts')
    writeFileSync(script, `import {spawn} from 'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref()\n`)
    const recorded = await recordCommand({ command: [process.execPath, script], cwd: directory, directory: join(directory, 'record'), phase: 'mechanical', role: 'arm', timeoutMs: 10000, tracing: 'top-level' })
    expect(recorded.exit._tag).toBe('DescendantsTerminated')
    expect(recorded.childLifecycle._tag).toBe('Unavailable')
  })
  it('terminates traced descendants that escape the original process group', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'experiment-escaped-'))
    const script = join(directory, 'parent.ts')
    writeFileSync(script, `import {spawn} from 'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}).unref()\n`)
    const recorded = await recordCommand({ command: [process.execPath, script], cwd: directory, directory: join(directory, 'record'), phase: 'mechanical', role: 'arm', timeoutMs: 250, tracing: 'strace' })
    expect(recorded.exit._tag).toBe('TimedOut')
    expect(recorded.childLifecycle._tag).toBe('ProvenComplete')
  })
  it('prevents runtime treatment changes after preregistration', () => {
    const parsed = parseManifest(fixture())
    const directory = mkdtempSync(join(tmpdir(), 'experiment-runtime-freeze-'))
    if (parsed._tag === 'Err')
      throw new Error(parsed.message)
    freezeManifest(parsed.value, directory)
    expect(() => {
      parsed.value.tasks[0].expected['src.ts'] = 'tampered'
    }).toThrow()
  })
  it('rejects shared unknown symbols from unresolved exports', () => {
    const directory = mkdtempSync(join(tmpdir(), 'experiment-unknown-symbol-'))
    const files = { 'api.ts': 'export { missing as next } from "./absent"\n', 'consumer.ts': 'import {next} from "./api"\nexport const value=next\n' }
    for (const [file, text] of Object.entries(files))
      writeFileSync(join(directory, file), text)
    expect(gradeProject(directory, files, [], [{ declaration: { file: 'api.ts', name: 'next', occurrence: 0 }, references: [{ file: 'consumer.ts', name: 'next', occurrence: 0 }, { file: 'consumer.ts', name: 'next', occurrence: 1 }] }])).toMatchObject({ _tag: 'Failed' })
  })
  it('uses attempt number rather than input order for final workflow quality', () => {
    const common = { task: 'one', mode: 'direct' as const, cohort: 'mechanical' as const, repeat: 0, seconds: 1, usage: { _tag: 'Unavailable' as const, reason: 'No provider events.' } }
    expect(aggregateAttempts([{ ...common, attempt: 1, quality: 'passed' }, { ...common, attempt: 0, quality: 'failed' }], 42)[0]).toMatchObject({ completedWorkflows: 1 })
  })
  it('refuses usage owned by more than one attempt', () => {
    const cutoff = '2026-10-09T01:00:00Z'
    const parsed = parseUsage(JSON.stringify({ type: 'token_usage_record', timestamp: cutoff, payload: { response_id: 'same-response', usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 2 } } }), cutoff)
    if (parsed._tag === 'Err')
      throw new Error(parsed.message)
    const common = { task: 'one', mode: 'direct' as const, cohort: 'mechanical' as const, attempt: 0, quality: 'passed' as const, seconds: 1, tokens: parsed.value.tokens, charges: parsed.value.charges, usage: { _tag: 'Recorded' as const, value: parsed.value } }
    expect(aggregateAttempts([{ ...common, repeat: 0 }, { ...common, repeat: 1 }], 42)[0]).toMatchObject({ tokens: { _tag: 'Unavailable' } })
  })
  it('keeps seeded uncertainty unchanged when input records reorder', () => {
    const rows = Array.from({ length: 8 }, (_, index) => ({ task: index % 2 ? 'second' : 'first', mode: 'direct' as const, cohort: 'mechanical' as const, repeat: Math.floor(index / 2), attempt: 0, quality: 'passed' as const, seconds: index + 1, usage: { _tag: 'Unavailable' as const, reason: 'No provider event.' } }))
    expect(aggregateAttempts(rows, 42)).toEqual(aggregateAttempts([...rows].reverse(), 42))
  })
})
