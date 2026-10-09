import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { runDelete, writeChanges } from '../packages/core/src/index.ts'
import { makeFixture } from './helpers.ts'

it.each([
  ['excluded TS', 'consumer.ts', false, 'import { helper } from \'./source.ts\'\nexport const result = helper()'],
  ['JS without allowJs', 'consumer.js', false, 'import { helper } from \'./source.ts\'\nexport const result = helper()'],
  ['JS with allowJs', 'consumer.js', true, 'import { helper } from \'./source.ts\'\nexport const result = helper()'],
  ['re-export alias', 'consumer.ts', false, 'export { helper as renamed } from \'./source.ts\''],
  ['wildcard consumer', 'consumer.ts', false, 'import { helper } from \'./barrel.ts\'\nexport const result = helper()'],
])('delete refuses an external consumer, %s', async (_, consumer, allowJs, source) => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\n',
    'barrel.ts': 'export * from \'./source.ts\'',
    [consumer]: source,
    'tsconfig.json': JSON.stringify({ compilerOptions: { allowJs, module: 'ESNext', moduleResolution: 'bundler', allowImportingTsExtensions: true, noEmit: true }, files: ['source.ts'] }),
  })
  try {
    await assert.rejects(runDelete('helper', 'source.ts', { cwd: fx.dir, verifyMode: 'none' as const }), /still has.*reference[\s\S]*consumer\./)
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `console.log((await import(${JSON.stringify(pathToFileURL(`${fx.dir}/source.ts`).href)})).helper())`], { encoding: 'utf8' })
    assert.equal(output.trim(), '42')
  }
  finally { fx.cleanup() }
})

it.each([
  ['local', 'function helper() { return 7 }'],
  ['imported', 'import { helper } from \'./other.ts\''],
])('delete allows unrelated same-spelling %s identifiers in excluded consumers', async (_, binding) => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\nexport const other = 3\n',
    'consumer.ts': `${binding}\nexport const result = helper()\n`,
    'other.ts': 'export function helper() { return 7 }',
    'tsconfig.json': JSON.stringify({ files: ['source.ts'] }),
  })
  try {
    const result = await runDelete('helper', 'source.ts', { cwd: fx.dir, verifyMode: 'none' as const })
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `const source = await import(${JSON.stringify(pathToFileURL(`${fx.dir}/source.ts`).href)}); const consumer = await import(${JSON.stringify(pathToFileURL(`${fx.dir}/consumer.ts`).href)}); console.log(JSON.stringify([source.helper, source.other, consumer.result]))`], { encoding: 'utf8' })
    assert.equal(output.trim(), '[null,3,7]')
  }
  finally { fx.cleanup() }
})
