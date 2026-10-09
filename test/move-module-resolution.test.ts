import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { parseSourceFile } from '../packages/core/src/adapter.ts'
import { runMove, startTsServer, writeChanges } from '../packages/core/src/index.ts'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

it('move resolves directory index modules', async () => {
  const fx = makeFixture({
    'source/index.ts': 'export function helper() { return 42 }\n',
    'target.ts': '',
    'consumer.ts': 'import { helper } from \'./source\'\nexport const result = helper()\n',
  })
  try {
    const result = await runMove('helper', 'source/index.ts', 'target.ts', { ...{ cwd: fx.dir, verifyMode: 'none' as const }, engine: vueServices() })
    const change = result.changes.find(change => change.rel === 'consumer.ts')
    assert.ok(change)
    assert.equal(parseSourceFile('consumer.ts', change.after).program.body[0].source.value, './target')
  }
  finally { fx.cleanup() }
})

it.each([
  ['namespace', 'import * as source from \'./source.ts\'\nexport const result = source.helper()\n'],
  ['namespace reexport', 'export * as source from \'./source.ts\'\n'],
  ['dynamic import', 'export const result = (await import(\'./source.ts\')).helper()\n'],
])('move refuses unsupported %s consumers', async (_, consumer) => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\nexport const other = 1\n',
    'target.ts': '',
    'consumer.ts': consumer,
  })
  try {
    await assert.rejects(runMove('helper', 'source.ts', 'target.ts', { ...{ cwd: fx.dir, verifyMode: 'none' as const }, engine: vueServices() }), /consumer\.ts.*Use named imports first/)
  }
  finally { fx.cleanup() }
})

it('move preserves exports through wildcard barrels', async () => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\nexport const other = 1\n',
    'target.ts': '',
    'consumer.ts': 'export * from \'./source.ts\'\n',
    'downstream.ts': 'import { helper, other } from \'./consumer.ts\'\nexport const result = helper() + other\n',
  })
  try {
    writeChanges((await runMove('helper', 'source.ts', 'target.ts', { ...{ cwd: fx.dir, verifyMode: 'none' as const }, engine: vueServices() })).changes)
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `console.log((await import(${JSON.stringify(pathToFileURL(`${fx.dir}/downstream.ts`).href)})).result)`], { encoding: 'utf8' })
    assert.equal(output.trim(), '43')
  }
  finally { fx.cleanup() }
})

it.each([
  ['template module path', 'export const result = (await import(`./source.ts`)).helper()'],
  ['computed module path', 'const path = "./source.ts"; export const result = (await import(path)).helper()'],
])('move refuses unsupported dynamic imports with %s', async (_, consumer) => {
  const fx = makeFixture({ 'source.ts': 'export function helper() { return 42 }\n', 'target.ts': '', 'consumer.ts': consumer })
  try {
    await assert.rejects(runMove('helper', 'source.ts', 'target.ts', { ...{ cwd: fx.dir, verifyMode: 'none' as const }, engine: vueServices() }), /consumer\.ts.*Use named imports first/)
  }
  finally { fx.cleanup() }
})

it('move keeps an emptied source module valid for wildcard barrels', async () => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\n',
    'target.ts': '',
    'consumer.ts': 'export * from \'./source.ts\'\n',
    'downstream.ts': 'import { helper } from \'./consumer.ts\'\nexport const result = helper()\n',
  })
  try {
    const result = await runMove('helper', 'source.ts', 'target.ts', { ...{ cwd: fx.dir }, engine: vueServices() })
    assert.deepEqual(result.regressions, [])
  }
  finally { fx.cleanup() }
})

it('move refuses module type queries that include the moved export', async () => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\n',
    'target.ts': '',
    'consumer.ts': 'export type All = typeof import(\'./source.ts\')\n',
  })
  try {
    await assert.rejects(runMove('helper', 'source.ts', 'target.ts', { ...{ cwd: fx.dir, verifyMode: 'none' as const }, engine: vueServices() }), /consumer\.ts.*Use named imports first/)
  }
  finally { fx.cleanup() }
})

it('move refuses ambiguous emitted and source modules', async () => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 1 }\n',
    'source.js': 'export function helper() { return 2 }\n',
    'target.ts': '',
    'consumer.ts': 'import { helper } from \'./source.js\'\nexport const result = helper()\n',
  })
  try {
    const server = await startTsServer(fx.dir)
    try {
      const definitions = await server.definition(`${fx.dir}/consumer.ts`, 'import { '.length)
      assert.ok(definitions.some(definition => definition.path === `${fx.dir}/source.ts`))
    }
    finally { server.dispose() }
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `console.log((await import(${JSON.stringify(pathToFileURL(`${fx.dir}/consumer.ts`).href)})).result)`], { encoding: 'utf8' })
    assert.equal(output.trim(), '2')
    await assert.rejects(runMove('helper', 'source.ts', 'target.ts', { ...{ cwd: fx.dir, verifyMode: 'none' as const }, engine: vueServices() }), /ambiguous.*source\.js/)
  }
  finally { fx.cleanup() }
})

it.each([
  ['setup namespace', 'import * as source from \'./source.ts\'; const result = source.helper() + source.other', 'script setup'],
  ['setup dynamic', 'const source = await import(\'./source.ts\'); const result = source.helper() + source.other', 'script setup'],
  ['normal namespace', 'import * as source from \'./source.ts\'; const result = source.helper() + source.other', 'script'],
  ['normal dynamic', 'const source = await import(\'./source.ts\'); const result = source.helper() + source.other', 'script'],
])('move refuses unsupported Vue %s imports', async (_, script, tag) => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\nexport const other = 1\n',
    'target.ts': '',
    'consumer.vue': `<${tag} lang="ts">${script}</script><template>{{ result }}</template>`,
  })
  try {
    await assert.rejects(runMove('helper', 'source.ts', 'target.ts', { ...{ cwd: fx.dir, verifyMode: 'none' as const }, engine: vueServices() }), /consumer\.vue.*Use named imports first/)
  }
  finally { fx.cleanup() }
})
