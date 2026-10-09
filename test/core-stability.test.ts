import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs, { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, statSync, symlinkSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import process from 'node:process'
import { it, vi } from 'vitest'
import { runMove, runRename, writeChanges } from '../packages/core/src/index.ts'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

it('preserves executable permissions when applying a change', () => {
  const fx = makeFixture({ 'run.ts': 'before' }, false)
  try {
    const path = join(fx.dir, 'run.ts')
    chmodSync(path, 0o755)
    writeChanges([{ path, rel: 'run.ts', before: 'before', after: 'after' }])
    assert.equal(fx.read('run.ts'), 'after')
    assert.equal(statSync(path).mode & 0o777, 0o755)
  }
  finally { fx.cleanup() }
})

it('preserves symlinks and updates their target', () => {
  const fx = makeFixture({ 'target.ts': 'before' }, false)
  try {
    const path = join(fx.dir, 'link.ts')
    symlinkSync('target.ts', path)
    writeChanges([{ path, rel: 'link.ts', before: 'before', after: 'after' }])
    assert.equal(lstatSync(path).isSymbolicLink(), true)
    assert.equal(fx.read('target.ts'), 'after')
  }
  finally { fx.cleanup() }
})

it('leaves all existing files intact when a later target cannot be replaced', () => {
  const fx = makeFixture({ 'a.ts': 'before' }, false)
  try {
    mkdirSync(join(fx.dir, 'b.ts'))
    assert.throws(() => writeChanges([
      { path: join(fx.dir, 'a.ts'), rel: 'a.ts', before: 'before', after: 'after' },
      { path: join(fx.dir, 'b.ts'), rel: 'b.ts', before: '', after: 'after' },
    ]))
    assert.equal(fx.read('a.ts'), 'before')
    assert.deepEqual(readdirSync(fx.dir).sort(), ['a.ts', 'b.ts'])
  }
  finally { fx.cleanup() }
})

it('rejects stale changes before overwriting any file', () => {
  const fx = makeFixture({ 'a.ts': 'before', 'b.ts': 'user edit' }, false)
  try {
    assert.throws(() => writeChanges([
      { path: join(fx.dir, 'a.ts'), rel: 'a.ts', before: 'before', after: 'after' },
      { path: join(fx.dir, 'b.ts'), rel: 'b.ts', before: 'before', after: 'after' },
    ]))
    assert.equal(fx.read('a.ts'), 'before')
    assert.equal(fx.read('b.ts'), 'user edit')
  }
  finally { fx.cleanup() }
})

it('restores committed files and removes new files if a later rename fails', () => {
  const fx = makeFixture({ 'a.ts': 'before', 'c.ts': 'before' }, false)
  const rename = fs.renameSync
  const failure = new Error('Filesystem refused the final rename')
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (to === join(fx.dir, 'c.ts'))
      throw failure
    return rename(from, to)
  })
  syncBuiltinESMExports()
  try {
    assert.throws(() => writeChanges([
      { path: join(fx.dir, 'a.ts'), rel: 'a.ts', before: 'before', after: 'after' },
      { path: join(fx.dir, 'b.ts'), rel: 'b.ts', before: '', after: 'new' },
      { path: join(fx.dir, 'c.ts'), rel: 'c.ts', before: 'before', after: 'after' },
    ]), error => error === failure)
    assert.equal(fx.read('a.ts'), 'before')
    assert.equal(fx.read('c.ts'), 'before')
    assert.equal(existsSync(join(fx.dir, 'b.ts')), false)
    assert.deepEqual(readdirSync(fx.dir).sort(), ['a.ts', 'c.ts'])
  }
  finally {
    spy.mockRestore()
    syncBuiltinESMExports()
    fx.cleanup()
  }
})

it('preserves destructured siblings when moving another variable from their statement', async () => {
  const fx = makeFixture({
    'source.ts': 'export const moved = 1, { kept } = { kept: 2 }\n',
    'main.ts': 'import { moved, kept } from "./source.ts"\nconsole.log(moved + kept)\n',
  })
  try {
    const result = await runMove('moved', 'source.ts', 'target.ts', { ...{ cwd: fx.dir, verify: false }, engine: vueServices() })
    writeChanges(result.changes)
    assert.equal(execFileSync(process.execPath, [join(fx.dir, 'main.ts')], { encoding: 'utf8' }).trim(), '3')
  }
  finally { fx.cleanup() }
})

it('rejects moving an export into its own file', async () => {
  const fx = makeFixture({ 'source.ts': 'export const moved = 1\n' })
  try {
    await assert.rejects(runMove('moved', 'source.ts', './source.ts', { ...{ cwd: fx.dir, verify: false }, engine: vueServices() }))
    assert.equal(fx.read('source.ts'), 'export const moved = 1\n')
  }
  finally { fx.cleanup() }
})

it('renames dollar-prefixed bindings and their shorthand properties', async () => {
  const fx = makeFixture({
    'source.ts': 'export const $old = 3\n',
    'main.ts': 'import { $old } from "./source.ts"\nconsole.log(JSON.stringify({ $old }))\n',
  })
  try {
    writeChanges((await runRename('$old', '$new', { ...{ cwd: fx.dir, verify: false }, engine: vueServices() })).changes)
    assert.equal(execFileSync(process.execPath, [join(fx.dir, 'main.ts')], { encoding: 'utf8' }).trim(), '{"$new":3}')
  }
  finally { fx.cleanup() }
})

it('preserves named re-export aliases when moving their declaration', async () => {
  const fx = makeFixture({
    'source.ts': 'export const moved = 1\nexport const kept = 2\n',
    'barrel.ts': 'export { moved as publicName, kept } from "./source.ts"\n',
    'main.ts': 'import { publicName, kept } from "./barrel.ts"\nconsole.log(publicName + kept)\n',
  })
  try {
    writeChanges((await runMove('moved', 'source.ts', 'target.ts', { ...{ cwd: fx.dir, verify: false }, engine: vueServices() })).changes)
    assert.equal(execFileSync(process.execPath, [join(fx.dir, 'main.ts')], { encoding: 'utf8' }).trim(), '3')
  }
  finally { fx.cleanup() }
})

it.each(['old', '$old'])('reports multiline stale imports of %s', async (name) => {
  const fx = makeFixture({
    'source.ts': `export const ${name} = 1\n`,
    'consumer.ts': `import {\n  ${name},\n} from "unresolved-package"\nconsole.log(${name})\n`,
  })
  try {
    const result = await runRename(name, 'updated', { ...{ cwd: fx.dir, verify: false }, engine: vueServices() })
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0], /consumer\.ts/)
  }
  finally { fx.cleanup() }
})

it.each(['target.ts', 'lib/target.ts'])('verifies a new %s file when its parent directory exists', async (target) => {
  const source = 'export const value = 42\n'
  const consumer = 'import { value } from "./source.ts"; export const result = value\n'
  const fx = makeFixture({ 'source.ts': source, 'consumer.ts': consumer, 'lib/keep.ts': 'export {}\n' })
  try {
    const result = await runMove('value', 'source.ts', target, { ...{ cwd: fx.dir }, engine: vueServices() })
    assert.deepEqual(result.regressions, [])
    assert.equal(existsSync(join(fx.dir, target)), false)
    assert.equal(fx.read('source.ts'), source)
    assert.equal(fx.read('consumer.ts'), consumer)
  }
  finally { fx.cleanup() }
})
