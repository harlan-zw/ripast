import type { Manifest } from '../evals/experiment/manifest.ts'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { executeExperiment } from '../evals/experiment/index.ts'

function fixture(action = 'pass') {
  const directory = mkdtempSync(join(tmpdir(), 'experiment-abort-'))
  const marker = join(directory, 'dispatches.txt')
  const actor = join(directory, 'actor.ts')
  writeFileSync(actor, `import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
const [marker, action] = process.argv.slice(2)
appendFileSync(marker, action + '\\n')
if (action === 'hold') setInterval(() => {}, 1000)
else console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }))
if (action === 'fail') process.exitCode = 1
if (action === 'refuse') process.exitCode = 3
if (action === 'unavailable') process.exitCode = 4
if (action === 'pass-then-fail') {
  if (readFileSync(marker, 'utf8').trim().split('\\n').length === 1) writeFileSync('source.ts', 'export const next = 1\\n')
  else process.exitCode = 1
}
`)
  const command = (action: string) => [process.execPath, actor, marker, action]
  const manifest: Manifest = {
    id: 'abort',
    study: 'pilot',
    pilotHash: null,
    seed: 42,
    repeats: 1,
    cache: 'uncontrolled',
    timeoutMs: 5000,
    timeoutPolicy: 'stop-study',
    repairs: 1,
    commonInstructions: 'Rename old to next.',
    artifacts: [],
    versions: [],
    usageImports: [],
    tracing: 'strace',
    endpoint: 'delivery-completed',
    usageBoundary: 'complete-responses-through-command-close',
    runners: Object.fromEntries(['direct', 'forced', 'hybrid'].map(mode => [mode, { model: 'scripted', reasoning: 'none', command: command(action) }])) as Manifest['runners'],
    tasks: [{ id: 'rename', cohort: 'mechanical', operation: 'rename', prompt: 'Rename old to next.', source: { _tag: 'Files', files: { 'source.ts': 'export const old = 1\n' } }, expected: { 'source.ts': 'export const next = 1\n' }, generatedDirectories: [], setup: [], checks: [], symbols: [], qualityGates: [] }],
  }
  return { directory, marker, command, manifest, run: join(directory, 'run'), cleanup: () => rmSync(directory, { recursive: true, force: true }) }
}

it.each(['setup', 'runner', 'timeout', 'lifecycle', 'required-gate', 'check-timeout', 'version'])('halts dispatch after %s infrastructure failure and retains a checkpoint', async (scenario) => {
  const fx = fixture(scenario === 'runner' ? 'fail' : scenario === 'timeout' ? 'hold' : 'pass')
  const task = fx.manifest.tasks[0]!
  if (scenario === 'setup')
    task.setup = [{ command: fx.command('fail'), phase: 'setup', role: 'controller' }]
  if (scenario === 'timeout' || scenario === 'check-timeout')
    fx.manifest.timeoutMs = 500
  if (scenario === 'lifecycle')
    fx.manifest.tracing = 'top-level'
  if (scenario === 'required-gate')
    task.qualityGates = [{ id: 'first', command: fx.command('unavailable'), required: true }, { id: 'later', command: fx.command('pass'), required: true }]
  if (scenario === 'check-timeout')
    task.checks = [{ command: fx.command('hold'), phase: 'verification', role: 'controller' }, { command: fx.command('pass'), phase: 'verification', role: 'controller' }]
  if (scenario === 'version')
    fx.manifest.versions = [fx.command('fail')]
  try {
    await assert.rejects(executeExperiment(fx.manifest, fx.run), /failed|unavailable|lifecycle|complete|timed/i)
    const checkpoint = JSON.parse(readFileSync(join(fx.run, 'abort-checkpoint.json'), 'utf8'))
    assert.equal(checkpoint._tag, 'Aborted')
    const dispatches = readFileSync(fx.marker, 'utf8').trim().split('\n')
    assert.equal(dispatches.length, ['required-gate', 'check-timeout'].includes(scenario) ? 2 : 1)
    assert.equal(checkpoint.attempts.length, scenario === 'version' ? 0 : 1)
    assert.equal(checkpoint.records.length, dispatches.length)
    for (const record of checkpoint.records) assert.equal(existsSync(record.observedEvents.path), true)
    if (scenario === 'runner')
      assert.equal(checkpoint.attempts[0].usage._tag, 'Recorded')
    if (scenario === 'required-gate')
      assert.equal(checkpoint.qualityGates.find((gate: { id: string }) => gate.id === 'later')._tag, 'NotRun')
  }
  finally { fx.cleanup() }
})

it('retains earlier successful attempts when a later runner fails', async () => {
  const fx = fixture('pass-then-fail')
  try {
    await assert.rejects(executeExperiment(fx.manifest, fx.run))
    const checkpoint = JSON.parse(readFileSync(join(fx.run, 'abort-checkpoint.json'), 'utf8'))
    assert.deepEqual(checkpoint.attempts.map((attempt: { quality: string }) => attempt.quality), ['passed', 'failed'])
    assert.equal(checkpoint.records.length, 2)
  }
  finally { fx.cleanup() }
})

it.each(['pass', 'refuse', 'failed-gate', 'optional-unavailable'])('keeps %s domain outcomes counted and permits registered repairs', async (scenario) => {
  const fx = fixture(scenario === 'refuse' ? 'refuse' : 'pass')
  if (scenario === 'failed-gate')
    fx.manifest.tasks[0]!.qualityGates = [{ id: 'semantic', command: fx.command('fail'), required: true }]
  if (scenario === 'optional-unavailable')
    fx.manifest.tasks[0]!.qualityGates = [{ id: 'optional', command: fx.command('unavailable'), required: false }]
  try {
    const report = await executeExperiment(fx.manifest, fx.run)
    assert.equal(report.attempts.length, 6)
    assert.equal(report.attempts.every(attempt => attempt.quality === (scenario === 'refuse' ? 'refused' : 'failed')), true)
    assert.equal(existsSync(join(fx.run, 'abort-checkpoint.json')), false)
  }
  finally { fx.cleanup() }
})
