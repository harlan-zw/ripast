import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { runDelete } from '../packages/core/src/index.ts'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

it.each([
  ['fixed escape', 'import { \\u0068elper as chosen } from \'./source.ts\'\nexport const result = chosen()\n', 'result'],
  ['brace escape', 'import { \\u{68}elper as chosen } from \'./source.ts\'\nexport const result = chosen()\n', 'result'],
  ['re-export alias', 'export { \\u0068elper as chosen } from \'./source.ts\'\n', 'chosen()'],
])('delete refuses an excluded consumer using an identifier %s', async (_, source, expression) => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\n',
    'consumer.ts': source,
    'tsconfig.json': JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', allowImportingTsExtensions: true, noEmit: true }, files: ['source.ts'] }),
  })
  try {
    await assert.rejects(runDelete('helper', 'source.ts', { ...{ cwd: fx.dir }, engine: vueServices() }), /still has.*reference[\s\S]*consumer\.ts/)
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `console.log((await import(${JSON.stringify(pathToFileURL(`${fx.dir}/consumer.ts`).href)})).${expression})`], { encoding: 'utf8' })
    assert.equal(output.trim(), '42')
  }
  finally { fx.cleanup() }
})
