import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { compileScript, parse } from '@vue/compiler-sfc'
import { runMove } from 'ripide-api'
import ts from 'typescript'
import { it } from 'vitest'
import { vueServices } from './engine-fixture.ts'

it('preserves local Vue bindings when moving a Nuxt auto-import out of scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripide-nuxt-move-safety-'))
  try {
    cpSync(new URL('./fixtures/nuxt/', import.meta.url), dir, { recursive: true })
    const source = `<script setup lang="ts">
const format = (value: number) => value * 10
const label = format(7)
</script>
<template>{{ label }} {{ format(1) }}</template>
`
    writeFileSync(join(dir, 'pages/local.vue'), source)
    const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { ...{ cwd: dir, verifyMode: 'none' as const }, engine: vueServices() })
    const transformed = result.changes.find(change => change.rel === 'pages/local.vue')?.after ?? source
    const { descriptor } = parse(transformed)
    const compiled = compileScript(descriptor, { id: 'local' })
    assert.equal(compiled.bindings?.format, 'setup-const')
    assert.equal(transformed, source)
    assert.equal(readFileSync(join(dir, 'pages/local.vue'), 'utf8'), source)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([
  `<script setup lang="ts">const { format } = { format: (value: number) => value }</script><template>{{ format(1) }}</template>`,
  `<script setup lang="ts">import format from '../other'</script><template>{{ format(1) }}</template>`,
  `<script lang="ts">export default { methods: { format: (value: number) => value } }</script><template>{{ format(1) }}</template>`,
  `<script setup lang="ts">const rows = [1]</script><template><p v-for="format in rows">{{ format }}</p></template>`,
  `<script setup lang="ts">const rows = [1]</script><template><Widget v-slot="{ format }">{{ format(1) }}</Widget></template>`,
  `<script setup lang="ts">function local(format: (value: number) => number) { return format(1) }</script><template><Widget v-slot="_ctx">{{ _ctx.format }}</Widget></template>`,
  `<script setup lang="ts">function local(format: (value: number) => number) { return format(1) }; const rows = [1]</script><template><p v-for="_ctx in rows">{{ _ctx.format }}</p></template>`,
  `<script setup lang="ts">defineProps<{ format: (value: number) => string }>()</script><template>{{ format(1) }}</template>`,
  `<script setup lang="ts">defineProps(['format'])</script><template>{{ format(1) }}</template>`,
])('preserves locally resolved Vue consumers during Nuxt moves: %s', async (source) => {
  const dir = mkdtempSync(join(tmpdir(), 'ripide-nuxt-local-'))
  try {
    cpSync(new URL('./fixtures/nuxt/', import.meta.url), dir, { recursive: true })
    writeFileSync(join(dir, 'pages/local.vue'), source)
    const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { ...{ cwd: dir, verifyMode: 'none' as const }, engine: vueServices() })
    assert.equal(result.changes.find(change => change.rel === 'pages/local.vue'), undefined)
    assert.equal(readFileSync(join(dir, 'pages/local.vue'), 'utf8'), source)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([false, true])('preserves imported prop types and refuses prop capture: free script use %s', async (freeUse) => {
  const dir = mkdtempSync(join(tmpdir(), 'ripide-nuxt-prop-binding-'))
  try {
    cpSync(new URL('./fixtures/nuxt/', import.meta.url), dir, { recursive: true })
    writeFileSync(join(dir, 'types.ts'), 'export interface Props { format: (value: number) => string }')
    const provider = readFileSync(join(dir, 'utils/format.ts'), 'utf8')
    const source = `<script setup lang="ts">
import type { Props } from '../types'
defineProps<Props>()
${freeUse ? 'const label = format(7)' : ''}
</script>
<template>{{ format(1) }}</template>
`
    writeFileSync(join(dir, 'pages/props.vue'), source)
    if (freeUse) {
      await assert.rejects(
        () => runMove('format', 'utils/format.ts', 'lib/format.ts', { ...{ cwd: dir, verifyMode: 'none' as const }, engine: vueServices() }),
        /Use an explicit import alias before moving it/,
      )
    }
    else {
      const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { ...{ cwd: dir, verifyMode: 'none' as const }, engine: vueServices() })
      assert.equal(result.changes.find(change => change.rel === 'pages/props.vue'), undefined)
    }
    assert.equal(readFileSync(join(dir, 'pages/props.vue'), 'utf8'), source)
    assert.equal(readFileSync(join(dir, 'utils/format.ts'), 'utf8'), provider)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([
  `const format = (value: number) => value * 10; export const label = format(7)`,
  `const { format } = { format: (value: number) => value * 10 }; export const label = format(7)`,
  `function local(format: (value: number) => number) { return format(7) }; export const label = local(value => value * 10)`,
])('preserves locally bound TypeScript consumers during Nuxt moves: %s', async (source) => {
  const dir = mkdtempSync(join(tmpdir(), 'ripide-nuxt-ts-'))
  try {
    cpSync(new URL('./fixtures/nuxt/', import.meta.url), dir, { recursive: true })
    writeFileSync(join(dir, 'consumer.ts'), source)
    const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { ...{ cwd: dir, verifyMode: 'none' as const }, engine: vueServices() })
    const transformed = result.changes.find(change => change.rel === 'consumer.ts')?.after ?? source
    const exports = {}
    runInNewContext(ts.transpileModule(transformed, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports })
    assert.deepEqual(exports, { label: 70 })
    assert.equal(result.changes.find(change => change.rel === 'consumer.ts'), undefined)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('imports free uses while preserving function parameters and existing import aliases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripide-nuxt-mixed-'))
  try {
    cpSync(new URL('./fixtures/nuxt/', import.meta.url), dir, { recursive: true })
    const source = `import { format as other } from './lib/format'
function local(format: (value: number) => number) { return format(7) }
export const labels = [local(value => value * 10), format(2), other(3)]
`
    writeFileSync(join(dir, 'consumer.ts'), source)
    const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { ...{ cwd: dir, verifyMode: 'none' as const }, engine: vueServices() })
    const transformed = result.changes.find(change => change.rel === 'consumer.ts')!.after
    const exports = {}
    runInNewContext(ts.transpileModule(transformed, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      exports,
      require: () => {
        const exports = {}
        const provider = result.changes.find(change => change.rel === 'lib/format.ts')!.after
        runInNewContext(ts.transpileModule(provider, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports })
        return exports
      },
    })
    assert.deepEqual(JSON.parse(JSON.stringify(exports)), { labels: [70, '#2', '#3'] })
    assert.equal(readFileSync(join(dir, 'consumer.ts'), 'utf8'), source)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('imports normal-script free uses without capturing setup-local bindings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripide-nuxt-normal-'))
  try {
    cpSync(new URL('./fixtures/nuxt/', import.meta.url), dir, { recursive: true })
    const source = `<script lang="ts">export const normalLabel = format(2)</script>
<script setup lang="ts">
const format = (value: number) => value * 10
const label = format(7)
</script>
<template>{{ label }}</template>
`
    writeFileSync(join(dir, 'pages/dual.vue'), source)
    const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { ...{ cwd: dir, verifyMode: 'none' as const }, engine: vueServices() })
    const transformed = result.changes.find(change => change.rel === 'pages/dual.vue')!.after
    const { descriptor } = parse(transformed)
    const compiled = compileScript(descriptor, { id: 'dual' })
    const normal = ts.createSourceFile('normal.ts', descriptor.script!.content, ts.ScriptTarget.Latest, true)
    assert.equal(normal.statements.filter(ts.isImportDeclaration).length, 1)
    const setup = ts.createSourceFile('setup.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true)
    assert.equal(setup.statements.filter(ts.isImportDeclaration).length, 0)
    const exports: { normalLabel?: string, default?: { setup: (props: object, ctx: object) => { label: number } } } = {}
    runInNewContext(ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      exports,
      require: (specifier: string) => {
        if (specifier === 'vue')
          return { defineComponent: (value: object) => value }
        const exports = {}
        const provider = result.changes.find(change => change.rel === 'lib/format.ts')!.after
        runInNewContext(ts.transpileModule(provider, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports })
        return exports
      },
    })
    assert.equal(exports.normalLabel, '#2')
    assert.equal(exports.default!.setup({}, { expose: () => {} }).label, 70)
    assert.equal(readFileSync(join(dir, 'pages/dual.vue'), 'utf8'), source)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('handles imported macro types without compiling their runtime props', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ripide-nuxt-props-'))
  try {
    cpSync(new URL('./fixtures/nuxt/', import.meta.url), dir, { recursive: true })
    writeFileSync(join(dir, 'types.ts'), 'export interface Props { label: string }')
    const source = `<script setup lang="ts">
import type { Props } from '../types'
defineProps<Props>()
const label = format(7)
</script>
<template>{{ label }}</template>
`
    writeFileSync(join(dir, 'pages/props.vue'), source)
    const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { ...{ cwd: dir, verifyMode: 'none' as const }, engine: vueServices() })
    const transformed = result.changes.find(change => change.rel === 'pages/props.vue')!.after
    const { descriptor } = parse(transformed)
    const setup = ts.createSourceFile('setup.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true)
    const imports = setup.statements.filter(ts.isImportDeclaration)
    assert.equal(imports.filter(node => !node.importClause?.isTypeOnly).length, 1)
    assert.equal(imports.filter(node => node.importClause?.isTypeOnly).length, 1)
    assert.equal(readFileSync(join(dir, 'pages/props.vue'), 'utf8'), source)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([
  `export default { name: 'Dual' }`,
  `function __ripideSetup() { return 1 }; export default {}`,
])('imports into script setup when a normal script appears first: %s', async (normalSource) => {
  const dir = mkdtempSync(join(tmpdir(), 'ripide-nuxt-dual-'))
  try {
    cpSync(new URL('./fixtures/nuxt/', import.meta.url), dir, { recursive: true })
    const source = `<script lang="ts">${normalSource} /*${'normal padding '.repeat(30)}*/</script>
<script setup lang="ts">
function local(format: (value: number) => number) { return format(7) }
const label = format(local(value => value))
</script>
<template>{{ label }}</template>
`
    writeFileSync(join(dir, 'pages/dual.vue'), source)
    const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { ...{ cwd: dir, verifyMode: 'none' as const }, engine: vueServices() })
    const transformed = result.changes.find(change => change.rel === 'pages/dual.vue')!.after
    const { descriptor } = parse(transformed)
    const compiled = compileScript(descriptor, { id: 'dual' })
    assert.equal(compiled.bindings?.format, 'setup-maybe-ref')
    const setup = ts.createSourceFile('dual.ts', descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true)
    const imports = setup.statements.filter(ts.isImportDeclaration)
    assert.equal(imports.length, 1)
    const normal = ts.createSourceFile('normal.ts', descriptor.script!.content, ts.ScriptTarget.Latest, true)
    assert.equal(normal.statements.filter(ts.isImportDeclaration).length, 0)
    assert.equal(readFileSync(join(dir, 'pages/dual.vue'), 'utf8'), source)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
