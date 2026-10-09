import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

const cli = resolve('packages/cli/src/cli.ts')

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args, '--profile', 'full', '--json'], {
    cwd,
    encoding: 'utf8',
  })
}

function consumerValue(cwd: string): number {
  const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'consumer.ts'], {
    cwd,
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  return Number(result.stdout.trim())
}

it('cli refactors preserve executable consumers through dry-run, rename, move, file rename, and replacement', () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module"}',
    'source.ts': 'export const answer = 42\n',
    'replacement.ts': 'export const replacement = 7\n',
    'lib/.gitkeep': '',
    'consumer.ts': 'import { answer } from "./source.ts"\nconsole.log(answer)\n',
  })
  try {
    const preview = run(fixture.dir, ['rename', 'answer', 'value', '--no-vue'])
    assert.equal(preview.status, 0, preview.stderr)
    assert.equal(JSON.parse(preview.stdout).dryRun, true)
    const scan = run(fixture.dir, ['scan', 'answer'])
    assert.equal(scan.status, 0, scan.stderr)
    assert.ok(JSON.parse(scan.stdout).length > 0)
    assert.equal(consumerValue(fixture.dir), 42)

    for (const args of [
      ['rename', 'answer', 'value', '--no-vue'],
      ['move', 'value', '--from', 'source.ts', '--to', 'lib/value.ts', '--no-vue'],
      ['rename-file', 'lib/value.ts', 'moved/value.ts', '--no-vue'],
    ]) {
      const result = run(fixture.dir, [...args, '--apply'])
      assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`)
      assert.equal(JSON.parse(result.stdout).applied, true)
      assert.equal(consumerValue(fixture.dir), 42)
    }
    const replacement = run(fixture.dir, ['replace', 'value', 'replacement', '--apply'])
    assert.equal(replacement.status, 0, replacement.stderr)
    assert.equal(JSON.parse(replacement.stdout).applied, true)
    assert.equal(consumerValue(fixture.dir), 7)
  }
  finally { fixture.cleanup() }
})

it('cli verification rejects a conflicting rename without changing executable consumers', () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module"}',
    'source.ts': 'export const answer = 42\nexport const taken = 7\n',
    'consumer.ts': 'import { answer } from "./source.ts"\nconsole.log(answer)\n',
  })
  try {
    const result = run(fixture.dir, ['rename', 'answer', 'taken', '--apply', '--no-vue'])
    assert.equal(result.status, 1, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.applied, false)
    assert.equal(payload.blockedByRegression, true)
    assert.ok(payload.regressions.length > 0)
    assert.equal(consumerValue(fixture.dir), 42)
  }
  finally { fixture.cleanup() }
})

it('doctor accepts a bare changed flag before JSON output', () => {
  const fixture = makeFixture({ 'source.ts': 'export const value = 1\n' })
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: fixture.dir })
    const result = run(fixture.dir, ['doctor', '--checks', 'dangling-reexport', '--changed'])
    assert.equal(result.status, 0, result.stderr)
    const report = JSON.parse(result.stdout)
    assert.deepEqual(report.findings, [])
    assert.ok(report.filesScanned > 0)
  }
  finally { fixture.cleanup() }
})

it.each([
  { args: ['rename', 'answer', 'value', '--no-vue'], message: 'verification: no new type diagnostics', status: 0 },
  { args: ['rename', 'answer', 'taken', '--no-vue'], message: 'verification: type diagnostics increased', status: 1 },
  { args: ['rename', 'answer', 'value', '--no-vue', '--verify-mode', 'none'], message: 'verification: not run', status: 0 },
  { args: ['rename-file', 'source.ts', 'target.ts', '--no-vue'], message: 'verification: no new type diagnostics', status: 0 },
  { args: ['rename-file', 'source.ts', 'target.ts', '--no-vue', '--verify-mode', 'none'], message: 'verification: not run', status: 0 },
  { args: ['css-class-rename', 'font-semibold', 'font-medium'], message: 'verification: not run', status: 0 },
])('agent output reports verification for $args', ({ args, message, status }) => {
  const fixture = makeFixture({
    'source.ts': 'export const answer = 42\nexport const taken = 7\n',
    'View.vue': '<template><div class="font-semibold"></div></template>\n',
  })
  try {
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      '--no-warnings',
      cli,
      ...args,
      '--apply',
      '--profile',
      'agent',
    ], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(result.status, status, result.stderr)
    assert.ok(result.stdout.includes(message), result.stdout)
  }
  finally { fixture.cleanup() }
})
