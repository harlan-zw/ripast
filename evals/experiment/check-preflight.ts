import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { executeExperiment } from './execute.ts'
import { parseManifest } from './manifest.ts'

async function main() {
  const [action, ...args] = process.argv.slice(2)
  if (action === 'attempt') {
    const [project, task, root, provenance, mode] = args
    const captured = JSON.parse(readFileSync(provenance, 'utf8')) as { scenario: { id: string, symbol: string, file: string, tests: string }, capture: { original: string, files: Record<string, string> } }[]
    const row = captured.find(row => row.scenario.id === task)!
    const module = Object.entries(row.capture.files).find(([, code]) => code.includes(`function ${row.scenario.symbol}`))![0]
    const directory = join(project, '.checks')
    mkdirSync(directory)
    const test = join(directory, 'proof.test.ts')
    const calls = join(process.env.RIPIDE_EXPERIMENT_RECORD_DIRECTORY!, 'commands.called')
    const execute = (color: string) => {
      const forced = mode !== 'direct'
      writeFileSync(calls, `${forced ? 'ripide' : 'vitest'}\n`, { flag: 'a' })
      const executable = forced ? join(root, 'packages/cli/bin/ripide.mjs') : join(project, 'node_modules/vitest/vitest.mjs')
      const params = forced
        ? ['check', row.scenario.symbol, '--json', '--artifact', `.checks/${color}.json`]
        : ['run', '.checks/proof.test.ts', '--reporter=json', `--outputFile=.checks/${color}.json`]
      if (!forced)
        writeFileSync(test, `import {test, expect, vi} from 'vitest'\nimport {${row.scenario.symbol}} from '../${module}'\n${row.scenario.tests}\n`)
      const result = spawnSync(process.execPath, [executable, ...params], { cwd: project, encoding: 'utf8', input: row.scenario.tests, timeout: 30000 })
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
  const [manifestPath, out] = args
  const parsed = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
  if (parsed._tag === 'Err')
    throw new Error(parsed.message)
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const provenance = parsed.value.artifacts.find(artifact => artifact.path.endsWith('/source-provenance.json'))!.path
  for (const mode of ['direct', 'forced', 'hybrid'] as const)
    parsed.value.runners[mode] = { model: 'scripted', reasoning: 'none', command: [process.execPath, fileURLToPath(import.meta.url), 'attempt', '{project}', '{task}', root, provenance, mode] }
  const report = await executeExperiment(parsed.value, out)
  const expected = parsed.value.tasks.length * 3
  assert.equal(report.attempts.length, expected)
  assert.equal(report.attempts.filter(attempt => attempt.quality === 'passed').length, expected)
  console.log(`${expected} deterministic real-source workflows passed.`)
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
