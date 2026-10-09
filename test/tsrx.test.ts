import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { it } from 'vitest'
import { scan } from '../packages/core/src/scan.ts'
import { makeFixture } from './helpers.ts'

const launcher = resolve('packages/cli/bin/ripide.mjs')
const config = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    strict: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    skipLibCheck: true,
    jsx: 'react-jsx',
    jsxImportSource: 'octane',
  },
  tsrx: { compiler: 'octane' },
  contentMappers: [{ package: '@tsrx/content-mapper', extensions: ['.tsrx'], options: { compiler: 'ripide-tsrx/compiler' } }],
  include: ['**/*.ts', '**/*.tsrx'],
}

const files = {
  'helper.ts': 'export function oldFn() { return 1 }\n',
  'Card.tsrx': `import { oldFn } from './helper.ts'
export function Card() @{
  const count = oldFn()
  @if (count > 0) { <div>{oldFn()}{count}</div> }
}
`,
  'Loop.tsrx': `import { oldFn } from './helper.ts'
export function Loop() @{
  const rows = [oldFn()]
  @for (const item of rows) { <span>{item}</span> }
}
`,
  'Alias.tsrx': `import { oldFn as localFn } from './helper.ts'
export function Alias() @{ <span>{localFn()}</span> }
`,
  'Other.tsrx': `function oldFn() { return 2 }
export function Other() @{ <div>{oldFn()}{"oldFn"}</div> }
`,
  'Consumer.tsrx': `import { Card } from './Card.tsrx'
export function Consumer() @{ <Card /> }
`,
  'consumer.ts': `import { Card } from './Card.tsrx'
export const card = Card
`,
}

function fixture(extra: Record<string, string> = {}, base: Record<string, string> = files) {
  const fx = makeFixture({ ...base, 'tsconfig.json': JSON.stringify(config), ...extra })
  symlinkSync(resolve('node_modules'), join(fx.dir, 'node_modules'), 'junction')
  return fx
}

function command(cwd: string, args: string[], externalCode = true) {
  return spawnSync(process.execPath, [launcher, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, RIPIDE_RUN_EXTERNAL_CODE: externalCode ? '1' : '0' },
  })
}

it('tsrx scan includes scripts, template expressions, control flow, aliases and original locations by default', () => {
  const fx = fixture()
  try {
    const hits = scan('oldFn', { cwd: fx.dir })
    assert.deepEqual(hits.filter(hit => hit.file === 'Card.tsrx').map(hit => [hit.line, hit.col, hit.kind]), [
      [1, 10, 'import-specifier'],
      [3, 17, 'identifier-reference'],
      [4, 27, 'identifier-reference'],
    ])
    assert.equal(hits.filter(hit => hit.file === 'Other.tsrx').length, 3)
    assert.ok(scan('Card', { cwd: fx.dir }).some(hit => hit.file === 'Consumer.tsrx' && hit.line === 2 && hit.kind === 'jsx'))
    assert.ok(scan('rows', { cwd: fx.dir }).some(hit => hit.file === 'Loop.tsrx' && hit.line === 4))
  }
  finally { fx.cleanup() }
})

it('tsrx rename previews without writes, then updates consumers while preserving aliases and unrelated names', () => {
  const fx = fixture()
  try {
    const args = ['rename', 'oldFn', 'newFn', '--scope', 'helper.ts', '--profile', 'full']
    const preview = command(fx.dir, args)
    assert.equal(preview.status, 0, preview.stderr)
    assert.match(preview.stdout, /Card\.tsrx/)
    assert.equal(fx.read('helper.ts'), files['helper.ts'])
    const applied = command(fx.dir, [...args, '--apply'])
    assert.equal(applied.status, 0, applied.stderr)
    assert.match(fx.read('Card.tsrx'), /newFn\(\)/)
    assert.doesNotMatch(fx.read('Card.tsrx'), /oldFn/)
    assert.match(fx.read('Alias.tsrx'), /newFn as localFn/)
    assert.match(fx.read('Alias.tsrx'), /localFn\(\)/)
    assert.equal(fx.read('Other.tsrx'), files['Other.tsrx'])
  }
  finally { fx.cleanup() }
})

it('tsrx component rename updates its declaration, TS imports and template tags', () => {
  const fx = fixture()
  try {
    const result = command(fx.dir, ['rename', 'Card', 'Tile', '--scope', 'Card.tsrx', '--apply'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(fx.read('Card.tsrx'), /function Tile\(\) @\{/)
    assert.match(fx.read('Consumer.tsrx'), /<Tile \/>/)
    assert.match(fx.read('consumer.ts'), /import \{ Tile \}/)
  }
  finally { fx.cleanup() }
})

it('tsrx local rename updates template and control-flow uses', () => {
  const fx = fixture()
  try {
    const result = command(fx.dir, ['rename', 'count', 'total', '--scope', 'Card.tsrx', '--apply'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(fx.read('Card.tsrx'), /const total = oldFn\(\)/)
    assert.match(fx.read('Card.tsrx'), /@if \(total > 0\)/)
    assert.match(fx.read('Card.tsrx'), /\{total\}/)
    const loop = command(fx.dir, ['rename', 'rows', 'items', '--scope', 'Loop.tsrx', '--apply'])
    assert.equal(loop.status, 0, loop.stderr)
    assert.match(fx.read('Loop.tsrx'), /of items/)
  }
  finally { fx.cleanup() }
})

it('tsrx type rename updates annotations and template property access', () => {
  const fx = fixture({
    'model.ts': 'export interface Item { label: string }\n',
    'Typed.tsrx': `import type { Item } from './model.ts'
export function Typed(props: { item: Item }) @{ <div>{props.item.label}</div> }
`,
  })
  try {
    const result = command(fx.dir, ['rename', 'Item', 'Row', '--scope', 'model.ts', '--apply'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(fx.read('Typed.tsrx'), /import type \{ Row \}/)
    assert.match(fx.read('Typed.tsrx'), /item: Row/)
  }
  finally { fx.cleanup() }
})

it('tsrx verification blocks a new collision in a template consumer without writing', () => {
  const source = files['Card.tsrx'].replace('  const count', '  const existing = 2\n  const count')
  const fx = fixture({ 'Card.tsrx': source })
  try {
    const result = command(fx.dir, ['rename', 'oldFn', 'existing', '--scope', 'helper.ts', '--apply'])
    assert.notEqual(result.status, 0, result.stdout)
    assert.match(result.stdout + result.stderr, /Card\.tsrx/)
    assert.equal(fx.read('Card.tsrx'), source)
    assert.equal(fx.read('helper.ts'), files['helper.ts'])
  }
  finally { fx.cleanup() }
})

it('tsrx semantic operations require external-code opt-in before writing', () => {
  const fx = fixture()
  try {
    const result = command(fx.dir, ['rename', 'oldFn', 'newFn', '--scope', 'helper.ts', '--apply'], false)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /RIPIDE_RUN_EXTERNAL_CODE=1/)
    assert.equal(fx.read('helper.ts'), files['helper.ts'])
  }
  finally { fx.cleanup() }
})

it('tsrx semantic operations reject an unconfigured mapper instead of silently omitting consumers', () => {
  const fx = fixture({ 'tsconfig.json': JSON.stringify({ ...config, contentMappers: [] }) })
  try {
    const result = command(fx.dir, ['rename', 'oldFn', 'newFn', '--scope', 'helper.ts', '--apply'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /no TSRX content mapper/)
    assert.equal(fx.read('helper.ts'), files['helper.ts'])
  }
  finally { fx.cleanup() }
})

it('tsrx file rename updates imports from both TS and TSRX consumers', () => {
  const fx = fixture()
  try {
    const result = command(fx.dir, ['rename-file', 'Card.tsrx', 'Tile.tsrx', '--apply'])
    assert.equal(result.status, 0, result.stderr)
    assert.match(fx.read('Consumer.tsrx'), /from '\.\/Tile\.tsrx'/)
    assert.match(fx.read('consumer.ts'), /from '\.\/Tile\.tsrx'/)
    assert.match(fx.read('Tile.tsrx'), /function Card/)
  }
  finally { fx.cleanup() }
})

it('tsrx scans reject malformed source instead of returning an incomplete AST', () => {
  const fx = fixture({ 'Broken.tsrx': 'export function Broken() @{ <div>{oldFn(}</div> }\n' })
  try {
    assert.throws(() => scan('oldFn', { cwd: fx.dir }), /cannot parse.*Broken\.tsrx/)
  }
  finally { fx.cleanup() }
})

it('tsrx semantic operations block a broken mapper compiler before writing', () => {
  const fx = fixture({
    'tsconfig.json': JSON.stringify({
      ...config,
      contentMappers: [{ package: '@tsrx/content-mapper', extensions: ['.tsrx'], options: { compiler: 'missing-compiler' } }],
    }),
  })
  try {
    const result = command(fx.dir, ['rename', 'oldFn', 'newFn', '--scope', 'helper.ts', '--apply'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /content mapper failed/)
    assert.equal(fx.read('helper.ts'), files['helper.ts'])
  }
  finally { fx.cleanup() }
})

it('tsrx rejects invalid multiple root outputs instead of applying partial edits', () => {
  const source = `import { oldFn } from './helper.ts'
export function Edge() @{
  @if (true) { <div>{oldFn()}</div> }
  @for (const item of [1]) { <span>{item}</span> }
}
`
  const fx = fixture({ 'Edge.tsrx': source })
  try {
    const result = command(fx.dir, ['rename', 'oldFn', 'newFn', '--scope', 'helper.ts', '--apply'])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /cannot parse.*Edge\.tsrx/)
    assert.equal(fx.read('helper.ts'), files['helper.ts'])
    assert.equal(fx.read('Edge.tsrx'), source)
  }
  finally { fx.cleanup() }
})

it('tsrx renames across sibling conditional and loop outputs inside one fragment', () => {
  const source = `import { oldFn } from './helper.ts'
export function Edge() @{
  <>
    @if (oldFn() > 0) { <div>{oldFn()}</div> }
    @for (const item of [oldFn()]) { <span>{item}{oldFn()}</span> }
  </>
}
`
  const fx = fixture({ 'Edge.tsrx': source })
  try {
    const hits = scan('oldFn', { cwd: fx.dir }).filter(hit => hit.file === 'Edge.tsrx')
    assert.equal(hits.length, 5)
    const result = command(fx.dir, ['rename', 'oldFn', 'newFn', '--scope', 'helper.ts', '--apply'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fx.read('Edge.tsrx'), source.replaceAll('oldFn', 'newFn'))
  }
  finally { fx.cleanup() }
})

it('tsrx initializes a project with no ordinary TypeScript files before renaming', () => {
  const source = `export function Only() @{
  const target = 1
  <span>{target}</span>
}
`
  const fx = fixture({ 'Only.tsrx': source }, {})
  try {
    const result = command(fx.dir, ['rename', 'target', 'next', '--scope', 'Only.tsrx', '--apply'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fx.read('Only.tsrx'), source.replaceAll('target', 'next'))
  }
  finally { fx.cleanup() }
})

it('tsrx refuses mixed framework semantic plans before writing', () => {
  const fx = fixture({ 'View.vue': '<script setup lang="ts">import { oldFn } from "./helper.ts"; const value = oldFn()</script><template>{{ value }}</template>\n' })
  try {
    const result = command(fx.dir, ['rename', 'oldFn', 'newFn', '--scope', 'helper.ts', '--apply'])
    assert.notEqual(result.status, 0, result.stdout)
    assert.match(result.stdout + result.stderr, /TSRX.*framework extensions/)
    assert.equal(fx.read('helper.ts'), files['helper.ts'])
    assert.equal(fx.read('Card.tsrx'), files['Card.tsrx'])
  }
  finally { fx.cleanup() }
})
