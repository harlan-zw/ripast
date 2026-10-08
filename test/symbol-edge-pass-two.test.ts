import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSourceFile, isFunctionDeclaration, isImportDeclaration, isMappedTypeNode, isModuleDeclaration, isNamedImports, isTypeAliasDeclaration, isVariableStatement, ScriptTarget } from 'typescript'
import { it } from 'vitest'
import { runRename, runReplace, writeChanges } from '../packages/core/src/index.ts'
import { makeFixture } from './helpers.ts'

it('rename finds generic type parameter declarations', async () => {
  const fx = makeFixture({ 'consumer.ts': 'export function identity<Old>(value: Old): Old { return value }\n' })
  try {
    const result = await runRename('Old', 'Better', { cwd: fx.dir, vue: false })
    assert.deepEqual(result.regressions, [])
    const parsed = createSourceFile('consumer.ts', result.changes[0].after, ScriptTarget.Latest, true)
    const declaration = parsed.statements.find(isFunctionDeclaration)!
    assert.equal(declaration.typeParameters![0].name.text, 'Better')
  }
  finally { fx.cleanup() }
})

it('rename finds namespace declarations', async () => {
  const fx = makeFixture({ 'consumer.ts': 'namespace Old { export const value = 3 }\nexport const result = Old.value\n' })
  try {
    const result = await runRename('Old', 'Better', { cwd: fx.dir, vue: false })
    assert.deepEqual(result.regressions, [])
    const parsed = createSourceFile('consumer.ts', result.changes[0].after, ScriptTarget.Latest, true)
    const declaration = parsed.statements.find(isModuleDeclaration)!
    assert.equal(declaration.name.getText(parsed), 'Better')
  }
  finally { fx.cleanup() }
})

it('rename finds scoped imported aliases', async () => {
  const fx = makeFixture({
    'value.ts': 'export const value = 3\n',
    'consumer.ts': 'import { value as old } from "./value.ts"\nexport const result = old\n',
  })
  try {
    const result = await runRename('old', 'better', { cwd: fx.dir, scope: 'consumer.ts', vue: false })
    assert.deepEqual(result.regressions, [])
    const parsed = createSourceFile('consumer.ts', result.changes[0].after, ScriptTarget.Latest, true)
    const declaration = parsed.statements.find(isImportDeclaration)!
    const bindings = declaration.importClause!.namedBindings!
    assert.ok(isNamedImports(bindings))
    assert.equal(bindings.elements[0].name.text, 'better')
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(resolve(fx.dir, 'consumer.ts')).href)
    assert.equal(consumer.result, 3)
  }
  finally { fx.cleanup() }
})

it('replace can target a declaration exported through a local alias', async () => {
  const fx = makeFixture({
    'old.ts': 'export const old = 1\n',
    'target.ts': 'const inner = 3\nexport { inner as better }\n',
    'consumer.ts': 'import { old } from "./old.ts"\nexport const result = old\n',
  })
  try {
    writeChanges((await runReplace('old', 'better', { cwd: fx.dir, verify: false })).changes)
    const consumer = await import(pathToFileURL(resolve(fx.dir, 'consumer.ts')).href)
    assert.equal(consumer.result, 3)
  }
  finally { fx.cleanup() }
})

it('rename all includes local shadows beside top-level declarations', async () => {
  const fx = makeFixture({ 'consumer.ts': 'export const old = 1\nexport function run() { const old = 2; return old }\n' })
  try {
    const result = await runRename('old', 'better', { cwd: fx.dir, allowMultiple: true, vue: false })
    const parsed = createSourceFile('consumer.ts', result.changes[0].after, ScriptTarget.Latest, true)
    const declaration = parsed.statements.find(isFunctionDeclaration)!
    const variable = declaration.body!.statements.find(isVariableStatement)!
    assert.equal(variable.declarationList.declarations[0].name.getText(parsed), 'better')
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(resolve(fx.dir, 'consumer.ts')).href)
    assert.equal(consumer.better, 1)
    assert.equal(consumer.run(), 2)
  }
  finally { fx.cleanup() }
})

it('rename handles overload declarations as one symbol', async () => {
  const fx = makeFixture({ 'consumer.ts': 'export function old(value: string): string;\nexport function old(value: number): number;\nexport function old(value: string | number) { return value }\n' })
  try {
    const result = await runRename('old', 'better', { cwd: fx.dir, vue: false })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(resolve(fx.dir, 'consumer.ts')).href)
    assert.equal(consumer.better(3), 3)
    assert.equal(consumer.better('value'), 'value')
  }
  finally { fx.cleanup() }
})

it('rename accepts merged namespace declarations', async () => {
  const fx = makeFixture({ 'consumer.ts': 'namespace Old { export const first = 1 }\nnamespace Old { export const second = 2 }\nexport const result = Old.first + Old.second\n' })
  try {
    const result = await runRename('Old', 'Better', { cwd: fx.dir, vue: false })
    assert.deepEqual(result.regressions, [])
    const parsed = createSourceFile('consumer.ts', result.changes[0].after, ScriptTarget.Latest, true)
    assert.deepEqual(parsed.statements.filter(isModuleDeclaration).map(declaration => declaration.name.getText(parsed)), ['Better', 'Better'])
  }
  finally { fx.cleanup() }
})

it('rename finds ambient function declarations', async () => {
  const fx = makeFixture({
    'ambient.ts': 'export declare function old(): number;\n',
    'consumer.ts': 'import { old } from "./ambient.ts"\nexport const result: number = old()\n',
  })
  try {
    const result = await runRename('old', 'better', { cwd: fx.dir, scope: 'ambient.ts', vue: false })
    assert.deepEqual(result.regressions, [])
    const parsed = createSourceFile('ambient.ts', result.changes.find(change => change.rel === 'ambient.ts')!.after, ScriptTarget.Latest, true)
    assert.equal(parsed.statements.find(isFunctionDeclaration)!.name!.text, 'better')
    assert.equal(result.changes.length, 2)
  }
  finally { fx.cleanup() }
})

it('rename finds mapped type key declarations', async () => {
  const fx = makeFixture({ 'consumer.ts': 'export type Box = { [Old in "x"]: Old }\n' })
  try {
    const result = await runRename('Old', 'Better', { cwd: fx.dir, vue: false })
    assert.deepEqual(result.regressions, [])
    const parsed = createSourceFile('consumer.ts', result.changes[0].after, ScriptTarget.Latest, true)
    const declaration = parsed.statements.find(isTypeAliasDeclaration)!
    assert.ok(isMappedTypeNode(declaration.type))
    assert.equal(declaration.type.typeParameter.name.text, 'Better')
  }
  finally { fx.cleanup() }
})
