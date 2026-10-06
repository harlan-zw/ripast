import assert from 'node:assert/strict'
import { it } from 'vitest'
import { runRename } from '../packages/core/src/rename.ts'
import { writeChanges } from '../packages/core/src/util.ts'
import { makeFixture } from './helpers.ts'

it('rename updates declaration + cross-file imports + call sites', async () => {
  const fx = makeFixture({
    'a.ts': 'export function oldFn(n: number) { return n + 1 }\n',
    'b.ts': 'import { oldFn } from \'./a.ts\'\nexport const r = oldFn(2)\n',
  })
  try {
    const result = await runRename('oldFn', 'newFn', { cwd: fx.dir })
    writeChanges(result.changes)
    assert.match(fx.read('a.ts'), /newFn/)
    assert.doesNotMatch(fx.read('a.ts'), /oldFn/)
    assert.match(fx.read('b.ts'), /import \{ newFn \} from '\.\/a\.ts'/)
    assert.match(fx.read('b.ts'), /newFn\(2\)/)
    assert.equal(result.changes.length, 2)
  }
  finally { fx.cleanup() }
})

it('rename does not touch unrelated same-named identifiers in property position', async () => {
  const fx = makeFixture({
    'a.ts': 'export function target() { return 1 }\n',
    'b.ts': 'import { target } from \'./a.ts\'\nconst o = { target: 2 }\nexport const r = target() + o.target\n',
  })
  try {
    const result = await runRename('target', 'renamed', { cwd: fx.dir })
    writeChanges(result.changes)
    const b = fx.read('b.ts')
    assert.match(b, /import \{ renamed \} from '\.\/a\.ts'/)
    assert.match(b, /renamed\(\) \+ o\.target/)
    assert.match(b, /\{ target: 2 \}/, 'object key should not be renamed')
  }
  finally { fx.cleanup() }
})

it('rename preserves aliased imports correctly', async () => {
  const fx = makeFixture({
    'a.ts': 'export function foo() {}\n',
    'b.ts': 'import { foo as bar } from \'./a.ts\'\nbar()\n',
  })
  try {
    const result = await runRename('foo', 'foo2', { cwd: fx.dir })
    writeChanges(result.changes)
    const b = fx.read('b.ts')
    assert.match(b, /import \{ foo2 as bar \} from '\.\/a\.ts'/)
    assert.match(b, /bar\(\)/, 'local alias unchanged')
  }
  finally { fx.cleanup() }
})

it('warns when the renamed symbol is still imported by a file it did not rewrite', async () => {
  const fx = makeFixture({
    'a.ts': 'export function oldFn() { return 1 }\n',
    // Imports via an unresolvable package specifier: the TypeScript server cannot follow it
    // back to the declaration, so this consumer is left stale.
    'consumer.ts': 'import { oldFn } from \'my-pkg\'\nexport const r = oldFn()\n',
  })
  try {
    const result = await runRename('oldFn', 'newFn', { cwd: fx.dir })
    writeChanges(result.changes)
    assert.equal(result.warnings.length, 1, 'one stale-consumer warning')
    assert.match(result.warnings[0]!, /oldFn/)
    assert.match(result.warnings[0]!, /consumer\.ts/)
  }
  finally { fx.cleanup() }
})

it('emits no stale-consumer warning when every import site is rewritten', async () => {
  const fx = makeFixture({
    'a.ts': 'export function oldFn() { return 1 }\n',
    'b.ts': 'import { oldFn } from \'./a.ts\'\nexport const r = oldFn()\n',
  })
  try {
    const result = await runRename('oldFn', 'newFn', { cwd: fx.dir })
    assert.deepEqual(result.warnings, [])
  }
  finally { fx.cleanup() }
})

it('rename finds a local variable inside a function', async () => {
  const fx = makeFixture({
    'a.ts': 'export function count(closes: number) { const markedCloses = closes; const hits = [markedCloses]; return hits.length + closes }\n',
  })
  try {
    const result = await runRename('hits', 'markedHits', { cwd: fx.dir, verify: true, vue: false })
    writeChanges(result.changes)
    assert.equal(result.regressions.length, 0)
    assert.match(fx.read('a.ts'), /const markedHits = \[markedCloses\]; return markedHits.length \+ closes/)
  }
  finally { fx.cleanup() }
})

it('rename refuses ambiguous local declarations unless all is requested', async () => {
  const fx = makeFixture({
    'a.ts': 'export function a() { const hits = 1; return hits }\nexport function b() { const hits = 2; return hits }\n',
  })
  try {
    await assert.rejects(runRename('hits', 'markedHits', { cwd: fx.dir, vue: false }), /multiple declarations/)
    const result = await runRename('hits', 'markedHits', { cwd: fx.dir, allowMultiple: true, vue: false })
    writeChanges(result.changes)
    assert.equal(result.regressions.length, 0)
    assert.match(fx.read('a.ts'), /function a\(\) \{ const markedHits = 1; return markedHits \}/)
    assert.match(fx.read('a.ts'), /function b\(\) \{ const markedHits = 2; return markedHits \}/)
  }
  finally { fx.cleanup() }
})

it('rename keeps local shadows when a top-level declaration exists', async () => {
  const fx = makeFixture({
    'a.ts': 'export const hits = 1; export function count() { const hits = 2; return hits }\nexport const value = hits\n',
  })
  try {
    const result = await runRename('hits', 'markedHits', { cwd: fx.dir, vue: false })
    writeChanges(result.changes)
    assert.equal(result.regressions.length, 0)
    assert.match(fx.read('a.ts'), /export const markedHits = 1/)
    assert.match(fx.read('a.ts'), /function count\(\) \{ const hits = 2; return hits \}/)
    assert.match(fx.read('a.ts'), /export const value = markedHits/)
  }
  finally { fx.cleanup() }
})

it.each([
  ['b.ts', 'export function record(hits: number) { return { hits } }\n'],
  ['b.js', 'export function record(hits) { return { hits } }\n'],
])('rename of a local Nuxt declaration preserves unrelated bindings in %s', async (path, source) => {
  const fx = makeFixture({
    'nuxt.config.ts': 'export default {}\n',
    'composables/a.ts': 'export function count() { const hits = 1; return hits }\n',
    [path]: source,
  })
  try {
    const result = await runRename('hits', 'markedHits', { cwd: fx.dir, verify: true })
    assert.equal(result.regressions.length, 0)
    assert.deepEqual(result.changes.map(change => change.rel), ['composables/a.ts'])
    writeChanges(result.changes)
    assert.match(fx.read('composables/a.ts'), /const markedHits = 1; return markedHits/)
    assert.equal(fx.read(path), source)
  }
  finally { fx.cleanup() }
})

it('rename all applies each edit once for repeated declarations of one local variable', async () => {
  const fx = makeFixture({
    'a.ts': 'export function count() { var hits = 1; var hits = 2; return hits }\n',
  })
  try {
    const result = await runRename('hits', 'markedHits', { cwd: fx.dir, allowMultiple: true, vue: false })
    writeChanges(result.changes)
    assert.equal(result.regressions.length, 0)
    assert.equal(fx.read('a.ts'), 'export function count() { var markedHits = 1; var markedHits = 2; return markedHits }\n')
  }
  finally { fx.cleanup() }
})
