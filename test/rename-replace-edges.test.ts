import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSourceFile, isFunctionDeclaration, ScriptTarget } from 'typescript'
import { it } from 'vitest'
import { runRename, runReplace, writeChanges } from './engine-sdk.ts'
import { makeFixture } from './helpers.ts'

it('replace preserves object shorthand keys', async () => {
  const fx = makeFixture({
    'old.ts': 'export const old = 1\n',
    'better.ts': 'export const better = 2\n',
    'consumer.ts': 'import { old } from "./old.ts"\nexport const result = { old }\n',
  })
  try {
    writeChanges((await runReplace('old', 'better', { cwd: fx.dir, verify: false })).changes)
    const consumer = await import(pathToFileURL(resolve(fx.dir, 'consumer.ts')).href)
    assert.deepEqual(consumer.result, { old: 2 })
  }
  finally { fx.cleanup() }
})

it('rename finds destructured local declarations', async () => {
  const fx = makeFixture({
    'consumer.ts': 'export function run() { const { old } = { old: 3 }; return old }\n',
  })
  try {
    const result = await runRename('old', 'better', { cwd: fx.dir, verify: false })
    assert.equal(result.changes.length, 1)
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(resolve(fx.dir, 'consumer.ts')).href)
    assert.equal(consumer.run(), 3)
  }
  finally { fx.cleanup() }
})

it('rename finds function parameters', async () => {
  const fx = makeFixture({
    'consumer.ts': 'export function run(old: number) { return old + 1 }\n',
  })
  try {
    const result = await runRename('old', 'better', { cwd: fx.dir, verify: false })
    assert.equal(result.changes.length, 1)
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(resolve(fx.dir, 'consumer.ts')).href)
    assert.equal(consumer.run(3), 4)
  }
  finally { fx.cleanup() }
})

it('replace preserves public export names', async () => {
  const fx = makeFixture({
    'old.ts': 'export const old = 1\n',
    'better.ts': 'export const better = 2\n',
    'consumer.ts': 'import { old } from "./old.ts"\nexport { old }\n',
    'downstream.ts': 'import { old } from "./consumer.ts"\nexport const result = old\n',
  })
  try {
    writeChanges((await runReplace('old', 'better', { cwd: fx.dir, glob: ['consumer.ts', 'better.ts'], verify: false })).changes)
    const downstream = await import(pathToFileURL(resolve(fx.dir, 'downstream.ts')).href)
    assert.equal(downstream.result, 2)
  }
  finally { fx.cleanup() }
})

it('rename finds top-level destructured declarations', async () => {
  const fx = makeFixture({
    'consumer.ts': 'export const { old } = { old: 3 }\n',
  })
  try {
    writeChanges((await runRename('old', 'better', { cwd: fx.dir, verify: false })).changes)
    const consumer = await import(pathToFileURL(resolve(fx.dir, 'consumer.ts')).href)
    assert.equal(consumer.better, 3)
  }
  finally { fx.cleanup() }
})

it.each([
  ['array', 'export function run() { const [old] = [3]; return old }\n'],
  ['nested default', 'export function run() { const { item: { old = 3 } } = { item: {} }; return old }\n'],
  ['object rest', 'export function run() { const { first, ...old } = { first: 1, value: 3 }; return old.value }\n'],
  ['parameter destructuring', 'export function run({ old = 3 } = {}) { return old }\n'],
  ['catch', 'export function run() { try { throw 3 } catch (old) { return old } }\n'],
  ['class method', 'export class Counter { run(old: number) { return old } }\nexport const run = () => new Counter().run(3)\n'],
])('rename supports %s bindings', async (_name, source) => {
  const fx = makeFixture({ 'consumer.ts': source })
  try {
    const result = await runRename('old', 'better', { cwd: fx.dir, verify: false })
    assert.equal(result.changes.length, 1)
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(resolve(fx.dir, 'consumer.ts')).href)
    assert.equal(consumer.run(), 3)
  }
  finally { fx.cleanup() }
})

it.each([
  ['class', 'export class Old { value = 3 }\n', 'export const result = new Old().value\n'],
  ['type', 'export type Old = { value: number }\n', 'export const result: Old = { value: 3 }\n'],
])('rename keeps exported %s consumers valid', async (_kind, source, consumerSource) => {
  const fx = makeFixture({
    'old.ts': source,
    'consumer.ts': `import { Old } from "./old.ts"\n${consumerSource}`,
  })
  try {
    const result = await runRename('Old', 'Better', { cwd: fx.dir })
    assert.equal(result.changes.length, 2)
    assert.deepEqual(result.regressions, [])
  }
  finally { fx.cleanup() }
})

it('replace preserves aliased shorthand keys and export names', async () => {
  const fx = makeFixture({
    'old.ts': 'export const old = 1\n',
    'better.ts': 'export const better = 2\n',
    'consumer.ts': 'import { old as alias } from "./old.ts"\nexport const result = { alias }\nexport { alias, alias as publicName }\n',
  })
  try {
    writeChanges((await runReplace('alias', 'better', { cwd: fx.dir, verify: false })).changes)
    const consumer = await import(pathToFileURL(resolve(fx.dir, 'consumer.ts')).href)
    assert.deepEqual(consumer.result, { alias: 2 })
    assert.equal(consumer.alias, 2)
    assert.equal(consumer.publicName, 2)
  }
  finally { fx.cleanup() }
})

it('replace keeps shorthand and export names when target has the same name', async () => {
  const fx = makeFixture({
    'old.ts': 'export const old = 1\n',
    'better.ts': 'export const old = 2\n',
    'consumer.ts': 'import { old } from "./old.ts"\nexport const result = { old }\nexport { old }\n',
  })
  try {
    writeChanges((await runReplace('old', 'old', { cwd: fx.dir, targetScope: 'better.ts', verify: false })).changes)
    const consumer = await import(pathToFileURL(resolve(fx.dir, 'consumer.ts')).href)
    assert.deepEqual(consumer.result, { old: 2 })
    assert.equal(consumer.old, 2)
  }
  finally { fx.cleanup() }
})

it('replace leaves references through other imports of the same symbol intact', async () => {
  const fx = makeFixture({
    'old.ts': 'export const old = 1\n',
    'better.ts': 'export const better = 2\n',
    'consumer.ts': 'import { old, old as alias } from "./old.ts"\nimport * as ns from "./old.ts"\nexport { old as passthrough } from "./old.ts"\nexport const result = [old, alias, ns.old]\n',
  })
  try {
    writeChanges((await runReplace('old', 'better', { cwd: fx.dir, verify: false })).changes)
    const consumer = await import(pathToFileURL(resolve(fx.dir, 'consumer.ts')).href)
    assert.deepEqual(consumer.result, [2, 1, 1])
    assert.equal(consumer.passthrough, 1)
  }
  finally { fx.cleanup() }
})

it('rename all includes parameters beside local variable declarations', async () => {
  const fx = makeFixture({
    'consumer.ts': 'export function first(old: number) { return old }\nexport function second() { const old = 2; return old }\n',
  })
  try {
    const result = await runRename('old', 'better', { cwd: fx.dir, verify: false, allowMultiple: true })
    const program = createSourceFile('consumer.ts', result.changes[0].after, ScriptTarget.Latest, true)
    const first = program.statements.find(isFunctionDeclaration)!
    assert.equal(first.parameters[0].name.getText(program), 'better')
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(resolve(fx.dir, 'consumer.ts')).href)
    assert.equal(consumer.first(3), 3)
    assert.equal(consumer.second(), 2)
  }
  finally { fx.cleanup() }
})

it('replace refuses escaped references before removing their import', async () => {
  const source = 'import { old } from "./old.ts"\nexport const result = \\u006fld\n'
  const fx = makeFixture({
    'old.ts': 'export const old = 1\n',
    'better.ts': 'export const better = 2\n',
    'consumer.ts': source,
  })
  try {
    await assert.rejects(runReplace('old', 'better', { cwd: fx.dir, verify: false }), /cannot resolve escaped references/)
    assert.equal(fx.read('consumer.ts'), source)
  }
  finally { fx.cleanup() }
})

it('rename refuses an escaped declaration when TypeScript returns no edits', async () => {
  const source = 'export const \\u006fld = 3\n'
  const fx = makeFixture({ 'consumer.ts': source })
  try {
    await assert.rejects(runRename('old', 'better', { cwd: fx.dir, verify: false }), /could not rename declaration/)
    assert.equal(fx.read('consumer.ts'), source)
    const unchanged = await runRename('old', 'old', { cwd: fx.dir, verify: false })
    assert.deepEqual(unchanged.changes, [])
  }
  finally { fx.cleanup() }
})

it('rename refuses escaped consumers before returning incomplete changes', async () => {
  const source = 'import { old } from "./old.ts"\nexport const result = \\u006fld\n'
  const fx = makeFixture({ 'old.ts': 'export const old = 3\n', 'consumer.ts': source })
  try {
    await assert.rejects(runRename('old', 'better', { cwd: fx.dir, verify: false }), /cannot resolve escaped references/)
    assert.equal(fx.read('consumer.ts'), source)
    assert.equal(fx.read('old.ts'), 'export const old = 3\n')
  }
  finally { fx.cleanup() }
})
