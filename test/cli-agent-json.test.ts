import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

const cli = resolve('packages/cli/src/cli.ts')

function run(cwd: string, args: string[], profile = 'agent') {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args, '--json', '--profile', profile], {
    cwd,
    encoding: 'utf8',
  })
}

it('agent JSON previews changed line ranges without sending entire files', () => {
  const source = `export const className = 'font-semibold'\n${'// unchanged context\n'.repeat(500)}`
  const fixture = makeFixture({ 'source.ts': source })
  try {
    const args = ['css-class-rename', 'font-semibold', 'font-medium']
    const compact = run(fixture.dir, args)
    const full = run(fixture.dir, args, 'full')
    assert.equal(compact.status, 0, compact.stderr)
    assert.equal(full.status, 0, full.stderr)
    const payload = JSON.parse(compact.stdout)
    assert.deepEqual(payload.changes, [['source.ts', '1']])
    assert.equal(payload.verification, 'not-applicable')
    assert.equal(payload.mode, 'dry-run')
    assert.equal(fixture.read('source.ts'), source)
    assert.ok(compact.stdout.length < full.stdout.length / 10)
    assert.equal(JSON.parse(full.stdout).changes[0].before, source)
  }
  finally { fixture.cleanup() }
})

it('applied file moves report moves and changed consumer lines', () => {
  const source = 'export const answer = 42\n'
  const fixture = makeFixture({
    'source.ts': source,
    'consumer.ts': 'import { answer } from "./source.ts"\nconsole.log(answer)\n',
  })
  try {
    const result = run(fixture.dir, ['rename-file', 'source.ts', 'lib/value.ts', '--no-vue', '--apply'])
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.deepEqual(payload.moves, [['source.ts', 'lib/value.ts']])
    assert.deepEqual(payload.changes, [['consumer.ts', '1']])
    assert.equal(payload.mode, 'applied')
    assert.deepEqual(payload.verification, [['typescript', 'touched', 3, 0, 1]])
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
    assert.equal(payload.mode, 'blocked')
    assert.ok(payload.regressions.length > 0)
    assert.deepEqual(payload.verification, [['typescript', 'touched', 1, payload.regressions.length]])
    assert.equal(fixture.read('source.ts'), source)
  }
  finally { fixture.cleanup() }
})

it.each([
  ['rename', 'answer', 'value', '--no-verify'],
  ['move', 'answer', '--from', 'source.ts', '--to', 'lib/value.ts', '--no-verify'],
  ['delete', 'replacement', '--from', 'replacement.ts', '--no-verify'],
  ['replace', 'answer', 'replacement', '--no-verify'],
  ['css-class-rename', 'font-semibold', 'font-medium'],
  ['vue-template-wrap', 'span', 'section'],
  ['vue-template-unwrap', 'section'],
  ['doctor', '--fix', '--checks', 'inconsistent-import-path'],
])('agent mutation JSON uses compact tuples for %s', (...args) => {
  const fixture = makeFixture({
    'source.ts': 'export const answer = 42\nexport const className = "font-semibold"\n',
    'replacement.ts': 'export const replacement = 7\n',
    'consumer.ts': 'import { answer } from "./source"\nconsole.log(answer)\n',
    'consumer-two.ts': 'import { answer } from "./source"\nconsole.log(answer)\n',
    'consumer-three.ts': 'import { answer } from "./source.ts"\nconsole.log(answer)\n',
    'component.vue': '<template><section><span>Hello</span></section></template>\n',
  })
  try {
    const result = run(fixture.dir, args)
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.mode, 'dry-run')
    assert.equal(payload.verification, args.includes('--no-verify') ? 'disabled' : 'not-applicable')
    assert.ok(payload.changes.length > 0)
    for (const [path, before, after] of payload.changes) {
      assert.equal(typeof path, 'string')
      assert.match(before, /^\d+(?:\+|-\d+)?(?:,\d+(?:\+|-\d+)?)*$/)
      if (after !== undefined)
        assert.match(after, /^\d+(?:\+|-\d+)?(?:,\d+(?:\+|-\d+)?)*$/)
    }
    assert.equal(fixture.read('source.ts'), 'export const answer = 42\nexport const className = "font-semibold"\n')
  }
  finally { fixture.cleanup() }
})

it('agent doctor fixes report changed lines after applying edits', () => {
  const fixture = makeFixture({
    'source.ts': 'export const answer = 42\n',
    'one.ts': 'import { answer } from "./source"\n',
    'two.ts': 'import { answer } from "./source"\n',
    'three.ts': 'import { answer } from "./source.ts"\n',
  })
  try {
    const result = run(fixture.dir, ['doctor', '--fix', '--checks', 'inconsistent-import-path', '--apply'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).mode, 'applied')
    assert.deepEqual(JSON.parse(result.stdout).changes, [['three.ts', '1']])
    assert.equal(fixture.read('three.ts'), 'import { answer } from "./source"\n')
  }
  finally { fixture.cleanup() }
})

it.each(['agent', 'full'])('non-code file moves report skipped verification in %s JSON', (profile) => {
  const fixture = makeFixture({ 'asset.txt': 'hello\n' })
  try {
    const result = run(fixture.dir, ['rename-file', 'asset.txt', 'renamed.txt', '--no-vue'], profile)
    assert.equal(result.status, 0, result.stderr)
    const verification = JSON.parse(result.stdout).verification
    assert.deepEqual(verification, profile === 'agent' ? 'not-applicable' : { _tag: 'Skipped', reason: 'not-applicable' })
  }
  finally { fixture.cleanup() }
})

it('full text shows completed diagnostics before refusing an invalid edit', () => {
  const fixture = makeFixture({ 'source.ts': 'export const answer = 42\nexport const taken = 7\n' })
  try {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, 'rename', 'answer', 'taken', '--no-vue', '--apply', '--profile', 'full'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /typescript diagnostics: touched, 1 files, [1-9]\d* new errors/)
    assert.equal(fixture.read('source.ts'), 'export const answer = 42\nexport const taken = 7\n')
  }
  finally { fixture.cleanup() }
})
