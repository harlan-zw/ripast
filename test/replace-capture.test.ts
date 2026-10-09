import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { runReplace, writeChanges } from 'ripide-api'
import { it } from 'vitest'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

it.each([
  'function call(next: () => string) { return [old(), next()] }\nconsole.log(JSON.stringify(call(() => "local")))',
  'function call() { const next = () => "local"; return [old(), next()] }\nconsole.log(JSON.stringify(call()))',
  'const next = () => "local"\nconsole.log(JSON.stringify([old(), next()]))',
])('replace preserves the target and unrelated local values: %s', async (consumer) => {
  const fx = makeFixture({
    'package.json': '{"type":"module"}',
    'old.ts': 'export function old() { return "old" }\n',
    'target.ts': 'export function next() { return "target" }\n',
    'consumer.ts': `import { old } from './old.ts'\n${consumer}\n`,
  })
  try {
    const result = await runReplace('old', 'next', { ...{ cwd: fx.dir }, engine: vueServices() })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const value = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'consumer.ts'], {
      cwd: fx.dir,
      encoding: 'utf8',
    })
    assert.deepEqual(JSON.parse(value), ['target', 'local'])
    assert.deepEqual((await runReplace('old', 'next', { ...{ cwd: fx.dir }, engine: vueServices() })).changes, [])
  }
  finally {
    fx.cleanup()
  }
})

it('replace keeps an existing target import and a shadowed parameter independent', async () => {
  const fx = makeFixture({
    'package.json': '{"type":"module"}',
    'old.ts': 'export default function old() { return "old" }\n',
    'target.ts': 'export function next() { return "target" }\n',
    'consumer.ts': `import old from './old.ts'
import { next as chosen } from './target.ts'
function call(next: () => string) { return [old(), next(), chosen()] }
console.log(JSON.stringify(call(() => "local")))
`,
  })
  try {
    const result = await runReplace('old', 'next', { ...{ cwd: fx.dir }, engine: vueServices() })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const value = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'consumer.ts'], {
      cwd: fx.dir,
      encoding: 'utf8',
    })
    assert.deepEqual(JSON.parse(value), ['target', 'local', 'target'])
  }
  finally {
    fx.cleanup()
  }
})

it('replace CLI applies a verified alias without capturing a local parameter', () => {
  const fx = makeFixture({
    'package.json': '{"type":"module"}',
    'old.ts': 'export function old() { return "old" }\n',
    'target.ts': 'export function next() { return "target" }\n',
    'consumer.ts': `import { old } from './old.ts'
function call(next: () => string) { return [old(), next()] }
console.log(JSON.stringify(call(() => "local")))
`,
  })
  try {
    const output = execFileSync(process.execPath, [
      '--experimental-strip-types',
      '--no-warnings',
      resolve('packages/cli/src/cli.ts'),
      'replace',
      'old',
      'next',
      '--apply',
      '--json',
    ], { cwd: fx.dir, encoding: 'utf8' })
    const result = JSON.parse(output)
    assert.equal(result.applied, true)
    assert.equal(result.blockedByRegression, false)
    assert.deepEqual(result.regressions, [])
    const value = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'consumer.ts'], {
      cwd: fx.dir,
      encoding: 'utf8',
    })
    assert.deepEqual(JSON.parse(value), ['target', 'local'])
  }
  finally {
    fx.cleanup()
  }
})
