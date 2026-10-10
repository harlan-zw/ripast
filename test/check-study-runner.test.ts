import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('registered OpenCode launch', () => {
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
    expect(receipt.assertionHash).toBe(createHash('sha256').update(assertions).digest('hex'))
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
