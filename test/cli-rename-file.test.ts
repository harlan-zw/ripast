import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readlinkSync, symlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { runRenameFile } from 'ripide-api'
import { it } from 'vitest'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

it.each([undefined, 'project'])('rename-file preserves default scope and accepts explicit project scope %s', (mode) => {
  const fixture = makeFixture({
    'source.ts': 'export const value = 42\n',
    'consumer.ts': 'import { value } from "./source.ts"\nconsole.log(value)\n',
    'unrelated.ts': 'export const unrelated = 1\n',
  })
  try {
    const args = [resolve('packages/cli/dist/cli.mjs'), 'rename-file', 'source.ts', 'target.ts', '--no-vue', '--json', '--profile', 'full']
    if (mode)
      args.push('--verify-mode', mode)
    const result = spawnSync(process.execPath, args, { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output._tag, 'Preview')
    assert.equal(output.data.verification._tag, 'Checked')
    assert.equal(output.data.verification.checks[0].scope, mode ?? 'touched')
    assert.equal(existsSync(resolve(fixture.dir, 'target.ts')), false)
    assert.equal(fixture.read('consumer.ts'), 'import { value } from "./source.ts"\nconsole.log(value)\n')
  }
  finally { fixture.cleanup() }
})

it.skipIf(process.platform === 'win32')('rename-file SDK refuses a dangling target symlink', async () => {
  const fixture = makeFixture({ 'source.ts': 'export const value = 42\n' })
  try {
    symlinkSync('missing.ts', resolve(fixture.dir, 'target.ts'))
    await assert.rejects(runRenameFile('source.ts', 'target.ts', { ...{
      cwd: fixture.dir,
      verifyMode: 'none' as const,
    }, engine: vueServices() }), /target "target\.ts" already exists/)
    assert.equal(readlinkSync(resolve(fixture.dir, 'target.ts')), 'missing.ts')
    assert.equal(fixture.read('source.ts'), 'export const value = 42\n')
  }
  finally { fixture.cleanup() }
})

it.skipIf(process.platform === 'win32').each([false, true])('rename-file refuses a dangling target symlink with apply=%s', (apply) => {
  const consumer = 'import { value } from "./source.ts"\nconsole.log(value)\n'
  const fixture = makeFixture({
    'source.ts': 'export const value = 42\n',
    'consumer.ts': consumer,
  })
  try {
    symlinkSync('missing.ts', resolve(fixture.dir, 'target.ts'))
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      '--no-warnings',
      resolve('packages/cli/src/cli.ts'),
      'rename-file',
      'source.ts',
      'target.ts',
      '--no-vue',
      '--verify-mode',
      'none',
      '--profile',
      'full',
      '--json',
      ...(apply ? ['--apply'] : []),
    ], { cwd: fixture.dir, encoding: 'utf8' })
    assert.notEqual(result.status, 0, result.stdout)
    assert.match(result.stderr, /target "target\.ts" already exists/)
    assert.equal(lstatSync(resolve(fixture.dir, 'target.ts')).isSymbolicLink(), true)
    assert.equal(readlinkSync(resolve(fixture.dir, 'target.ts')), 'missing.ts')
    assert.equal(fixture.read('source.ts'), 'export const value = 42\n')
    assert.equal(fixture.read('consumer.ts'), consumer)
  }
  finally { fixture.cleanup() }
})

it('rename-file preserves consumers when the destination directory cannot be created', () => {
  const consumer = 'import { value } from "./source.ts"\nconsole.log(value)\n'
  const fixture = makeFixture({
    'source.ts': 'export const value = 42\n',
    'consumer.ts': consumer,
    'blocked': 'a file cannot contain the destination\n',
  })
  try {
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      '--no-warnings',
      resolve('packages/cli/src/cli.ts'),
      'rename-file',
      'source.ts',
      'blocked/target.ts',
      '--no-vue',
      '--verify-mode',
      'none',
      '--apply',
      '--profile',
      'full',
      '--json',
    ], { cwd: fixture.dir, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.equal(fixture.read('consumer.ts'), consumer)
    assert.equal(fixture.read('source.ts'), 'export const value = 42\n')
  }
  finally { fixture.cleanup() }
})

it('rename-file restores the source when writing a consumer fails', () => {
  const fixture = makeFixture({
    'source.ts': 'export const value = 42\n',
    'consumer.ts': 'import { value } from "./source.ts"\nconsole.log(value)\n',
  })
  try {
    // A preload injects one filesystem failure at the CLI boundary, after planning succeeds.
    const preload = fixture.write('fail-write.ts', `
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
const original = fs.writeFileSync
fs.writeFileSync = function(path, ...args) {
  if (String(path).includes('ripide-tmp')) throw new Error('injected write failure')
  return original.call(this, path, ...args)
}
syncBuiltinESMExports()
`)
    const result = spawnSync(process.execPath, [
      '--import',
      preload,
      '--experimental-strip-types',
      '--no-warnings',
      resolve('packages/cli/src/cli.ts'),
      'rename-file',
      'source.ts',
      'moved/target.ts',
      '--no-vue',
      '--verify-mode',
      'none',
      '--apply',
      '--profile',
      'full',
      '--json',
    ], { cwd: fixture.dir, encoding: 'utf8' })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /injected write failure/)
    assert.equal(fixture.read('source.ts'), 'export const value = 42\n')
    assert.equal(existsSync(resolve(fixture.dir, 'moved/target.ts')), false)
  }
  finally { fixture.cleanup() }
})

it('rename-file applies consumer and moved-file imports as one operation', () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module"}',
    'dep.ts': 'export const value = 42\n',
    'source.ts': 'export { value } from "./dep.ts"\n',
    'consumer.ts': 'import { value } from "./source.ts"\nconsole.log(value)\n',
  })
  try {
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      '--no-warnings',
      resolve('packages/cli/src/cli.ts'),
      'rename-file',
      'source.ts',
      'moved/target.ts',
      '--no-vue',
      '--apply',
      '--profile',
      'full',
      '--json',
    ], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout)._tag, 'Applied')
    assert.equal(existsSync(resolve(fixture.dir, 'source.ts')), false)
    const consumer = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'consumer.ts'], {
      cwd: fixture.dir,
      encoding: 'utf8',
    })
    assert.equal(consumer.status, 0, consumer.stderr)
    assert.equal(consumer.stdout.trim(), '42')
  }
  finally { fixture.cleanup() }
})
