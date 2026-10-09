import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs, { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { runDoctor, runMove, runRename, runRenameFile, writeChanges } from 'ripide-api'
import { createVueExtension } from 'ripide-vue'
import { it, vi } from 'vitest'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

const vue = createVueExtension().semantic!

it.each(['app\\composables\\useValue.ts', 'layers\\base\\utils\\value.ts', 'app\\nested\\types.d.ts'])('doctor filters convention paths with Windows separators: %s', (file) => {
  assert.equal(vue.doctor!.filterFinding!('', { check: 'orphan-file', file, message: '' }), false)
})

it('doctor keeps nested import targets and test directories consistent', async () => {
  const fx = makeFixture({
    'src/value.ts': 'export const value = 42\n',
    'src/index.ts': 'export { value } from "./value"\n',
    'src/main.ts': 'import { value } from "./index"; console.log(value)\n',
    'tests/integration/value.test.ts': 'export {}\n',
  })
  try {
    const report = await runDoctor({ ...{ cwd: fx.dir, checks: ['orphan-file', 'orphan-test', 'stale-import', 'stale-reexport'], noAdapters: true }, engine: vueServices() })
    assert.deepEqual(report.findings, [])
  }
  finally { fx.cleanup() }
})

it('doctor matches forward-slash entry and changed-file paths', async () => {
  const fx = makeFixture({ 'src/value.ts': 'export const value = 42\n' })
  try {
    const opts = { cwd: fx.dir, checks: ['orphan-file'], noAdapters: true, changedFiles: ['src/value.ts'] }
    const before = await runDoctor({ ...opts, engine: vueServices() })
    assert.deepEqual(before.findings.map(f => f.file.replace(/\\/g, '/')), ['src/value.ts'])
    assert.deepEqual((await runDoctor({ ...{ ...opts, entry: ['src/value.ts'] }, engine: vueServices() })).findings, [])
  }
  finally { fx.cleanup() }
})

it('renames and moves through native paths containing spaces and Unicode', async () => {
  const fx = makeFixture({
    'src café/source.ts': 'export const value = 42\r\n',
    'src café/main.ts': 'import { value } from "./source.ts"; console.log(value)\r\n',
    'lib space/target.ts': '',
  })
  try {
    writeChanges((await runRename('value', 'renamed', { ...{ cwd: fx.dir }, engine: vueServices() })).changes)
    const result = await runMove('renamed', join('src café', 'source.ts'), join('lib space', 'target.ts'), { ...{ cwd: fx.dir }, engine: vueServices() })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    assert.equal(execFileSync(process.execPath, [join(fx.dir, 'src café/main.ts')], { encoding: 'utf8' }).trim(), '42')
  }
  finally { fx.cleanup() }
})

it.each([false, true])('rewrites a file move and its own imports through native paths with vue=%s', async (useVue) => {
  const fx = makeFixture({
    'src café/value.ts': 'export const value = 42\r\n',
    'src café/source.ts': 'export { value } from "./value.ts"\r\n',
    'main.ts': 'import { value } from "./src café/source.ts"; console.log(value)\r\n',
  })
  try {
    const result = await runRenameFile(join('src café', 'source.ts'), join('lib space', 'source.ts'), { ...{ cwd: fx.dir, vue: useVue, verify: false }, engine: vueServices() })
    mkdirSync(dirname(result.fileMove.to), { recursive: true })
    renameSync(result.fileMove.from, result.fileMove.to)
    if (result.selfChange)
      writeFileSync(result.fileMove.to, result.selfChange.after)
    writeChanges(result.changes)
    assert.equal(execFileSync(process.execPath, [join(fx.dir, 'main.ts')], { encoding: 'utf8' }).trim(), '42')
  }
  finally { fx.cleanup() }
})

it('rewrites Vue consumers when moving from a native source path', async () => {
  const fx = makeFixture({
    'src/source.ts': 'export const value = 42\n',
    'lib/target.ts': '',
    'src/Main.vue': '<script setup lang="ts">\nimport { value } from "./source"\n</script>\n<template>{{ value }}</template>\n',
  })
  try {
    fx.write('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', noEmit: true }, include: ['**/*.ts', '**/*.vue'] }))
    const result = await runMove('value', join('src', 'source.ts'), join('lib', 'target.ts'), { ...{ cwd: fx.dir, verify: false }, engine: vueServices() })
    const change = result.changes.find(c => c.path === join(fx.dir, 'src/Main.vue'))
    assert.ok(change)
    assert.match(change.after, /from ['"]\.\.\/lib\/target['"]/)
  }
  finally { fx.cleanup() }
})

it('keeps Nuxt app component scopes separate with native paths', async () => {
  const fx = makeFixture({
    'nuxt.config.ts': 'export default {}\n',
    'apps/one/.nuxt/components.d.ts': 'export const OnlyOne: typeof import("../components/OnlyOne.vue")["default"]\n',
    'apps/one/components/OnlyOne.vue': '<template><div /></template>\n',
    'apps/one/pages/index.vue': '<template><OnlyOne /></template>\n',
    'apps/two/.nuxt/components.d.ts': 'export {}\n',
    'apps/two/pages/index.vue': '<template><OnlyOne /></template>\n',
  }, false)
  try {
    const report = await runDoctor({ ...{ cwd: fx.dir, checks: ['phantom-component'], frameworks: ['nuxt'] }, engine: vueServices() })
    assert.deepEqual(report.findings.map(f => f.file.replace(/\\/g, '/')), ['apps/two/pages/index.vue'])
  }
  finally { fx.cleanup() }
})

it.each([false, true])('plans a case-only file rename with vue=%s', async (useVue) => {
  const fx = makeFixture({
    'Source.ts': 'export const value = 42\n',
    'main.ts': 'import { value } from "./Source.ts"; console.log(value)\n',
  })
  try {
    const result = await runRenameFile('Source.ts', 'source.ts', { ...{ cwd: fx.dir, vue: useVue, verify: false }, engine: vueServices() })
    const change = result.changes.find(c => c.path === join(fx.dir, 'main.ts'))
    assert.ok(change)
    assert.match(change.after, /from ['"]\.\/source\.ts['"]/)
    renameSync(result.fileMove.from, result.fileMove.to)
    writeChanges(result.changes)
    assert.equal(execFileSync(process.execPath, [join(fx.dir, 'main.ts')], { encoding: 'utf8' }).trim(), '42')
  }
  finally { fx.cleanup() }
})

it('accepts the source entry under another casing on a case-insensitive filesystem', async () => {
  const fx = makeFixture({ 'Source.ts': 'export const value = 42\n' })
  const lstat = fs.lstatSync
  const source = join(fx.dir, 'Source.ts')
  const target = join(fx.dir, 'source.ts')
  const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, options: any) => lstat(path === target ? source : path, options)) as typeof lstat)
  syncBuiltinESMExports()
  try {
    const result = await runRenameFile('Source.ts', 'source.ts', { ...{ cwd: fx.dir, verify: false }, engine: vueServices() })
    assert.deepEqual(result.fileMove, { from: source, to: target })
    assert.equal(fx.read('Source.ts'), 'export const value = 42\n')
  }
  finally {
    lstatSpy.mockRestore()
    syncBuiltinESMExports()
    fx.cleanup()
  }
})
