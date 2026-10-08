import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { parseSourceFile } from '../packages/core/src/adapter.ts'
import { runMove, writeChanges } from '../packages/core/src/index.ts'
import { makeFixture } from './helpers.ts'

it.each([
  ['runtime extension', 'helper', './source.js', './target.js'],
  ['escaped identifier', 'h\\u0065lper', './source.ts', './target.ts'],
])('move updates consumers with %s', async (_, name, oldSpecifier, newSpecifier) => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\n',
    'target.ts': '',
    'consumer.ts': `import { ${name} as local } from '${oldSpecifier}'\nexport const result = local()\n`,
  })
  try {
    const result = await runMove('helper', 'source.ts', 'target.ts', { cwd: fx.dir, verify: false, vue: false })
    const consumer = result.changes.find(change => change.rel === 'consumer.ts')
    assert.ok(consumer, 'consumer must be rewritten')
    const imported = parseSourceFile('consumer.ts', consumer.after).program.body.find((node: any) => node.type === 'ImportDeclaration')
    assert.equal(imported.source.value, newSpecifier)
  }
  finally { fx.cleanup() }
})

it('move preserves two local aliases for the same destination export', async () => {
  const fx = makeFixture({
    'source.ts': 'import { value as copied } from \'./dependency.ts\'\nexport function helper() { return copied }\n',
    'dependency.ts': 'export const value = 42\n',
    'target.ts': 'import { value as existing } from \'./dependency.ts\'\nexport const before = existing\n',
  })
  try {
    const result = await runMove('helper', 'source.ts', 'target.ts', { cwd: fx.dir, verify: false, vue: false })
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `const target = await import(${JSON.stringify(pathToFileURL(`${fx.dir}/target.ts`).href)}); console.log(target.before + target.helper())`], { encoding: 'utf8' })
    assert.equal(output.trim(), '84')
  }
  finally { fx.cleanup() }
})

it.each([
  ['default aliases', 'import copied from \'./dependency.ts\'', 'import existing from \'./dependency.ts\'', 'copied', 'existing', 'export default 42'],
  ['namespace aliases', 'import * as copied from \'./dependency.ts\'', 'import * as existing from \'./dependency.ts\'', 'copied.value', 'existing.value', 'export const value = 42'],
  ['namespace and named', 'import { value as copied } from \'./dependency.ts\'', 'import * as existing from \'./dependency.ts\'', 'copied', 'existing.value', 'export const value = 42'],
])('move preserves imported bindings with %s', async (_, copiedImport, existingImport, copiedExpression, existingExpression, dependency) => {
  const fx = makeFixture({
    'source.ts': `${copiedImport}\nexport function helper() { return ${copiedExpression} }\n`,
    'dependency.ts': `${dependency}\n`,
    'target.ts': `${existingImport}\nexport const before = ${existingExpression}\n`,
  })
  try {
    const result = await runMove('helper', 'source.ts', 'target.ts', { cwd: fx.dir, verify: false, vue: false })
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `const target = await import(${JSON.stringify(pathToFileURL(`${fx.dir}/target.ts`).href)}); console.log(target.before + target.helper())`], { encoding: 'utf8' })
    assert.equal(output.trim(), '84')
  }
  finally { fx.cleanup() }
})
