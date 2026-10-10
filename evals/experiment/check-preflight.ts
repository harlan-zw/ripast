import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { projectContext } from './check-context.ts'
import { executeExperiment } from './execute.ts'
import { parseManifest } from './manifest.ts'

async function main() {
  const [action, ...args] = process.argv.slice(2)
  if (action === 'attempt') {
    const [project, task, root, provenance, mode, scope] = args
    const captured = JSON.parse(readFileSync(provenance, 'utf8')) as { scenario: { id: string, symbol: string, file: string, tests: string }, capture: { original: string, files: Record<string, string> } }[]
    const row = captured.find(row => row.scenario.id === task)!
    const module = Object.entries(row.capture.files).find(([, code]) => code.includes(`function ${row.scenario.symbol}`))![0]
    const directory = join(project, '.checks')
    mkdirSync(directory, { recursive: true })
    const context = scope === 'projects' ? projectContext(task) : { args: [], testPath: '.checks/proof.test.ts' }
    const test = join(project, context.testPath)
    const wrapper = fileURLToPath(new URL('./check-command.ts', import.meta.url))
    const execute = (color: string) => {
      const forced = mode !== 'direct'
      const executable = forced ? join(root, 'packages/cli/bin/ripide.mjs') : join(project, 'node_modules/vitest/vitest.mjs')
      const params = forced
        ? ['check', row.scenario.symbol, ...context.args, '--base', 'HEAD', '--json', '--artifact', `.checks/${color}.json`]
        : ['run', context.testPath, ...context.args, '--reporter=json', `--outputFile=.checks/${color}.json`]
      if (!forced)
        writeFileSync(test, `import {test, expect, vi} from 'vitest'\nimport {${row.scenario.symbol}} from '${relative(dirname(test), join(project, module))}'\n${row.scenario.tests}\n`)
      const result = spawnSync(process.execPath, [wrapper, forced ? 'ripide' : 'vitest', executable, ...params], { cwd: project, encoding: 'utf8', input: row.scenario.tests, timeout: 60000, env: { ...process.env, HOME: join(process.env.RIPIDE_EXPERIMENT_RECORD_DIRECTORY!, 'home'), RIPIDE_EXPERIMENT_TEST_PATH: test } })
      if (result.error)
        throw result.error
      if (result.status !== (color === 'red' ? 1 : 0))
        throw new Error(`Unexpected ${color} exit: ${result.status}\n${result.stderr}\n${result.stdout}`)
      return result
    }
    execute('red')
    writeFileSync(join(project, row.scenario.file), row.capture.original)
    execute('green')
    rmSync(test, { force: true })
    return
  }
  const [manifestPath, out, selectedCase] = args
  const parsed = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
  if (parsed._tag === 'Err')
    throw new Error(parsed.message)
  if (selectedCase) {
    parsed.value.tasks = parsed.value.tasks.filter(task => task.id === selectedCase)
    assert.ok(parsed.value.tasks.length, 'Choose a registered check case.')
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const provenance = parsed.value.artifacts.find(artifact => artifact.path.endsWith('/source-provenance.json'))!.path
  const scope = parsed.value.id.includes('-projects-') ? 'projects' : 'slices'
  for (const mode of ['direct', 'forced', 'hybrid'] as const)
    parsed.value.runners[mode] = { model: 'scripted', reasoning: 'none', command: [process.execPath, fileURLToPath(import.meta.url), 'attempt', '{project}', '{task}', root, provenance, mode, scope] }
  const report = await executeExperiment(parsed.value, out)
  const expected = parsed.value.tasks.length * 3 * parsed.value.repeats
  assert.equal(report.attempts.length, expected)
  assert.equal(report.attempts.filter(attempt => attempt.quality === 'passed').length, expected)
  console.log(`${expected} deterministic real-source workflows passed.`)
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
