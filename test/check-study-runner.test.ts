import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('registered OpenCode launch', () => {
  it('binds Vitest assertions only to the module in a fresh execution report', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-receipt-'))
    const project = join(dir, 'project')
    const record = join(dir, 'record')
    mkdirSync(join(project, 'src/build'), { recursive: true })
    mkdirSync(join(project, '.checks'))
    mkdirSync(record)
    symlinkSync(resolve('node_modules'), join(project, 'node_modules'), 'dir')
    writeFileSync(join(project, 'package.json'), '{"type":"module"}')
    writeFileSync(join(project, 'vitest.config.ts'), 'import { defineConfig } from \'vitest/config\'\nexport default defineConfig({ test: { include: [\'*.test.ts\'] } })\n')
    writeFileSync(join(project, 'src/build/util.ts'), 'export const runParallel = () => undefined\n')
    const assertions = 'import { test, expect } from \'vitest\'\ntest(\'registered assertion\', () => expect(1).toBe(1))\n'
    writeFileSync(join(project, 'expected.test.ts'), assertions)
    writeFileSync(join(project, 'other.test.ts'), 'import { test, expect } from \'vitest\'\ntest(\'other assertion\', () => expect(2).toBe(3))\n')
    const report = join(project, '.checks/red.json')
    const invoke = (filters: string[], fresh = true) => {
      if (fresh)
        rmSync(report, { force: true })
      const run = spawnSync(process.execPath, [resolve('evals/experiment/check-command.ts'), 'vitest', resolve('node_modules/vitest/vitest.mjs'), 'run', ...filters, '--config', 'vitest.config.ts', '--reporter=json', '--outputFile=.checks/red.json'], {
        cwd: project,
        encoding: 'utf8',
        env: { ...process.env, RIPIDE_EXPERIMENT_RECORD_DIRECTORY: record, RIPIDE_EXPERIMENT_PROJECT: project, RIPIDE_EXPERIMENT_TASK: 'link-checker-concurrency', RIPIDE_EXPERIMENT_TEST_PATH: 'expected.test.ts' },
      })
      expect(run.error).toBeUndefined()
      return JSON.parse(readFileSync(join(record, 'check-commands.jsonl'), 'utf8').trim().split('\n').at(-1)!)
    }
    expect(invoke(['other.test.ts']).assertionHash).toBeNull()
    expect(invoke(['expected.test.ts', 'other.test.ts']).assertionHash).toBeNull()
    expect(invoke(['--exclude=expected.test.ts']).assertionHash).toBeNull()
    const valid = invoke(['--exclude=other.test.ts'])
    expect(valid.assertionHash).toBe(createHash('sha256').update(assertions).digest('hex'))
    expect(valid.artifactHash).toBe(createHash('sha256').update(readFileSync(report)).digest('hex'))
    expect(invoke(['expected.test.ts'], false).assertionHash).toBeNull()
  }, 30000)

  it('shows help and rejects flags before accessing the project or running checks', () => {
    for (const flag of ['--help', '--json']) {
      const result = spawnSync(process.execPath, [resolve('evals/experiment/check-quality.ts'), '/missing/project', 'link-checker-concurrency', '/missing/provenance', 'direct', flag], { encoding: 'utf8' })
      expect(result.status).toBe(flag === '--help' ? 0 : 1)
      expect(flag === '--help' ? result.stdout : result.stderr).toContain(flag === '--help' ? 'Usage: check-behavior' : 'Unsupported argument: --json')
    }
  })

  it('rejects changed artifacts and unrelated modules at the full evidence gate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-gate-'))
    const project = join(dir, 'project')
    const record = join(dir, 'record')
    mkdirSync(join(project, 'src/build'), { recursive: true })
    mkdirSync(join(project, '.checks'))
    mkdirSync(record)
    symlinkSync(resolve('node_modules'), join(project, 'node_modules'), 'dir')
    const original = `export async function runParallel(values: number[], cb: (value: number, index: number) => Promise<void>, options: { concurrency: number }) {
  let index = 0
  await Promise.all(Array.from({ length: Math.min(Math.max(options.concurrency, 1), values.length) }, async () => {
    while (index < values.length) {
      const current = index++
      await cb(values[current], current).catch(error => console.error(error))
    }
  }))
}
export function truncateString(text: string, length: number) { return text.length > length ? text.slice(0, length - 3) + '...' : text }
`
    const seeded = original.replace('Math.min(Math.max(options.concurrency, 1), values.length)', '1')
    writeFileSync(join(project, 'src/build/util.ts'), seeded)
    writeFileSync(join(project, 'package.json'), '{"type":"module"}')
    writeFileSync(join(project, 'vitest.config.ts'), 'import { defineConfig } from \'vitest/config\'\nexport default defineConfig({ test: { include: [\'.checks/*.test.ts\'] } })\n')
    execFileSync('git', ['init', '--quiet'], { cwd: project })
    execFileSync('git', ['add', 'src', 'package.json', 'vitest.config.ts'], { cwd: project })
    execFileSync('git', ['-c', 'user.name=Eval', '-c', 'user.email=eval@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'baseline'], { cwd: project })
    writeFileSync(join(record, 'baseline-commit.txt'), execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project }))
    const provenance = join(dir, 'provenance.json')
    writeFileSync(provenance, JSON.stringify([{ scenario: { id: 'link-checker-concurrency', file: 'src/build/util.ts' }, capture: { files: { 'src/build/util.ts': seeded } } }]))
    const test = join(project, '.checks/proof.test.ts')
    writeFileSync(test, `import { test, expect } from 'vitest'
import { runParallel } from '../src/build/util.ts'
test('overlapping workers', async () => {
  let active = 0; let release!: () => void
  const gate = new Promise<void>(done => { release = done })
  const work = runParallel([1, 2], async () => { active++; await gate }, { concurrency: 2 })
  const overlap = active; release(); await work; expect(overlap).toBe(2)
})
`)
    const env = { ...process.env, RIPIDE_EXPERIMENT_RECORD_DIRECTORY: record, RIPIDE_EXPERIMENT_PROJECT: project, RIPIDE_EXPERIMENT_TASK: 'link-checker-concurrency', RIPIDE_EXPERIMENT_TEST_PATH: '.checks/proof.test.ts' }
    for (const color of ['red', 'green']) {
      if (color === 'green')
        writeFileSync(join(project, 'src/build/util.ts'), original)
      const run = spawnSync(process.execPath, [resolve('evals/experiment/check-command.ts'), 'vitest', resolve('node_modules/vitest/vitest.mjs'), 'run', '.checks/proof.test.ts', '--reporter=json', `--outputFile=.checks/${color}.json`], { cwd: project, env, encoding: 'utf8' })
      expect(run.status, run.stderr).toBe(color === 'red' ? 1 : 0)
    }
    rmSync(test)
    const verify = () => spawnSync(process.execPath, [resolve('evals/experiment/check-quality.ts'), project, 'link-checker-concurrency', provenance, 'direct'], { env, encoding: 'utf8' })
    const valid = verify()
    expect(valid.status, valid.stderr).toBe(0)
    const greenPath = join(project, '.checks/green.json')
    const green = JSON.parse(readFileSync(greenPath, 'utf8'))
    green.testResults[0].name = join(project, '.checks/other.test.ts')
    writeFileSync(greenPath, JSON.stringify(green))
    const altered = verify()
    expect(altered.status).toBe(1)
    expect(altered.stderr).toContain('Keep the artifact from the recorded execution.')
    const commandsPath = join(record, 'check-commands.jsonl')
    const commands = readFileSync(commandsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    commands.at(-1)!.artifactHash = createHash('sha256').update(readFileSync(greenPath)).digest('hex')
    writeFileSync(commandsPath, `${commands.map(command => JSON.stringify(command)).join('\n')}\n`)
    const unrelated = verify()
    expect(unrelated.status).toBe(1)
    expect(unrelated.stderr).toContain('Run only the registered temporary module.')
  }, 30000)
  it('records and runs project checks when the agent starts outside the project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-command-'))
    const project = join(dir, 'project')
    const startup = join(dir, 'startup')
    const record = join(dir, 'record')
    mkdirSync(join(project, 'src/build'), { recursive: true })
    mkdirSync(join(project, '.checks'))
    mkdirSync(startup)
    mkdirSync(record)
    const source = 'export const concurrency = 4\n'
    const assertions = 'check concurrency\n'
    writeFileSync(join(project, 'src/build/util.ts'), source)
    writeFileSync(join(project, '.checks/proof.test.ts'), assertions)
    const executable = join(dir, 'check.ts')
    writeFileSync(executable, `import { readFileSync } from 'node:fs'\nconsole.log(process.cwd())\nconsole.log(readFileSync(process.argv[2], 'utf8'))\nprocess.exitCode = 7\n`)
    const result = spawnSync(process.execPath, [resolve('evals/experiment/check-command.ts'), 'vitest', executable, '.checks/proof.test.ts'], {
      cwd: startup,
      encoding: 'utf8',
      env: { ...process.env, RIPIDE_EXPERIMENT_RECORD_DIRECTORY: record, RIPIDE_EXPERIMENT_PROJECT: project, RIPIDE_EXPERIMENT_TASK: 'link-checker-concurrency', RIPIDE_EXPERIMENT_TEST_PATH: '.checks/proof.test.ts' },
    })
    expect(result.status, result.stderr).toBe(7)
    expect(result.stdout).toContain(project)
    expect(result.stdout).toContain(assertions)
    const receipt = JSON.parse(readFileSync(join(record, 'check-commands.jsonl'), 'utf8'))
    expect(receipt.exit).toBe(7)
    expect(receipt.sourceHash).toBe(createHash('sha256').update(source).digest('hex'))
    expect(receipt.assertionHash).toBeNull()
  })

  it.skipIf(process.platform !== 'linux')('preserves Git workdirs and records exact prompts for every repair', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-launch-'))
    const project = join(dir, 'project')
    const record = join(dir, 'record')
    mkdirSync(project)
    mkdirSync(record)
    execFileSync('git', ['init', '--quiet'], { cwd: project })
    execFileSync('git', ['-c', 'user.name=Eval', '-c', 'user.email=eval@example.test', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '--quiet', '-m', 'baseline'], { cwd: project })
    const provenance = join(dir, 'provenance.json')
    writeFileSync(provenance, '[]')
    const native = join(dir, 'opencode.ts')
    writeFileSync(native, `#!/usr/bin/env -S node --experimental-strip-types
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
if (args[0] === 'run') {
  writeFileSync(join(process.env.RIPIDE_EXPERIMENT_RECORD_DIRECTORY!, 'delivered.json'), JSON.stringify({ cwd: process.cwd(), args }))
}
`)
    chmodSync(native, 0o700)
    const root = resolve('.')
    const env = { ...process.env, RIPIDE_EXPERIMENT_RECORD_DIRECTORY: record, RIPIDE_EXPERIMENT_MODE: 'forced', XDG_CONFIG_HOME: join(dir, 'config'), XDG_DATA_HOME: join(dir, 'data') }
    const runner = join(root, 'evals/experiment/check-runner.ts')
    const preflight = spawnSync(process.execPath, [runner, 'preflight', project, '-', 'link-checker-concurrency', root, 'model', native, 'guided', 'slices', provenance], { env, encoding: 'utf8' })
    expect(preflight.status, preflight.stderr).toBe(0)
    const help = spawnSync(join(record, 'home/bin/check-behavior'), ['--help'], { env, encoding: 'utf8' })
    expect(help.status, help.stderr).toBe(0)
    expect(help.stdout).toContain('Usage: check-behavior')
    for (const turn of ['first', 'repair']) {
      const prompt = join(dir, `${turn}.txt`)
      writeFileSync(prompt, `Repair the function: ${turn}.`)
      const result = spawnSync(process.execPath, [runner, 'forced', project, prompt, 'link-checker-concurrency', root, 'model', native, 'guided', 'slices', provenance], { env, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
      const delivered = JSON.parse(readFileSync(join(record, 'delivered.json'), 'utf8'))
      expect(delivered.cwd).toBe(join(record, 'home/startup'))
      expect(delivered.args[delivered.args.indexOf('--dir') + 1]).toBe(delivered.cwd)
      expect(delivered.args.at(-1)).toBe(readFileSync(join(record, `effective-${turn}.txt`), 'utf8'))
      expect(delivered.args.at(-1)).toContain(`Working project: ${project}. Set every shell workdir to this project.`)
    }
    expect(readFileSync(join(record, 'effective-first.txt'), 'utf8')).toContain('Repair the function: first.')
    expect(execFileSync('git', ['status', '--porcelain'], { cwd: project, encoding: 'utf8' })).toBe('')
  })
})
