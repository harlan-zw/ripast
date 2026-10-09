import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { runMove, writeChanges } from './engine-sdk.ts'
import { makeFixture } from './helpers.ts'

it('move rejects a destination alias before changing either module', async () => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\n',
    'target.ts': 'import { helper as current } from \'./source.ts\'\nexport const result = current()\n',
  })
  try {
    await assert.rejects(runMove('helper', 'source.ts', 'target.ts', { cwd: fx.dir, verify: false }), /Remove the alias/)
    const target = await import(pathToFileURL(`${fx.dir}/target.ts`).href)
    assert.equal(target.result, 42)
  }
  finally { fx.cleanup() }
})

it('move preserves a destination that already imports the moved declaration', async () => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\nexport const other = 1\n',
    'target.ts': 'import { helper, other } from \'./source.ts\'\nexport const result = helper() + other\n',
  })
  try {
    const result = await runMove('helper', 'source.ts', 'target.ts', { cwd: fx.dir, verify: false })
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `const target = await import(${JSON.stringify(pathToFileURL(`${fx.dir}/target.ts`).href)}); console.log(target.result)`], { encoding: 'utf8' })
    assert.equal(output.trim(), '43')
  }
  finally { fx.cleanup() }
})

it('move splits multi-named import at call sites', async () => {
  const fx = makeFixture({
    'a.ts': 'export function helper() { return 1 }\nexport function other() { return 2 }\n',
    'b.ts': 'import { helper, other } from \'./a.ts\'\nexport const r = helper() + other()\n',
    'c.ts': '',
  })
  try {
    const result = await runMove('helper', 'a.ts', 'c.ts', { cwd: fx.dir })
    writeChanges(result.changes)
    assert.doesNotMatch(fx.read('a.ts'), /export function helper/)
    assert.match(fx.read('a.ts'), /export function other/)
    assert.match(fx.read('c.ts'), /export function helper/)
    const b = fx.read('b.ts')
    assert.match(b, /import \{ other \} from '\.\/a\.ts'/)
    assert.match(b, /import \{ helper \}/)
    assert.match(b, /['"]\.\/c\.ts['"]/)
  }
  finally { fx.cleanup() }
})

it('move auto-adds import in source file if remaining siblings reference the moved symbol', async () => {
  const fx = makeFixture({
    'a.ts': 'export function helper() { return 1 }\nexport function other() { return helper() + 1 }\n',
    'c.ts': '',
  })
  try {
    const result = await runMove('helper', 'a.ts', 'c.ts', { cwd: fx.dir })
    writeChanges(result.changes)
    assert.match(fx.read('a.ts'), /import \{ helper \}/, 'source auto-imports moved symbol')
    assert.match(fx.read('a.ts'), /['"]\.\/c\.ts['"]/)
    assert.match(fx.read('c.ts'), /export function helper/)
  }
  finally { fx.cleanup() }
})

it('move copies used imports from source to target', async () => {
  const fx = makeFixture({
    'utils.ts': 'export function log(s: string) { return s }\n',
    'a.ts': 'import { log } from \'./utils.ts\'\nexport function helper(s: string) { return log(s) }\n',
    'c.ts': '',
  })
  try {
    const result = await runMove('helper', 'a.ts', 'c.ts', { cwd: fx.dir })
    writeChanges(result.changes)
    const c = fx.read('c.ts')
    assert.match(c, /import \{ log \}/, 'used import copied to target')
    assert.match(c, /export function helper/)
  }
  finally { fx.cleanup() }
})

it('move removes now-unused imports from source', async () => {
  const fx = makeFixture({
    'utils.ts': 'export function log(s: string) { return s }\n',
    'a.ts': 'import { log } from \'./utils.ts\'\nexport function helper(s: string) { return log(s) }\n',
    'c.ts': '',
  })
  try {
    const result = await runMove('helper', 'a.ts', 'c.ts', { cwd: fx.dir })
    writeChanges(result.changes)
    assert.doesNotMatch(fx.read('a.ts'), /import \{ log \}/, 'unused import pruned')
  }
  finally { fx.cleanup() }
})

it('move supports interface and type declarations', async () => {
  const fx = makeFixture({
    'a.ts': 'export interface MyType { x: number }\nexport type OtherType = string\n',
    'b.ts': 'import type { MyType } from \'./a.ts\'\nexport const v: MyType = { x: 1 }\n',
    'c.ts': '',
  })
  try {
    const result = await runMove('MyType', 'a.ts', 'c.ts', { cwd: fx.dir })
    writeChanges(result.changes)
    assert.match(fx.read('c.ts'), /export interface MyType/)
    assert.doesNotMatch(fx.read('a.ts'), /export interface MyType/)
    assert.match(fx.read('b.ts'), /['"]\.\/c\.ts['"]/, 'import site updated')
  }
  finally { fx.cleanup() }
})

it('move fast path rewrites a sole named import by changing only the module specifier', async () => {
  const fx = makeFixture({
    'a.ts': 'export function helper() { return 1 }\n',
    'b.ts': 'import { helper } from \'./a.ts\'\nexport const r = helper()\n',
    'c.ts': '',
  })
  try {
    writeChanges((await runMove('helper', 'a.ts', 'c.ts', { cwd: fx.dir, verify: false })).changes)
    assert.match(fx.read('b.ts'), /^import \{ helper \} from '\.\/c\.ts'/)
    assert.doesNotMatch(fx.read('b.ts'), /\.\/a\.ts/)
  }
  finally { fx.cleanup() }
})

it('move keeps import alias when fast path is not safe', async () => {
  const fx = makeFixture({
    'a.ts': 'export function helper() { return 1 }\n',
    'b.ts': 'import { helper as h } from \'./a.ts\'\nexport const r = h()\n',
    'c.ts': '',
  })
  try {
    writeChanges((await runMove('helper', 'a.ts', 'c.ts', { cwd: fx.dir, verify: false })).changes)
    const b = fx.read('b.ts')
    assert.match(b, /import \{ helper as h \} from ['"]\.\/c\.ts['"]/)
    assert.match(b, /h\(\)/)
  }
  finally { fx.cleanup() }
})

it('move preserves default import when named import is moved', async () => {
  const fx = makeFixture({
    'a.ts': 'export default function main() { return 0 }\nexport function helper() { return 1 }\n',
    'b.ts': 'import main, { helper } from \'./a.ts\'\nexport const r = main() + helper()\n',
    'c.ts': '',
  })
  try {
    writeChanges((await runMove('helper', 'a.ts', 'c.ts', { cwd: fx.dir, verify: false })).changes)
    const b = fx.read('b.ts')
    assert.match(b, /import main from ['"]\.\/a\.ts['"]/)
    assert.match(b, /import \{ helper \} from ['"]\.\/c\.ts['"]/)
    assert.match(b, /main\(\) \+ helper\(\)/)
  }
  finally { fx.cleanup() }
})

it('move merges with an existing target import instead of duplicating simple import sites', async () => {
  const fx = makeFixture({
    'a.ts': 'export function helper() { return 1 }\n',
    'b.ts': 'import { existing } from \'./c.ts\'\nimport { helper } from \'./a.ts\'\nexport const r = existing + helper()\n',
    'c.ts': 'export const existing = 1\n',
  })
  try {
    writeChanges((await runMove('helper', 'a.ts', 'c.ts', { cwd: fx.dir, verify: false })).changes)
    const b = fx.read('b.ts')
    assert.match(b, /import \{ existing, helper \} from ['"]\.\/c\.ts['"]/)
    assert.equal((b.match(/\.\/c\.ts/g) ?? []).length, 1)
    assert.doesNotMatch(b, /\.\/a\.ts/)
  }
  finally { fx.cleanup() }
})

it('move handles type-only sole named imports', async () => {
  const fx = makeFixture({
    'a.ts': 'export interface MyType { value: number }\n',
    'b.ts': 'import type { MyType } from \'./a.ts\'\nexport const v: MyType = { value: 1 }\n',
    'c.ts': '',
  })
  try {
    writeChanges((await runMove('MyType', 'a.ts', 'c.ts', { cwd: fx.dir, verify: false })).changes)
    assert.match(fx.read('b.ts'), /import type \{ MyType \} from ['"]\.\/c\.ts['"]/)
  }
  finally { fx.cleanup() }
})

it('move copies type-only imports as type-only imports', async () => {
  const fx = makeFixture({
    'types.ts': 'export interface Base { value: number }\n',
    'a.ts': 'import type { Base } from \'./types.ts\'\nexport interface MyType extends Base { label: string }\n',
    'c.ts': '',
  })
  try {
    writeChanges((await runMove('MyType', 'a.ts', 'c.ts', { cwd: fx.dir, verify: false })).changes)
    assert.match(fx.read('c.ts'), /import (?:type \{ Base \}|\{ type Base \}) from ['"]\.\/types\.ts['"]/)
    assert.doesNotMatch(fx.read('c.ts'), /import \{ Base \}/)
  }
  finally { fx.cleanup() }
})

it('move handles multiline named imports via fallback path', async () => {
  const fx = makeFixture({
    'a.ts': 'export function helper() { return 1 }\nexport function other() { return 2 }\n',
    'b.ts': 'import {\n  helper,\n  other,\n} from \'./a.ts\'\nexport const r = helper() + other()\n',
    'c.ts': '',
  })
  try {
    writeChanges((await runMove('helper', 'a.ts', 'c.ts', { cwd: fx.dir, verify: false })).changes)
    const b = fx.read('b.ts')
    assert.match(b, /other[\s\S]*from ['"]\.\/a\.ts['"]/)
    assert.match(b, /helper[\s\S]*from ['"]\.\/c\.ts['"]/)
  }
  finally { fx.cleanup() }
})

it('move preserves extensionless import style when moving a simple import', async () => {
  const fx = makeFixture({
    'a.ts': 'export function helper() { return 1 }\n',
    'b.ts': 'import { helper } from \'./a\'\nexport const r = helper()\n',
    'c.ts': '',
  })
  try {
    writeChanges((await runMove('helper', 'a.ts', 'c.ts', { cwd: fx.dir, verify: false })).changes)
    assert.match(fx.read('b.ts'), /from ['"]\.\/c['"]/)
  }
  finally { fx.cleanup() }
})

it('move throws on missing symbol', async () => {
  const fx = makeFixture({
    'a.ts': 'export function foo() {}\n',
    'c.ts': '',
  })
  try {
    await assert.rejects(
      async () => runMove('missing', 'a.ts', 'c.ts', { cwd: fx.dir }),
      /no top-level export named "missing"/,
    )
  }
  finally { fx.cleanup() }
})

it('move does not merge a value binding into an existing type-only import of the target', async () => {
  const fx = makeFixture({
    'a.ts': 'export function helper(): Shape { return { n: 1 } }\nimport type { Shape } from \'./c.ts\'\n',
    'b.ts': 'import type { Shape } from \'./c.ts\'\nimport { helper } from \'./a.ts\'\nexport const r: Shape = helper()\n',
    'c.ts': 'export interface Shape { n: number }\n',
  })
  try {
    const result = await runMove('helper', 'a.ts', 'c.ts', { cwd: fx.dir })
    writeChanges(result.changes)
    const b = fx.read('b.ts')
    assert.match(b, /import type \{ Shape \} from '\.\/c\.ts'/, 'type import untouched')
    assert.match(b, /import \{ helper \} from '\.\/c\.ts'/, 'value import added separately')
    assert.doesNotMatch(b, /import type \{ Shape, helper \}/)
    assert.equal(result.regressions.length, 0, JSON.stringify(result.regressions))
  }
  finally { fx.cleanup() }
})

it('move preserves a namespace import of the destination', async () => {
  const fx = makeFixture({
    'a.ts': 'export function helper() { return 2 }\n',
    'b.ts': 'import * as target from \'./c.ts\'\nimport { helper as movedHelper } from \'./a.ts\'\nexport const result = movedHelper() + target.existing\n',
    'c.ts': 'export const existing = 3\n',
  })
  try {
    const result = await runMove('helper', 'a.ts', 'c.ts', { cwd: fx.dir })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `console.log((await import(${JSON.stringify(pathToFileURL(`${fx.dir}/b.ts`).href)})).result)`], { encoding: 'utf8' })
    assert.equal(output.trim(), '5')
  }
  finally { fx.cleanup() }
})

it.each([
  ['default only', 'import helper from', 'helper()', '3'],
  ['default and named', 'import helper, { helper as named } from', 'helper() + named()', '5'],
])('move preserves a default import with the same local name, %s', async (_, binding, expression, expected) => {
  const fx = makeFixture({
    'a.ts': 'export default function main() { return 3 }\nexport function helper() { return 2 }\n',
    'b.ts': `${binding} './a.ts'\nexport const result = ${expression}\n`,
    'c.ts': '',
  })
  try {
    const result = await runMove('helper', 'a.ts', 'c.ts', { cwd: fx.dir })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `console.log((await import(${JSON.stringify(pathToFileURL(`${fx.dir}/b.ts`).href)})).result)`], { encoding: 'utf8' })
    assert.equal(output.trim(), expected)
  }
  finally { fx.cleanup() }
})
