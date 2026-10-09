import assert from 'node:assert/strict'
import { rmSync, statSync, utimesSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildDeclarationTree, createDeclarationCache } from 'ripide-api'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

it('declaration cache reuses analysis while preserving export filters and caller isolation', () => {
  const fixture = makeFixture({ 'source.ts': 'export const publicName = 1\nconst localName = 2\n' })
  try {
    const cache = createDeclarationCache()
    const opts = { cwd: fixture.dir, glob: '*.ts', cache }
    const all = buildDeclarationTree(opts)
    assert.deepEqual(all.files[0].declarations.map(d => d.name), ['publicName', 'localName'])
    all.files[0].declarations[0].name = 'poisoned'
    const exported = buildDeclarationTree({ ...opts, exports: 'exported' })
    assert.deepEqual(exported.files[0].declarations.map(d => d.name), ['publicName'])
    assert.equal(cache.stats().hits, 1)
    const local = buildDeclarationTree({ ...opts, exports: 'local' })
    assert.deepEqual(local.files[0].declarations.map(d => d.name), ['localName'])
  }
  finally { fixture.cleanup() }
})

it('declaration cache detects same-size content edits even when timestamps are restored', () => {
  const fixture = makeFixture({ 'source.ts': 'export const beforeName = 1\n' })
  try {
    const cache = createDeclarationCache()
    const opts = { cwd: fixture.dir, glob: '*.ts', cache }
    buildDeclarationTree(opts)
    const path = resolve(fixture.dir, 'source.ts')
    const stat = statSync(path)
    fixture.write('source.ts', 'export const after_Name = 1\n')
    utimesSync(path, stat.atime, stat.mtime)
    assert.deepEqual(buildDeclarationTree(opts).files[0].declarations.map(d => d.name), ['after_Name'])
    assert.equal(cache.stats().misses, 2)
  }
  finally { fixture.cleanup() }
})

it('cached inspection discovers new files and stops returning removed files', () => {
  const fixture = makeFixture({ 'a.ts': 'export const a = 1\n' })
  try {
    const cache = createDeclarationCache()
    const opts = { cwd: fixture.dir, glob: '*.ts', cache }
    buildDeclarationTree(opts)
    fixture.write('b.ts', 'export const b = 2\n')
    assert.deepEqual(buildDeclarationTree(opts).files.map(f => f.file), ['a.ts', 'b.ts'])
    rmSync(resolve(fixture.dir, 'a.ts'))
    assert.deepEqual(buildDeclarationTree(opts).files.map(f => f.file), ['b.ts'])
  }
  finally { fixture.cleanup() }
})

it('declaration cache bounds retained analysis and remains correct after eviction and clearing', () => {
  const fixture = makeFixture({ 'a.ts': 'export const a = 1\n', 'b.ts': 'export const b = 2\n' })
  try {
    const cache = createDeclarationCache({ maxEntries: 1 })
    const opts = { cwd: fixture.dir, glob: '*.ts', cache }
    assert.deepEqual(buildDeclarationTree(opts).files.map(f => f.file), ['a.ts', 'b.ts'])
    assert.equal(cache.stats().entries, 1)
    assert.ok(cache.stats().evictions > 0)
    cache.clear()
    assert.equal(cache.stats().entries, 0)
    assert.deepEqual(buildDeclarationTree(opts).files.map(f => f.file), ['a.ts', 'b.ts'])
  }
  finally { fixture.cleanup() }
})

it('declaration cache skips oversized payloads without losing inspection results', () => {
  const fixture = makeFixture({ 'a.ts': 'export const a = 1\n' })
  try {
    const cache = createDeclarationCache({ maxBytes: 1 })
    const opts = { cwd: fixture.dir, glob: '*.ts', cache }
    assert.equal(buildDeclarationTree(opts).files[0].declarations[0].name, 'a')
    assert.equal(buildDeclarationTree(opts).files[0].declarations[0].name, 'a')
    assert.equal(cache.stats().hits, 0)
    assert.equal(cache.stats().entries, 0)
  }
  finally { fixture.cleanup() }
})

it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('declaration cache refuses invalid bounds %s', (value) => {
  assert.throws(() => createDeclarationCache({ maxEntries: value }), /positive safe integer/)
  assert.throws(() => createDeclarationCache({ maxBytes: value }), /positive safe integer/)
})
