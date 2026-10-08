import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { compileScript, parse } from '@vue/compiler-sfc'
import { it } from 'vitest'
import { runDelete, writeChanges } from '../packages/core/src/index.ts'
import { makeFixture } from './helpers.ts'

it.each([
  ['script', 'import { helper } from \'./source.ts\'\nconst result = helper()', '<div />'],
  ['template', 'import { helper } from \'./source.ts\'', '<div>{{ helper() }}</div>'],
  ['alias', 'import { helper as renamed } from \'./source.ts\'', '<div>{{ renamed() }}</div>'],
  ['namespace template', 'import * as utils from \'./source.ts\'', '<div>{{ utils.helper() }}</div>'],
  ['computed namespace template', 'import * as utils from \'./source.ts\'', '<div>{{ utils[\'helper\']() }}</div>'],
  ['multiline namespace template', 'import * as utils from \'./source.ts\'', '<div>{{\nutils.helper()\n}}</div>'],
])('delete refuses a Vue %s consumer', async (_, script, template) => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\n',
    'Consumer.vue': `<script setup lang="ts">\n${script}\n</script>\n<template>${template}</template>`,
  })
  try {
    const location = _ === 'multiline namespace template' ? /still has.*reference[\s\S]*Consumer\.vue:5:/ : /still has.*reference[\s\S]*Consumer\.vue/
    await assert.rejects(runDelete('helper', 'source.ts', { cwd: fx.dir, verify: false }), location)
  }
  finally { fx.cleanup() }
})

it.each([
  ['local', 'function helper() { return 7 }'],
  ['imported', 'import { helper } from \'./other.ts\''],
  ['imported namespace', 'import * as utils from \'./other.ts\'\nconst helper = () => utils.helper()'],
  ['namespace', 'import * as utils from \'./source.ts\'\nconst helper = () => utils.other'],
])('delete allows unrelated same-spelling Vue %s names', async (_, binding) => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\nexport const other = 7\n',
    'other.ts': 'export function helper() { return 7 }',
    'Consumer.vue': `<script>${binding}\nexport default { value: helper() }</script><template>{{ helper() }}</template>`,
  })
  try {
    writeChanges((await runDelete('helper', 'source.ts', { cwd: fx.dir, verify: false })).changes)
    const { descriptor } = parse(fx.read('Consumer.vue'))
    fx.write('Consumer.ts', compileScript(descriptor, { id: 'consumer' }).content)
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `console.log((await import(${JSON.stringify(pathToFileURL(`${fx.dir}/Consumer.ts`).href)})).default.value)`], { encoding: 'utf8' })
    assert.equal(output.trim(), '7')
  }
  finally { fx.cleanup() }
})

it('delete checks both Vue script blocks without a tsconfig', async () => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\n',
    'Consumer.vue': '<script>import { helper } from \'./source.ts\'\nexport default { result: helper() }</script><script setup>const longer = "unrelated longer setup block"</script><template>{{ longer }}</template>',
  }, false)
  try {
    await assert.rejects(runDelete('helper', 'source.ts', { cwd: fx.dir, verify: false }), /still has.*reference[\s\S]*Consumer\.vue/)
  }
  finally { fx.cleanup() }
})
