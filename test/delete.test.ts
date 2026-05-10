import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { it } from 'vitest'
import { runDelete } from '../packages/core/src/delete.ts'
import { writeChanges } from '../packages/core/src/util.ts'
import { makeFixture } from './helpers.ts'

it('delete removes an unused top-level function', async () => {
  const fx = makeFixture({
    'a.ts': 'export function helper() { return 1 }\nexport function other() { return 2 }\n',
  })
  try {
    const result = await runDelete('helper', 'a.ts', { cwd: fx.dir, verify: false })
    writeChanges(result.changes)
    assert.doesNotMatch(fx.read('a.ts'), /helper/)
    assert.match(fx.read('a.ts'), /export function other/)
  }
  finally { fx.cleanup() }
})

it('delete prunes imports used only by the deleted declaration', async () => {
  const fx = makeFixture({
    'utils.ts': 'export function log(s: string) { return s }\n',
    'a.ts': 'import { log } from \'./utils.ts\'\nexport function helper(s: string) { return log(s) }\nexport function other() { return 2 }\n',
  })
  try {
    const result = await runDelete('helper', 'a.ts', { cwd: fx.dir, verify: false })
    writeChanges(result.changes)
    assert.doesNotMatch(fx.read('a.ts'), /import \{ log \}/)
    assert.match(fx.read('a.ts'), /export function other/)
  }
  finally { fx.cleanup() }
})

it('delete keeps imports still used by sibling declarations', async () => {
  const fx = makeFixture({
    'utils.ts': 'export function log(s: string) { return s }\n',
    'a.ts': 'import { log } from \'./utils.ts\'\nexport function helper(s: string) { return log(s) }\nexport function other() { return log(\'x\') }\n',
  })
  try {
    const result = await runDelete('helper', 'a.ts', { cwd: fx.dir, verify: false })
    writeChanges(result.changes)
    assert.match(fx.read('a.ts'), /import \{ log \}/)
    assert.match(fx.read('a.ts'), /export function other/)
  }
  finally { fx.cleanup() }
})

it('delete refuses when references remain', async () => {
  const fx = makeFixture({
    'a.ts': 'export function helper() { return 1 }\n',
    'b.ts': 'import { helper } from \'./a.ts\'\nexport const value = helper()\n',
  })
  try {
    await assert.rejects(
      () => runDelete('helper', 'a.ts', { cwd: fx.dir, verify: false }),
      /"helper" still has \d+ reference[\s\S]*b\.ts/,
    )
  }
  finally { fx.cleanup() }
})

it('delete supports unused interface and type declarations', async () => {
  const fx = makeFixture({
    'a.ts': 'export interface A { value: number }\nexport type B = string\nexport const c = 1\n',
  })
  try {
    writeChanges((await runDelete('A', 'a.ts', { cwd: fx.dir, verify: false })).changes)
    writeChanges((await runDelete('B', 'a.ts', { cwd: fx.dir, verify: false })).changes)
    const a = fx.read('a.ts')
    assert.doesNotMatch(a, /interface A/)
    assert.doesNotMatch(a, /type B/)
    assert.match(a, /export const c = 1/)
  }
  finally { fx.cleanup() }
})

it('delete supports unused local top-level const declarations', async () => {
  const fx = makeFixture({
    'a.ts': 'const helper = 1\nexport const other = 2\n',
  })
  try {
    writeChanges((await runDelete('helper', 'a.ts', { cwd: fx.dir, verify: false })).changes)
    const a = fx.read('a.ts')
    assert.doesNotMatch(a, /const helper/)
    assert.match(a, /export const other = 2/)
  }
  finally { fx.cleanup() }
})

it('delete refuses same-file sibling references', async () => {
  const fx = makeFixture({
    'a.ts': 'function helper() { return 1 }\nexport function other() { return helper() }\n',
  })
  try {
    await assert.rejects(
      () => runDelete('helper', 'a.ts', { cwd: fx.dir, verify: false }),
      /"helper" still has \d+ reference[\s\S]*a\.ts/,
    )
  }
  finally { fx.cleanup() }
})

it('delete throws on unsupported multi-declarator variable statements', async () => {
  const fx = makeFixture({
    'a.ts': 'export const a = 1, b = 2\n',
  })
  try {
    await assert.rejects(
      () => runDelete('a', 'a.ts', { cwd: fx.dir, verify: false }),
      /no top-level declaration named "a"/,
    )
  }
  finally { fx.cleanup() }
})

it('delete CLI dry-run prints a diff without writing', () => {
  const fx = makeFixture({
    'a.ts': 'export function helper() { return 1 }\nexport function other() { return 2 }\n',
  })
  try {
    const cli = resolve(process.cwd(), 'packages/cli/src/cli.ts')
    const out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', cli, 'delete', 'helper', '--from', 'a.ts', '--no-verify', '--profile', 'full'],
      { cwd: fx.dir, encoding: 'utf8' },
    )
    assert.match(out, /1 file, \+0 -1 lines/)
    assert.match(out, /-export function helper\(\) \{ return 1 \}/)
    assert.match(fx.read('a.ts'), /export function helper/)
  }
  finally { fx.cleanup() }
})
