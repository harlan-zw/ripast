import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { runDelete } from '../packages/core/src/index.ts'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

it.each([
  ['TS dynamic member', 'Consumer.ts', 'import * as utils from \'./source.ts\'\nconst key = \'helper\'\nexport const result = utils[key]()'],
  ['TS whole namespace', 'Consumer.ts', 'import * as utils from \'./source.ts\'\nexport const result = Object.values(utils).map(fn => fn())'],
  ['JS whole namespace', 'Consumer.js', 'import * as utils from \'./source.ts\'\nexport const result = Object.values(utils).map(fn => fn())'],
  ['TS wildcard barrel', 'Consumer.ts', 'import * as utils from \'./barrel.ts\'\nexport const result = Object.values(utils).map(fn => fn())'],
  ['TS path alias', 'Consumer.ts', 'import * as utils from \'@source\'\nexport const result = Object.values(utils).map(fn => fn())'],
  ['Vue dynamic template', 'Consumer.vue', '<script setup>import * as utils from \'./source.ts\'\nconst key = "helper"</script><template>{{ utils[key]() }}</template>'],
  ['Vue TSX', 'Consumer.vue', '<script setup lang="tsx">import * as utils from \'./source.ts\'\nconst result = utils.helper()\nconst view = <div>{result}</div></script><template>{{ result }}</template>'],
  ['Vue wildcard barrel', 'Consumer.vue', '<script setup>import * as utils from \'./barrel.ts\'</script><template>{{ Object.values(utils).map(fn => fn()) }}</template>'],
  ['Vue other member', 'Consumer.vue', '<script setup>import * as utils from \'./source.ts\'</script><template>{{ utils.other }}</template>'],
  ['Vue template shadow', 'Consumer.vue', '<script setup>import * as utils from \'./source.ts\'</script><template><div v-for="utils in [{ helper: () => 7 }]">{{ utils.helper() }}</div></template>'],
  ['Vue malformed template expression', 'Consumer.vue', '<script setup>import * as utils from \'./source.ts\'</script><template>{{ utils[ }}</template>'],
])('delete refuses a namespace containing the export, %s', async (_, file, consumer) => {
  const fx = makeFixture({
    'source.ts': `export function helper() { return 42 }\n${_ === 'Vue other member' ? 'export const other = 7\n' : ''}`,
    'barrel.ts': 'export * from \'./nested.ts\'',
    'nested.ts': 'export * from \'./source.ts\'',
    [file]: consumer,
    'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', allowImportingTsExtensions: true, noEmit: true, paths: { '@source': ['./source.ts'] } }, files: ['source.ts'] }),
  })
  try {
    const reason = _ === 'Vue malformed template expression' ? /cannot inspect Consumer\.vue:\d+:\d+ because.*parse errors/ : /namespace import[\s\S]*Consumer\./
    await assert.rejects(runDelete('helper', 'source.ts', { ...{ cwd: fx.dir }, engine: vueServices() }), reason)
  }
  finally { fx.cleanup() }
})

it('delete CLI refuses namespace usage before applying changes', () => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\n',
    'Consumer.ts': 'import * as utils from \'./source.ts\'\nexport const result = Object.values(utils).map(fn => fn())',
  })
  try {
    const command = spawnSync(process.execPath, ['--experimental-strip-types', resolve('packages/cli/src/cli.ts'), 'delete', 'helper', '--from', 'source.ts', '--apply'], { cwd: fx.dir, encoding: 'utf8' })
    assert.equal(command.status, 1)
    assert.match(command.stderr, /namespace import at Consumer\.ts:1:/)
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `console.log((await import(${JSON.stringify(pathToFileURL(`${fx.dir}/source.ts`).href)})).helper())`], { encoding: 'utf8' })
    assert.equal(output.trim(), '42')
  }
  finally { fx.cleanup() }
})

it('delete refuses an external Vue script when usage cannot be proved', async () => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\nexport default {}\n',
    'Consumer.vue': '<script src="./source.ts"></script><template>{{ helper() }}</template>',
  })
  try {
    await assert.rejects(runDelete('helper', 'source.ts', { ...{ cwd: fx.dir }, engine: vueServices() }), /external script[\s\S]*Consumer\.vue/)
  }
  finally { fx.cleanup() }
})

it('delete refuses a namespace containing a type export', async () => {
  const fx = makeFixture({
    'source.ts': 'export interface Shape { value: number }',
    'Consumer.ts': 'import type * as utils from \'./source.ts\'',
  })
  try {
    await assert.rejects(runDelete('Shape', 'source.ts', { ...{ cwd: fx.dir }, engine: vueServices() }), /namespace import at Consumer\.ts:1:/)
  }
  finally { fx.cleanup() }
})

it('delete resolves namespaces after opening excluded ambient declarations', async () => {
  const fx = makeFixture({
    'source.ts': 'export const helper = 42\nexport const keep = 7\n',
    'aa.ts': 'import * as ns from \'virtual\'\nexport const values = Object.values(ns)',
    'ac.vue': '<script setup lang="ts">import * as ns from \'virtual\'</script><template>{{ ns.keep }}</template>',
    'zz.d.ts': 'declare module \'virtual\' { export const keep: number }',
    'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', noEmit: true }, files: ['source.ts'] }),
  })
  try {
    const result = await runDelete('helper', 'source.ts', { ...{ cwd: fx.dir, verify: false }, engine: vueServices() })
    assert.equal(result.changes[0]!.after, 'export const keep = 7\n')
    assert.equal(fx.read('source.ts'), 'export const helper = 42\nexport const keep = 7\n')
  }
  finally { fx.cleanup() }
})

it('delete keeps same-text namespace imports in different directories separate', async () => {
  const fx = makeFixture({
    'source.ts': 'export interface Shape { value: number }',
    'one/module.ts': 'export const other = 7',
    'one/consumer.ts': 'import * as ns from \'./module.ts\'\nexport const values = Object.values(ns)',
    'two/module.ts': 'export * from \'../source.ts\'',
    'two/consumer.ts': 'import * as ns from \'./module.ts\'\nexport type Value = ns.Shape',
  })
  try {
    await assert.rejects(runDelete('Shape', 'source.ts', { ...{ cwd: fx.dir, verify: false }, engine: vueServices() }), /namespace import at two\/consumer\.ts:1:/)
  }
  finally { fx.cleanup() }
})

it('delete checks namespace resolution again in each operation', async () => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }',
    'module.ts': 'export const other = 7',
    'a.ts': 'import * as ns from \'./module.ts\'\nexport const values = Object.values(ns)',
    'b.vue': '<script setup>import * as ns from \'./module.ts\'</script><template>{{ ns.other }}</template>',
  })
  try {
    const result = await runDelete('helper', 'source.ts', { ...{ cwd: fx.dir, verify: false }, engine: vueServices() })
    assert.equal(result.changes[0]!.after, '')
    fx.write('module.ts', 'export * from \'./source.ts\'')
    await assert.rejects(runDelete('helper', 'source.ts', { ...{ cwd: fx.dir, verify: false }, engine: vueServices() }), /namespace import at (a\.ts|b\.vue):1:/)
  }
  finally { fx.cleanup() }
})

it('delete still refuses an unresolved namespace after a resolved namespace', async () => {
  const fx = makeFixture({
    'source.ts': 'export const helper = 42',
    'module.ts': 'export const other = 7',
    'consumer.ts': 'import * as ns from \'./module.ts\'\nimport * as missing from \'./missing.ts\'\nexport const values = [Object.values(ns), Object.values(missing)]',
  })
  try {
    await assert.rejects(runDelete('helper', 'source.ts', { ...{ cwd: fx.dir, verify: false }, engine: vueServices() }), /cannot resolve a namespace import at consumer\.ts:2:/)
  }
  finally { fx.cleanup() }
})
