import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

const cli = resolve('packages/cli/src/cli.ts')
const version = (source: string) => createHash('sha256').update(source).digest('hex')

function run(cwd: string, args: string[], profile = 'agent') {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args, '--json', '--profile', profile], {
    cwd,
    encoding: 'utf8',
  })
}

it('agent JSON previews content versions without sending entire files', () => {
  const source = `export const className = 'font-semibold'\n${'// unchanged context\n'.repeat(500)}`
  const fixture = makeFixture({ 'source.ts': source })
  try {
    const args = ['css-class-rename', 'font-semibold', 'font-medium']
    const compact = run(fixture.dir, args)
    const full = run(fixture.dir, args, 'full')
    assert.equal(compact.status, 0, compact.stderr)
    assert.equal(full.status, 0, full.stderr)
    const payload = JSON.parse(compact.stdout)
    assert.deepEqual(payload.changes, [{
      _tag: 'Edit',
      path: 'source.ts',
      beforeVersion: version(source),
      afterVersion: version(source.replace('font-semibold', 'font-medium')),
    }])
    assert.equal(payload.verification._tag, 'Skipped')
    assert.equal(payload.applied, false)
    assert.equal(fixture.read('source.ts'), source)
    assert.ok(compact.stdout.length < full.stdout.length / 10)
    assert.equal(JSON.parse(full.stdout).changes[0].before, source)
  }
  finally { fixture.cleanup() }
})

it('applied file moves report source and destination versions for agent cache invalidation', () => {
  const source = 'export const answer = 42\n'
  const fixture = makeFixture({
    'source.ts': source,
    'consumer.ts': 'import { answer } from "./source.ts"\nconsole.log(answer)\n',
  })
  try {
    const result = run(fixture.dir, ['rename-file', 'source.ts', 'lib/value.ts', '--no-vue', '--apply'])
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    const move = payload.changes.find((change: { _tag: string }) => change._tag === 'Move')
    assert.deepEqual(move, {
      _tag: 'Move',
      from: 'source.ts',
      to: 'lib/value.ts',
      beforeVersion: version(source),
      afterVersion: version(fixture.read('lib/value.ts')),
    })
    const edit = payload.changes.find((change: { _tag: string }) => change._tag === 'Edit')
    assert.equal(edit.path, 'consumer.ts')
    assert.equal(edit.afterVersion, version(fixture.read('consumer.ts')))
    assert.equal(payload.applied, true)
    assert.equal(payload.verification._tag, 'Checked')
    assert.equal(existsSync(resolve(fixture.dir, 'source.ts')), false)
  }
  finally { fixture.cleanup() }
})

it('agent JSON preserves regression blocking and leaves source files unchanged', () => {
  const source = 'export const answer = 42\nexport const taken = 7\n'
  const fixture = makeFixture({ 'source.ts': source })
  try {
    const result = run(fixture.dir, ['rename', 'answer', 'taken', '--no-vue', '--apply'])
    assert.equal(result.status, 1, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.applied, false)
    assert.equal(payload.blockedByRegression, true)
    assert.ok(payload.regressions.length > 0)
    assert.equal(payload.verification._tag, 'Checked')
    assert.equal(fixture.read('source.ts'), source)
  }
  finally { fixture.cleanup() }
})
