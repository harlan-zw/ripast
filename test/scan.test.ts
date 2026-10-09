import assert from 'node:assert/strict'
import { it } from 'vitest'
import { formatAgentScanHits } from '../packages/core/src/css-class-scan.ts'
import { buildDeclarationTree, buildScanGraph, buildUnusedDeclarations, formatAgentDeclarationTree, formatDeclarationTree, formatScanGraph, formatUnusedDeclarations, scan } from '../packages/core/src/scan.ts'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

it('scan classifies identifier kinds', () => {
  const fx = makeFixture({
    'src/a.ts': 'export function target(n: number) { return n }\n',
    'src/b.ts': 'import { target } from \'./a.ts\'\nexport const y = target(1)\n',
    'src/c.ts': 'const o = { target: 1 }\nconsole.log(o.target)\n',
  }, false)
  try {
    const hits = scan('target', { ...{ cwd: fx.dir }, engine: vueServices() })
    const byKind = groupByKind(hits)
    assert.equal(byKind['identifier-binding'] ?? 0, 1, 'one binding in a.ts')
    assert.equal(byKind['import-specifier'] ?? 0, 1, 'one import in b.ts')
    assert.equal(byKind['identifier-reference'] ?? 0, 1, 'one call reference in b.ts')
    assert.ok((byKind.property ?? 0) >= 1, 'at least one property in c.ts')
    assert.ok((byKind['member-access'] ?? 0) >= 1, 'at least one member access in c.ts')
  }
  finally { fx.cleanup() }
})

it('scan --kind filters results', () => {
  const fx = makeFixture({
    'src/a.ts': 'export function target() {}\nimport { other } from \'./x.ts\'\ntarget()\n',
  }, false)
  try {
    const only = scan('target', { ...{ cwd: fx.dir, kinds: ['identifier-reference'] }, engine: vueServices() })
    assert.equal(only.length, 1)
    assert.equal(only[0].kind, 'identifier-reference')
  }
  finally { fx.cleanup() }
})

it('scan finds Vue SFC script-block AND template-block occurrences', () => {
  const fx = makeFixture({
    'src/comp.vue': `<template><div>{{ target() }}</div></template>\n<script setup lang="ts">\nimport { target } from './utils'\nconst x = target()\n</script>\n`,
    'src/utils.ts': 'export function target() { return 1 }\n',
  }, false)
  try {
    const hits = scan('target', { ...{ cwd: fx.dir }, engine: vueServices() })
    const vueHits = hits.filter(h => h.file.endsWith('.vue'))
    assert.ok(vueHits.some(h => h.kind === 'import-specifier'), 'import in script')
    assert.ok(vueHits.some(h => h.kind === 'identifier-reference' && h.line >= 2), 'call in script')
    assert.ok(vueHits.some(h => h.line === 1), 'template ref reported')
  }
  finally { fx.cleanup() }
})

it('scan finds Vue template directive expressions (v-if, v-for, :prop)', () => {
  const fx = makeFixture({
    'src/comp.vue': `<template>\n  <div v-if="visible">{{ count }}</div>\n  <span :title="label">x</span>\n  <ul><li v-for="item in items">{{ item }}</li></ul>\n</template>\n<script setup lang="ts">\nconst visible = true\nconst count = 1\nconst label = 'hi'\nconst items = [1,2,3]\n</script>\n`,
  }, false)
  try {
    const visibleHits = scan('visible', { ...{ cwd: fx.dir }, engine: vueServices() }).filter(h => h.file.endsWith('.vue'))
    assert.ok(visibleHits.some(h => h.line === 2), 'v-if expression captured')
    const labelHits = scan('label', { ...{ cwd: fx.dir }, engine: vueServices() }).filter(h => h.file.endsWith('.vue'))
    assert.ok(labelHits.some(h => h.line === 3), 'v-bind expression captured')
    const itemsHits = scan('items', { ...{ cwd: fx.dir }, engine: vueServices() }).filter(h => h.file.endsWith('.vue'))
    assert.ok(itemsHits.some(h => h.line === 4), 'v-for expression captured')
  }
  finally { fx.cleanup() }
})

it('scan dedupes ImportSpecifier imported/local pair for unaliased imports', () => {
  const fx = makeFixture({
    'src/a.ts': 'export function foo() {}\n',
    'src/b.ts': 'import { foo } from \'./a.ts\'\nfoo()\n',
  }, false)
  try {
    const hits = scan('foo', { ...{ cwd: fx.dir }, engine: vueServices() })
    const importHits = hits.filter(h => h.kind === 'import-specifier')
    assert.equal(importHits.length, 1, 'unaliased import counts once, not twice')
  }
  finally { fx.cleanup() }
})

it('buildScanGraph links hit files through relative imports and re-exports', () => {
  const fx = makeFixture({
    'src/a.ts': 'export function target() { return 1 }\n',
    'src/b.ts': 'export { target } from \'./a.ts\'\n',
    'src/c.ts': 'import { target } from \'./b.ts\'\nexport const result = target()\n',
    'src/unrelated.ts': 'import { target } from \'./a.ts\'\n',
  }, false)
  try {
    const graph = buildScanGraph('target', { ...{ cwd: fx.dir }, engine: vueServices() })
    assert.deepEqual(graph.nodes.map(n => n.file), [
      'src/a.ts',
      'src/b.ts',
      'src/c.ts',
      'src/unrelated.ts',
    ])
    assert.deepEqual(graph.edges.map(e => `${e.from}->${e.to}:${e.specifier}`), [
      'src/b.ts->src/a.ts:./a.ts',
      'src/c.ts->src/b.ts:./b.ts',
      'src/unrelated.ts->src/a.ts:./a.ts',
    ])
  }
  finally { fx.cleanup() }
})

it('formatScanGraph emits mermaid and dot formats', () => {
  const fx = makeFixture({
    'src/a.ts': 'export function target() { return 1 }\n',
    'src/b.ts': 'import { target } from \'./a.ts\'\ntarget()\n',
  }, false)
  try {
    const graph = buildScanGraph('target', { ...{ cwd: fx.dir }, engine: vueServices() })
    const mermaid = formatScanGraph(graph, 'mermaid')
    assert.match(mermaid, /^flowchart LR/)
    assert.match(mermaid, /src\/b\.ts/)
    assert.match(mermaid, /-->\|\.\/a\.ts\|/)

    const dot = formatScanGraph(graph, 'dot')
    assert.match(dot, /^digraph ripide_scan/)
    assert.match(dot, /"src\/b\.ts" -> "src\/a\.ts" \[label="\.\/a\.ts"\];/)
  }
  finally { fx.cleanup() }
})

it('buildDeclarationTree reports top-level exported and local declarations', () => {
  const fx = makeFixture({
    'src/a.ts': [
      'import { dep } from \'./dep.ts\'',
      'const localValue = dep',
      'function localHelper() {}',
      'export function exportedFn() {}',
      'export interface ExportedShape {}',
      'type SpecExport = string',
      'export { SpecExport }',
      '',
    ].join('\n'),
    'src/dep.ts': 'export const dep = 1\n',
  }, false)
  try {
    const tree = buildDeclarationTree({ ...{ cwd: fx.dir, glob: '*.ts' }, engine: vueServices() })
    const a = tree.files.find(f => f.file === 'src/a.ts')
    assert.ok(a)
    assert.deepEqual(a!.imports, ['./dep.ts'])
    assert.deepEqual(
      a!.declarations.map(d => `${d.exported ? 'export' : 'local'}:${d.kind}:${d.name}`),
      [
        'local:const:localValue',
        'local:function:localHelper',
        'export:function:exportedFn',
        'export:interface:ExportedShape',
        'export:type:SpecExport',
      ],
    )
  }
  finally { fx.cleanup() }
})

it('buildDeclarationTree filters exported and local declarations', () => {
  const fx = makeFixture({
    'src/a.ts': 'const localValue = 1\nexport const exportedValue = 2\n',
  }, false)
  try {
    const exported = buildDeclarationTree({ ...{ cwd: fx.dir, glob: '*.ts', exports: 'exported' }, engine: vueServices() })
    assert.deepEqual(exported.files.flatMap(f => f.declarations.map(d => d.name)), ['exportedValue'])

    const local = buildDeclarationTree({ ...{ cwd: fx.dir, glob: '*.ts', exports: 'local' }, engine: vueServices() })
    assert.deepEqual(local.files.flatMap(f => f.declarations.map(d => d.name)), ['localValue'])
  }
  finally { fx.cleanup() }
})

it('formatDeclarationTree emits text and json output', () => {
  const fx = makeFixture({
    'src/a.ts': 'export class Service {}\n',
  }, false)
  try {
    const tree = buildDeclarationTree({ ...{ cwd: fx.dir, glob: '*.ts' }, engine: vueServices() })
    const text = formatDeclarationTree(tree, false)
    assert.match(text, /src\/a\.ts/)
    assert.match(text, /export class\s+Service/)

    const json = JSON.parse(formatDeclarationTree(tree, true))
    assert.equal(json.files[0].declarations[0].name, 'Service')
  }
  finally { fx.cleanup() }
})

it('formatAgentDeclarationTree emits compact exported and local summaries', () => {
  const fx = makeFixture({
    'src/a.ts': 'import { dep } from \'./dep.ts\'\nconst localValue = dep\nfunction helper() {}\nexport function run() {}\n',
    'src/dep.ts': 'export const dep = 1\n',
  }, false)
  try {
    const tree = buildDeclarationTree({ ...{ cwd: fx.dir, glob: '*.ts' }, engine: vueServices() })
    const exported = formatAgentDeclarationTree(tree, 'exported')
    assert.match(exported, /exports: function run/)
    assert.match(exported, /locals: 2/)
    assert.doesNotMatch(exported, /localValue/)

    const local = formatAgentDeclarationTree(tree, 'local')
    assert.match(local, /locals: const localValue; function helper/)
    assert.doesNotMatch(local, /exports: function run/)
  }
  finally { fx.cleanup() }
})

it('buildDeclarationTree includes function signatures for declarations and function-valued consts', () => {
  const fx = makeFixture({
    'src/a.ts': [
      'export async function useFoo<T>(id: string, opts?: UseFooOptions): Promise<T> { return null as T }',
      'export const useBar = (n: number, label = \'x\'): string => label',
      'const internal = function(event: H3Event) { return event }',
      'export { internal }',
      '',
    ].join('\n'),
  }, false)
  try {
    const tree = buildDeclarationTree({ ...{ cwd: fx.dir, glob: '*.ts', exports: 'exported' }, engine: vueServices() })
    assert.deepEqual(
      tree.files.flatMap(f => f.declarations.map(d => d.signature)),
      [
        'useFoo<T>(id: string, opts?: UseFooOptions): Promise<T>',
        'useBar(n: number, label = \'x\'): string',
        'internal(event: H3Event)',
      ],
    )

    const agent = formatAgentDeclarationTree(tree, 'exported')
    assert.match(agent, /exports: function useFoo<T>\(id: string, opts\?: UseFooOptions\): Promise<T>; const useBar\(n: number, label = 'x'\): string, internal\(event: H3Event\)/)

    const text = formatDeclarationTree(tree, false)
    assert.match(text, /export function\s+useFoo<T>\(id: string, opts\?: UseFooOptions\): Promise<T>/)
    assert.match(text, /export const\s+useBar\(n: number, label = 'x'\): string/)
  }
  finally { fx.cleanup() }
})

it('buildDeclarationTree truncates long signatures in compact summaries', () => {
  const fx = makeFixture({
    'src/a.ts': 'export function many(a: string, b: number, c: boolean, d: Date, e: Error): void {}\n',
  }, false)
  try {
    const tree = buildDeclarationTree({ ...{ cwd: fx.dir, glob: '*.ts', exports: 'exported' }, engine: vueServices() })
    assert.equal(tree.files[0].declarations[0].signature, 'many(a: string, b: number, c: boolean, d: Date, ...1 more): void')
  }
  finally { fx.cleanup() }
})

it('buildUnusedDeclarations reports unreferenced top-level local declarations by default', async () => {
  const fx = makeFixture({
    'src/a.ts': [
      'function usedLocal() { return 1 }',
      'function unusedLocal() { return 2 }',
      'export function publicApi() { return usedLocal() }',
      '',
    ].join('\n'),
    'src/b.ts': 'import { publicApi } from \'./a.ts\'\npublicApi()\n',
  }, false)
  try {
    const unused = await buildUnusedDeclarations({ ...{ cwd: fx.dir, glob: '*.ts' }, engine: vueServices() })
    assert.deepEqual(unused.files.map(f => f.file), ['src/a.ts'])
    assert.deepEqual(unused.files[0].declarations.map(d => d.name), ['unusedLocal'])

    const text = formatUnusedDeclarations(unused, false)
    assert.match(text, /src\/a\.ts/)
    assert.match(text, /unusedLocal\(\) function local line 2: no project references/)
  }
  finally { fx.cleanup() }
})

it('buildUnusedDeclarations supports exported and all filters', async () => {
  const fx = makeFixture({
    'src/a.ts': [
      'const unusedLocal = 1',
      'export const unusedExport = 2',
      'export const usedExport = 3',
      '',
    ].join('\n'),
    'src/b.ts': 'import { usedExport } from \'./a.ts\'\nconsole.log(usedExport)\n',
  }, false)
  try {
    const exported = await buildUnusedDeclarations({ ...{ cwd: fx.dir, glob: '*.ts', exports: 'exported' }, engine: vueServices() })
    assert.deepEqual(exported.files.flatMap(f => f.declarations.map(d => d.name)), ['unusedExport'])

    const all = await buildUnusedDeclarations({ ...{ cwd: fx.dir, glob: '*.ts', exports: 'all' }, engine: vueServices() })
    assert.deepEqual(all.files.flatMap(f => f.declarations.map(d => d.name)), ['unusedLocal', 'unusedExport'])

    const json = JSON.parse(formatUnusedDeclarations(exported, true))
    assert.equal(json.files[0].declarations[0].name, 'unusedExport')
  }
  finally { fx.cleanup() }
})

it('buildUnusedDeclarations does not treat same-file named export specifiers as references', async () => {
  const fx = makeFixture({
    'src/a.ts': 'type PublicType = string\nexport { PublicType }\n',
  }, false)
  try {
    const unused = await buildUnusedDeclarations({ ...{ cwd: fx.dir, glob: '*.ts', exports: 'exported' }, engine: vueServices() })
    assert.deepEqual(unused.files.flatMap(f => f.declarations.map(d => d.name)), ['PublicType'])
  }
  finally { fx.cleanup() }
})

it.each(['"accessed"', '`accessed`'])('buildUnusedDeclarations keeps exported names accessed through %s', async (property) => {
  const fx = makeFixture({
    'src/source.ts': [
      'export const imported = 1',
      'export const accessed = 2',
      'export const unused = 3',
    ].join('\n'),
    'src/consumer.ts': [
      'import { "imported" as alias } from "./source.ts"',
      'import * as source from "./source.ts"',
      `console.log(alias, source[${property}])`,
    ].join('\n'),
  })
  try {
    const unused = await buildUnusedDeclarations({ ...{ cwd: fx.dir, exports: 'exported' }, engine: vueServices() })
    assert.deepEqual(unused.files.flatMap(file => file.declarations.map(declaration => declaration.name)), ['unused'])
  }
  finally { fx.cleanup() }
})

it.each([
  'export const { value = used } = {}',
  'export const [value = used] = []',
  'export const { [used]: value } = { 1: 2 }',
  'const { value = used } = {}',
])('buildUnusedDeclarations keeps references inside binding patterns: %s', async (declaration) => {
  const fx = makeFixture({
    'source.ts': `export const used = 1\n${declaration}\nconsole.log(value)\n`,
  })
  try {
    const unused = await buildUnusedDeclarations({ ...{ cwd: fx.dir, exports: 'exported' }, engine: vueServices() })
    assert.deepEqual(unused.files, [])
  }
  finally { fx.cleanup() }
})

it('buildUnusedDeclarations handles JavaScript files when a tsconfig exists', async () => {
  const fx = makeFixture({
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext' }, include: ['src/**/*.ts'] }),
    'src/a.mjs': 'function unusedJs() {}\nexport function usedJs() {}\n',
    'src/b.ts': 'import { usedJs } from \'./a.mjs\'\nusedJs()\n',
  }, false)
  try {
    const unused = await buildUnusedDeclarations({ ...{ cwd: fx.dir, glob: ['*.ts', '*.mjs'], exports: 'all' }, engine: vueServices() })
    assert.deepEqual(unused.files.flatMap(f => f.declarations.map(d => d.name)), ['unusedJs'])
  }
  finally { fx.cleanup() }
})

it('buildUnusedDeclarations treats type references and shorthand properties as references', async () => {
  const fx = makeFixture({
    'src/a.ts': [
      'interface Shape { value: string }',
      'const schema = { value: \'x\' }',
      'const table: Record<string, Shape> = { schema }',
      'console.log(table)',
      '',
    ].join('\n'),
  }, false)
  try {
    const unused = await buildUnusedDeclarations({ ...{ cwd: fx.dir, glob: '*.ts' }, engine: vueServices() })
    assert.deepEqual(unused.files, [])
  }
  finally { fx.cleanup() }
})

it('formatAgentScanHits limits class token output', () => {
  const out = formatAgentScanHits([
    { token: 'text-sm', count: 10, files: ['a.vue'] },
    { token: 'flex', count: 6, files: ['a.vue', 'b.vue'] },
    { token: 'mt-4', count: 2, files: ['b.vue'] },
  ], 2)
  assert.match(out, /^class-scan tokens=3 files=2 top=2 format=token=count\/files/)
  assert.match(out, /text-sm=10\/1/)
  assert.match(out, /flex=6\/2/)
  assert.match(out, /\+1 more/)
  assert.doesNotMatch(out, /mt-4=2\/1/)
})

function groupByKind(hits: { kind: string }[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const h of hits) out[h.kind] = (out[h.kind] ?? 0) + 1
  return out
}
