import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { runMove, runRename, runRenameFile } from '@ripast/core'
import { compileScript, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { it } from 'vitest'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ripast-nuxt-provider-'))
  cpSync(new URL('./fixtures/nuxt/', import.meta.url), dir, { recursive: true })
  writeFileSync(join(dir, 'pages/index.vue'), '<template>Unused</template>')
  return dir
}

function moduleExports(source: string): Record<string, unknown> {
  const exports = {}
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports })
  return exports
}

function labelFromVue(source: string, provider: Record<string, unknown>, globals: Record<string, unknown> = {}): unknown {
  const { descriptor } = parse(source)
  const compiled = compileScript(descriptor, { id: 'provider' })
  const exports: { default?: { setup: (props: object, context: object) => { label: unknown } } } = {}
  runInNewContext(ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
    exports,
    ...globals,
    require: (specifier: string) => specifier === 'vue' ? { defineComponent: (value: object) => value } : provider,
  })
  return exports.default!.setup({}, { expose: () => {} }).label
}

it('moves an inactive provider without importing it into active consumers', async () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'utils/active.ts'), 'export function format(value: number) { return value * 10 }')
    writeFileSync(join(dir, '.nuxt/imports.d.ts'), `declare global { const format: typeof import('../utils/active')['format'] } export {}`)
    const source = '<script setup lang="ts">const label = format(7)</script><template>{{ label }}</template>'
    writeFileSync(join(dir, 'pages/index.vue'), source)
    const result = await runMove('format', 'utils/format.ts', 'lib/inactive.ts', { cwd: dir })
    assert.equal(result.changes.find(change => change.rel === 'pages/index.vue'), undefined)
    assert.equal(labelFromVue(source, {}, moduleExports(readFileSync(join(dir, 'utils/active.ts'), 'utf8'))), 70)
    assert.deepEqual(result.regressions, [])
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('imports an active source export under each generated global alias', async () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, '.nuxt/imports.d.ts'), `declare global {
const pretty: typeof import('../utils/format')['format']
const prettier: typeof import('../utils/format').format
} export {}`)
    const source = '<script setup lang="ts">const label = pretty(7) + ":" + prettier(8)</script><template>{{ label }}</template>'
    writeFileSync(join(dir, 'pages/index.vue'), source)
    const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { cwd: dir })
    const transformed = result.changes.find(change => change.rel === 'pages/index.vue')!.after
    const provider = moduleExports(result.changes.find(change => change.rel === 'lib/format.ts')!.after)
    assert.equal(labelFromVue(transformed, provider), '#7:#8')
    assert.ok(result.regressions.length > 0)
    assert.ok(result.regressions.every(regression => regression.file.includes('.nuxt/')))
    assert.equal(readFileSync(join(dir, 'pages/index.vue'), 'utf8'), source)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

function appFixture() {
  const dir = fixture()
  rmSync(join(dir, 'pages'), { recursive: true })
  mkdirSync(join(dir, 'app/utils'), { recursive: true })
  mkdirSync(join(dir, 'app/pages'))
  mkdirSync(join(dir, '.nuxt/types'))
  writeFileSync(join(dir, 'app/utils/format.ts'), readFileSync(join(dir, 'utils/format.ts'), 'utf8'))
  writeFileSync(join(dir, '.nuxt/imports.d.ts'), `export { format } from '../app/utils/format'`)
  writeFileSync(join(dir, '.nuxt/types/imports.d.ts'), `declare global { const format: typeof import('../../app/utils/format').format } export {}`)
  const source = '<script setup lang="ts">const label = format(7)</script><template>{{ format(8) }} {{ label }}</template>'
  writeFileSync(join(dir, 'app/pages/index.vue'), source)
  return { dir, source }
}

it('adds explicit imports for standard Nuxt app providers moved out of scope', async () => {
  const { dir, source } = appFixture()
  try {
    const result = await runMove('format', 'app/utils/format.ts', 'lib/format.ts', { cwd: dir })
    const transformed = result.changes.find(change => change.rel === 'app/pages/index.vue')!.after
    const provider = moduleExports(result.changes.find(change => change.rel === 'lib/format.ts')!.after)
    assert.equal(labelFromVue(transformed, provider), '#7')
    assert.ok(result.regressions.length > 0)
    assert.ok(result.regressions.every(regression => regression.file.includes('.nuxt/')))
    assert.equal(readFileSync(join(dir, 'app/pages/index.vue'), 'utf8'), source)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('renames standard Nuxt app providers in both script and template', async () => {
  const { dir, source } = appFixture()
  try {
    const result = await runRename('format', 'pretty', { cwd: dir, scope: 'app/utils/format.ts' })
    const transformed = result.changes.find(change => change.rel === 'app/pages/index.vue')!.after
    const provider = moduleExports(result.changes.find(change => change.rel === 'app/utils/format.ts')!.after)
    assert.equal(labelFromVue(transformed, {}, provider), '#7')
    const { descriptor } = parse(transformed)
    const template = descriptor.template!.content
    const expression = template.slice(template.indexOf('{{') + 2, template.indexOf('}}')).trim()
    assert.equal(runInNewContext(expression, provider), '#8')
    assert.equal(result.changes.some(change => change.rel.includes('.nuxt/')), false)
    assert.equal(readFileSync(join(dir, 'app/pages/index.vue'), 'utf8'), source)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('refuses a Nuxt rename that captures a local binding aliased to the same provider', async () => {
  const { dir } = appFixture()
  try {
    writeFileSync(join(dir, '.nuxt/types/imports.d.ts'), `declare global {
const format: typeof import('../../app/utils/format').format
const pretty: typeof import('../../app/utils/format').format
} export {}`)
    const source = '<script setup lang="ts">const pretty = (value: number) => value * 10; const label = format(7)</script><template>{{ label }}</template>'
    writeFileSync(join(dir, 'app/pages/index.vue'), source)
    await assert.rejects(runRename('format', 'pretty', { cwd: dir, scope: 'app/utils/format.ts', verify: false }), /Nuxt binding/)
    assert.equal(readFileSync(join(dir, 'app/pages/index.vue'), 'utf8'), source)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('refuses a Nuxt rename captured by another export of the same provider', async () => {
  const { dir } = appFixture()
  try {
    writeFileSync(join(dir, 'app/utils/format.ts'), 'export function format(value: number) { return value }\nexport const pretty = (value: number) => value * 10')
    writeFileSync(join(dir, '.nuxt/types/imports.d.ts'), `declare global {
const format: typeof import('../../app/utils/format').format
const pretty: typeof import('../../app/utils/format').pretty
} export {}`)
    const source = '<script setup lang="ts">const label = format(7)</script><template>{{ label }}</template>'
    writeFileSync(join(dir, 'app/pages/index.vue'), source)
    await assert.rejects(runRename('format', 'pretty', { cwd: dir, scope: 'app/utils/format.ts', verify: false }), /Nuxt binding/)
    assert.equal(readFileSync(join(dir, 'app/pages/index.vue'), 'utf8'), source)
    assert.equal(typeof moduleExports(readFileSync(join(dir, 'app/utils/format.ts'), 'utf8')).format, 'function')
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('adds imports when renaming a standard Nuxt app composable file out of scope', async () => {
  const { dir } = appFixture()
  try {
    mkdirSync(join(dir, 'app/composables'))
    writeFileSync(join(dir, 'app/composables/useCounter.ts'), 'export function useCounter() { return 7 }')
    writeFileSync(join(dir, '.nuxt/imports.d.ts'), `export { format } from '../app/utils/format'; export { useCounter } from '../app/composables/useCounter'`)
    writeFileSync(join(dir, '.nuxt/types/imports.d.ts'), `declare global { const format: typeof import('../../app/utils/format').format; const useCounter: typeof import('../../app/composables/useCounter').useCounter } export {}`)
    const source = '<script setup lang="ts">const label = useCounter()</script><template>{{ label }}</template>'
    writeFileSync(join(dir, 'app/pages/index.vue'), source)
    const result = await runRenameFile('app/composables/useCounter.ts', 'lib/useCounter.ts', { cwd: dir })
    const transformed = result.changes.find(change => change.rel === 'app/pages/index.vue')!.after
    assert.equal(labelFromVue(transformed, moduleExports(readFileSync(join(dir, 'app/composables/useCounter.ts'), 'utf8'))), 7)
    assert.deepEqual(result.regressions, [])
    assert.equal(readFileSync(join(dir, 'app/pages/index.vue'), 'utf8'), source)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it.each(['~', 'src', 'tool'])('uses generated local alias %s to discover app providers', async (alias) => {
  const { dir, source } = appFixture()
  try {
    writeFileSync(join(dir, '.nuxt/tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { [alias === 'tool' ? alias : `${alias}/*`]: [alias === 'tool' ? 'app/utils/format.ts' : 'app/*'] } }, include: ['../**/*.ts'] }))
    writeFileSync(join(dir, '.nuxt/imports.d.ts'), `declare global { const format: typeof import('${alias === 'tool' ? alias : `${alias}/utils/format`}')['format'] } export {}`)
    rmSync(join(dir, '.nuxt/types/imports.d.ts'))
    const result = await runMove('format', 'app/utils/format.ts', 'lib/format.ts', { cwd: dir })
    const transformed = result.changes.find(change => change.rel === 'app/pages/index.vue')!.after
    assert.equal(labelFromVue(transformed, moduleExports(result.changes.find(change => change.rel === 'lib/format.ts')!.after)), '#7')
    assert.equal(readFileSync(join(dir, 'app/pages/index.vue'), 'utf8'), source)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it.each([undefined, false])('renames mixed local and global Nuxt app consumers with verify %s', async (verify) => {
  const { dir } = appFixture()
  try {
    const source = '<script setup lang="ts">function local() { const format = (value: number) => value; return format(1) }; const label = format(7) + ":" + local()</script><template>{{ format(8) }} {{ label }}</template>'
    writeFileSync(join(dir, 'app/pages/index.vue'), source)
    const result = await runRename('format', 'pretty', { cwd: dir, scope: 'app/utils/format.ts', verify })
    assert.equal(labelFromVue(result.changes.find(change => change.rel === 'app/pages/index.vue')!.after, {}, moduleExports(result.changes.find(change => change.rel === 'app/utils/format.ts')!.after)), '#7:1')
    assert.equal(readFileSync(join(dir, 'app/pages/index.vue'), 'utf8'), source)
    assert.equal(typeof moduleExports(readFileSync(join(dir, 'app/utils/format.ts'), 'utf8')).format === 'function', true)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('selects each nested Nuxt consumer provider before adding imports', async () => {
  const dir = fixture()
  try {
    mkdirSync(join(dir, 'apps/site/.nuxt'), { recursive: true })
    mkdirSync(join(dir, 'apps/site/pages'))
    writeFileSync(join(dir, 'apps/site/nuxt.config.ts'), 'export default {}')
    writeFileSync(join(dir, 'utils/active.ts'), 'export function format(value: number) { return value * 10 }')
    writeFileSync(join(dir, '.nuxt/imports.d.ts'), `declare global { const format: typeof import('../utils/active')['format'] } export {}`)
    writeFileSync(join(dir, 'apps/site/.nuxt/imports.d.ts'), `declare global { const pretty: typeof import('../../../utils/format')['format'] } export {}`)
    const root = '<script setup lang="ts">const label = format(7)</script><template>{{ label }}</template>'
    const child = '<script setup lang="ts">const label = pretty(8)</script><template>{{ label }}</template>'
    writeFileSync(join(dir, 'pages/index.vue'), root)
    writeFileSync(join(dir, 'apps/site/pages/index.vue'), child)
    const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { cwd: dir, verify: false })
    assert.equal(result.changes.find(change => change.rel === 'pages/index.vue'), undefined)
    const transformed = result.changes.find(change => change.rel === 'apps/site/pages/index.vue')!.after
    assert.equal(labelFromVue(transformed, moduleExports(result.changes.find(change => change.rel === 'lib/format.ts')!.after)), '#8')
    assert.equal(labelFromVue(root, {}, moduleExports(readFileSync(join(dir, 'utils/active.ts'), 'utf8'))), 70)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it.each([false, true])('resolves nested consumer imports despite shadowed aliases with extends %s', async (extendsRoot) => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, '.nuxt/tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '..', paths: { '#lib/*': ['lib/*'] } } }))
    mkdirSync(join(dir, 'apps/site/.nuxt'), { recursive: true })
    writeFileSync(join(dir, 'apps/site/.nuxt/imports.d.ts'), `declare global { const format: typeof import('../../../utils/format')['format'] } export {}`)
    writeFileSync(join(dir, 'apps/site/.nuxt/tsconfig.json'), JSON.stringify({
      ...(extendsRoot ? { extends: '../../../.nuxt/tsconfig.json' } : {}),
      compilerOptions: { baseUrl: '..', paths: { '#lib/*': ['lib/*'] } },
    }))
    mkdirSync(join(dir, 'apps/site/lib'))
    writeFileSync(join(dir, 'apps/site/lib/format.ts'), 'export function format() { return 999 }')
    const source = '<script setup lang="ts">const label = format(7)</script><template>{{ label }}</template>'
    writeFileSync(join(dir, 'apps/site/page.vue'), source)
    const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { cwd: dir, verify: false })
    const transformed = result.changes.find(change => change.rel === 'apps/site/page.vue')!.after
    const { descriptor } = parse(transformed)
    const compiled = compileScript(descriptor, { id: 'nested-alias' })
    const statement = ts.createSourceFile('consumer.ts', compiled.content, ts.ScriptTarget.Latest, true).statements.filter(ts.isImportDeclaration).find(statement => (statement.moduleSpecifier as ts.StringLiteral).text !== 'vue')!
    const specifier = (statement.moduleSpecifier as ts.StringLiteral).text
    const resolved = ts.resolveModuleName(specifier, join(dir, 'apps/site/page.vue'), {
      baseUrl: join(dir, 'apps/site'),
      paths: { '#lib/*': ['lib/*'] },
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    }, { ...ts.sys, fileExists: path => result.changes.some(change => change.path === path && change.after.length > 0) || ts.sys.fileExists(path), directoryExists: path => result.changes.some(change => change.path.startsWith(`${path}/`) && change.after.length > 0) || ts.sys.directoryExists(path) }).resolvedModule
    assert.equal(resolved?.resolvedFileName, join(dir, 'lib/format.ts'))
    assert.equal(readFileSync(join(dir, 'apps/site/page.vue'), 'utf8'), source)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it.each([undefined, false])('preserves another active provider when renaming an inactive provider with verify %s', async (verify) => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'utils/active.ts'), 'export function format(value: number) { return value * 10 }')
    writeFileSync(join(dir, '.nuxt/imports.d.ts'), `declare global {
const format: typeof import('../utils/active')['format']
} export {}`)
    const source = '<script setup lang="ts">const label = format(7)</script><template>{{ format(8) }} {{ label }}</template>'
    writeFileSync(join(dir, 'pages/index.vue'), source)
    const result = await runRename('format', 'pretty', { cwd: dir, scope: 'utils/format.ts', verify })
    assert.equal(result.changes.find(change => change.rel === 'pages/index.vue'), undefined)
    assert.equal(labelFromVue(source, {}, moduleExports(readFileSync(join(dir, 'utils/active.ts'), 'utf8'))), 70)
    assert.equal(readFileSync(join(dir, 'pages/index.vue'), 'utf8'), source)
    assert.equal(typeof moduleExports(readFileSync(join(dir, 'utils/format.ts'), 'utf8')).format, 'function')
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it.each([undefined, false])('preserves another nested Nuxt provider when renaming with verify %s', async (verify) => {
  const dir = fixture()
  try {
    mkdirSync(join(dir, 'apps/site/.nuxt'), { recursive: true })
    writeFileSync(join(dir, 'utils/active.ts'), 'export function format(value: number) { return value * 10 }')
    writeFileSync(join(dir, 'apps/site/.nuxt/imports.d.ts'), `declare global {
const format: typeof import('../../../utils/active')['format']
} export {}`)
    const root = '<script setup lang="ts">const label = format(7)</script><template>{{ label }}</template>'
    const child = '<script setup lang="ts">const label = format(8)</script><template>{{ format(9) }} {{ label }}</template>'
    writeFileSync(join(dir, 'pages/index.vue'), root)
    writeFileSync(join(dir, 'apps/site/page.vue'), child)
    const result = await runRename('format', 'pretty', { cwd: dir, scope: 'utils/format.ts', verify })
    assert.equal(result.changes.find(change => change.rel === 'apps/site/page.vue'), undefined)
    assert.equal(labelFromVue(result.changes.find(change => change.rel === 'pages/index.vue')!.after, {}, moduleExports(result.changes.find(change => change.rel === 'utils/format.ts')!.after)), '#7')
    assert.equal(labelFromVue(child, {}, moduleExports(readFileSync(join(dir, 'utils/active.ts'), 'utf8'))), 80)
    assert.equal(readFileSync(join(dir, 'pages/index.vue'), 'utf8'), root)
    assert.equal(readFileSync(join(dir, 'apps/site/page.vue'), 'utf8'), child)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('permits an inactive provider rename when consumer uses are local', async () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'utils/active.ts'), 'export function format(value: number) { return value * 10 }')
    writeFileSync(join(dir, '.nuxt/imports.d.ts'), `declare global { const format: typeof import('../utils/active')['format'] } export {}`)
    const source = '<script setup lang="ts">const format = (value: number) => value * 100; const label = format(7)</script><template>{{ format(8) }} {{ label }}</template>'
    writeFileSync(join(dir, 'pages/index.vue'), source)
    const result = await runRename('format', 'pretty', { cwd: dir, scope: 'utils/format.ts' })
    assert.equal(result.changes.find(change => change.rel === 'pages/index.vue'), undefined)
    assert.equal(labelFromVue(source, {}), 700)
    assert.equal(typeof moduleExports(result.changes.find(change => change.rel === 'utils/format.ts')!.after).pretty, 'function')
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})
