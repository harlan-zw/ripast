import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { runDelete } from '../packages/core/src/index.ts'
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
    await assert.rejects(runDelete('helper', 'source.ts', { cwd: fx.dir }), reason)
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
    await assert.rejects(runDelete('helper', 'source.ts', { cwd: fx.dir }), /external script[\s\S]*Consumer\.vue/)
  }
  finally { fx.cleanup() }
})

it('delete refuses a namespace containing a type export', async () => {
  const fx = makeFixture({
    'source.ts': 'export interface Shape { value: number }',
    'Consumer.ts': 'import type * as utils from \'./source.ts\'',
  })
  try {
    await assert.rejects(runDelete('Shape', 'source.ts', { cwd: fx.dir }), /namespace import at Consumer\.ts:1:/)
  }
  finally { fx.cleanup() }
})
