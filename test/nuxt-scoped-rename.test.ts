import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { runRename } from '@ripast/core'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { it } from 'vitest'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ripast-nuxt-scoped-'))
  cpSync(new URL('./fixtures/nuxt/', import.meta.url), dir, { recursive: true })
  writeFileSync(join(dir, 'pages/index.vue'), '<template>Unused</template>')
  return dir
}

function execute(source: string, globals: Record<string, unknown>, vue: Record<string, unknown> = {}): Record<string, unknown> {
  const exports = {}
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText, {
    exports,
    ...globals,
    require: (specifier: string) => specifier === 'vue' ? { defineComponent: (component: unknown) => component, ...vue } : globals,
  })
  return exports
}

function setup(source: string, globals: Record<string, unknown>, props: object = {}): Record<string, unknown> {
  const { descriptor } = parse(source)
  const module = execute(compileScript(descriptor, { id: 'scoped' }).content, globals)
  return (module.default as { setup: (props: object, context: object) => Record<string, unknown> }).setup(props, { expose: () => {} })
}

it.each([undefined, false])('renames only free Nuxt references across local scopes with verify %s', async (verify) => {
  const dir = fixture()
  try {
    const source = `<script lang="ts">export const normal = format(1)</script>
<script setup lang="ts">
function local(format: (value: number) => string) { return format(9) }
const label = format(2) + ':' + local(value => 'local:' + value)
const record = { format }
</script>
<template>{{ format(3) }}<span v-for="format in ['local']">{{ format }}</span><X v-slot="{ format }">{{ format }}</X>{{ ((format) => format)('inner') }}{{ {format} }}</template>`
    writeFileSync(join(dir, 'pages/index.vue'), source)
    writeFileSync(join(dir, 'consumer.ts'), `function local(format: (value: number) => string) { return format(4) }
export const label = format(5) + ':' + local(value => 'local:' + value)
export const record = { format }
`)
    const generated = readFileSync(join(dir, '.nuxt/imports.d.ts'), 'utf8')
    const result = await runRename('format', 'pretty', { cwd: dir, scope: 'utils/format.ts', verify })
    const provider = execute(result.changes.find(change => change.rel === 'utils/format.ts')!.after, {})
    const page = result.changes.find(change => change.rel === 'pages/index.vue')!.after
    const values = setup(page, provider)
    assert.equal(values.label, '#2:local:9')
    assert.equal((values.record as { format: unknown }).format, provider.pretty)
    const consumer = execute(result.changes.find(change => change.rel === 'consumer.ts')!.after, provider)
    assert.equal(consumer.label, '#5:local:4')
    assert.equal((consumer.record as { format: unknown }).format, provider.pretty)
    const template = compileTemplate({ id: 'scoped', filename: 'page.vue', source: parse(page).descriptor.template!.content })
    assert.deepEqual(template.errors, [])
    const displayed: unknown[] = []
    const render = execute(template.code, {}, {
      Fragment: Symbol('Fragment'),
      openBlock: () => {},
      createElementBlock: () => {},
      createElementVNode: () => {},
      createTextVNode: () => {},
      renderList: (values: unknown[], visit: (value: unknown) => void) => values.map(visit),
      resolveComponent: () => 'X',
      withCtx: (value: unknown) => value,
      createVNode: (_component: unknown, _props: unknown, slots: { default: (props: object) => void }) => slots.default({ format: 'slot' }),
      toDisplayString: (value: unknown) => {
        displayed.push(value)
        return String(value)
      },
    }).render as (context: object, cache: unknown[]) => unknown
    render(provider, [])
    assert.deepEqual(displayed.slice(0, 4), ['#3', 'local', 'slot', 'inner'])
    assert.equal((displayed[4] as { format: unknown }).format, provider.pretty)
    assert.equal(readFileSync(join(dir, 'pages/index.vue'), 'utf8'), source)
    assert.equal(readFileSync(join(dir, '.nuxt/imports.d.ts'), 'utf8'), generated)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('preserves a different active provider in a nested Nuxt context', async () => {
  const dir = fixture()
  try {
    mkdirSync(join(dir, 'apps/site/.nuxt'), { recursive: true })
    writeFileSync(join(dir, 'utils/active.ts'), 'export function format(value: number) { return value * 10 }')
    writeFileSync(join(dir, 'apps/site/.nuxt/imports.d.ts'), `declare global { const format: typeof import('../../../utils/active')['format'] } export {}`)
    writeFileSync(join(dir, 'pages/index.vue'), '<script setup lang="ts">const label = format(1)</script>')
    const child = '<script setup lang="ts">const label = format(2)</script><template>{{ format(3) }}</template>'
    writeFileSync(join(dir, 'apps/site/page.vue'), child)
    const result = await runRename('format', 'pretty', { cwd: dir, scope: 'utils/format.ts', verify: false })
    assert.equal(result.changes.find(change => change.rel === 'apps/site/page.vue'), undefined)
    assert.equal(setup(child, execute(readFileSync(join(dir, 'utils/active.ts'), 'utf8'), {})).label, 20)
    assert.equal(setup(result.changes.find(change => change.rel === 'pages/index.vue')!.after, { pretty: (value: number) => `#${value}` }).label, '#1')
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('refuses a new name captured by a nested parameter before writes', async () => {
  const dir = fixture()
  try {
    const source = '<script setup lang="ts">function local(pretty: unknown) { return format(1) }; const label = local(9)</script>'
    writeFileSync(join(dir, 'pages/index.vue'), source)
    await assert.rejects(runRename('format', 'pretty', { cwd: dir, scope: 'utils/format.ts', verify: false }), /captur|bound|collision/)
    assert.equal(setup(source, { format: (value: number) => `#${value}` }).label, '#1')
    assert.equal(readFileSync(join(dir, 'pages/index.vue'), 'utf8'), source)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it.each([
  '<script setup lang="ts">const pretty = () => "local"; const label = format(1)</script>',
  '<script setup lang="ts">defineProps<{ pretty: string }>()</script><template>{{ format(1) }}</template>',
  '<template><span v-for="pretty in [1]">{{ format(pretty) }}</span></template>',
  '<template><X v-slot="{ pretty }">{{ format(pretty) }}</X></template>',
  '<template>{{ ((pretty) => format(pretty))(1) }}</template>',
])('refuses a captured target in scripts and templates: %s', async (source) => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'pages/index.vue'), source)
    await assert.rejects(runRename('format', 'pretty', { cwd: dir, scope: 'utils/format.ts', verify: false }), /capture/)
    assert.equal(readFileSync(join(dir, 'pages/index.vue'), 'utf8'), source)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('refuses a target already supplied by another generated provider', async () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'utils/other.ts'), 'export const pretty = () => "other"')
    writeFileSync(join(dir, '.nuxt/imports.d.ts'), `${readFileSync(join(dir, '.nuxt/imports.d.ts'), 'utf8')}\ndeclare global { const pretty: typeof import('../utils/other')['pretty'] }`)
    const source = '<script setup lang="ts">const label = format(1)</script>'
    writeFileSync(join(dir, 'pages/index.vue'), source)
    await assert.rejects(runRename('format', 'pretty', { cwd: dir, scope: 'utils/format.ts', verify: false }), /Nuxt binding/)
    assert.equal(readFileSync(join(dir, 'pages/index.vue'), 'utf8'), source)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('preserves explicit import aliases alongside free and locally shadowed references', async () => {
  const dir = fixture()
  try {
    const script = `import { format as direct } from '../utils/format'
function local(format: (value: number) => string) { return format(3) }
const label = direct(1) + ':' + format(2) + ':' + local(value => 'local:' + value)
`
    writeFileSync(join(dir, 'pages/index.vue'), `<script setup lang="ts">${script}</script><template>{{ format(4) }} {{ direct(5) }}</template>`)
    mkdirSync(join(dir, 'plugins'), { recursive: true })
    writeFileSync(join(dir, 'plugins/mixed.ts'), `${script}export { label }`)
    const result = await runRename('format', 'pretty', { cwd: dir, scope: 'utils/format.ts', verify: false })
    const provider = execute(result.changes.find(change => change.rel === 'utils/format.ts')!.after, {})
    assert.equal(setup(result.changes.find(change => change.rel === 'pages/index.vue')!.after, provider).label, '#1:#2:local:3')
    assert.equal(execute(result.changes.find(change => change.rel === 'plugins/mixed.ts')!.after, provider).label, '#1:#2:local:3')
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('preserves BOM, CRLF, and escaped identifiers across both script blocks', async () => {
  const dir = fixture()
  try {
    const source = '\uFEFF<script lang="ts">export const normal = f\\u006frmat(1)</script>\r\n<script setup lang="ts">\r\nconst label = f\\u006frmat(2)\r\nconst record = { f\\u006frmat }\r\n</script>\r\n<template>{{ f\\u006frmat(3) }}</template>\r\n'
    writeFileSync(join(dir, 'pages/index.vue'), source)
    const result = await runRename('format', 'pretty', { cwd: dir, scope: 'utils/format.ts', verify: false })
    const page = result.changes.find(change => change.rel === 'pages/index.vue')!.after
    const provider = execute(result.changes.find(change => change.rel === 'utils/format.ts')!.after, {})
    assert.equal(setup(page, provider).label, '#2')
    assert.equal((setup(page, provider).record as { format: unknown }).format, provider.pretty)
    assert.equal(page.charCodeAt(0), 0xFEFF)
    assert.equal(page.replace(/\r\n/g, '').includes('\n'), false)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('renames a provider whose name matches the old synthetic setup wrapper', async () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'utils/format.ts'), 'export function __ripastSetup(value: number) { return "#" + value }')
    writeFileSync(join(dir, '.nuxt/imports.d.ts'), `declare global { const __ripastSetup: typeof import('../utils/format')['__ripastSetup'] } export {}`)
    writeFileSync(join(dir, 'pages/index.vue'), '<script setup lang="ts">const label = __ripastSetup(1)</script><template>{{ __ripastSetup(2) }}</template>')
    const result = await runRename('__ripastSetup', 'pretty', { cwd: dir, scope: 'utils/format.ts', verify: false })
    assert.equal(setup(result.changes.find(change => change.rel === 'pages/index.vue')!.after, { pretty: (value: number) => `#${value}` }).label, '#1')
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('preserves a prop named like the provider while renaming free script calls', async () => {
  const dir = fixture()
  try {
    const source = '<script setup lang="ts">defineProps<{ format: string }>(); const label = format(1)</script><template>{{ format }} {{ { format } }}</template>'
    writeFileSync(join(dir, 'pages/index.vue'), source)
    const result = await runRename('format', 'pretty', { cwd: dir, scope: 'utils/format.ts', verify: false })
    const page = result.changes.find(change => change.rel === 'pages/index.vue')!.after
    assert.equal(setup(page, { pretty: (value: number) => `#${value}` }, { format: 'prop' }).label, '#1')
    const compiled = compileTemplate({ id: 'prop', filename: 'page.vue', source: parse(page).descriptor.template!.content })
    const displayed: unknown[] = []
    const render = execute(compiled.code, {}, {
      toDisplayString: (value: unknown) => { displayed.push(value) },
    }).render as (context: object, cache: unknown[]) => unknown
    render({ format: 'prop' }, [])
    assert.equal(displayed[0], 'prop')
    assert.equal((displayed[1] as { format: unknown }).format, 'prop')
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('preserves v-bind shorthand prop names while renaming Nuxt auto-imports', async () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'pages/index.vue'), '<template><Child :format /></template>')
    const result = await runRename('format', 'pretty', { cwd: dir, scope: 'utils/format.ts', verify: false })
    const page = result.changes.find(change => change.rel === 'pages/index.vue')!.after
    const template = compileTemplate({ id: 'v-bind-shorthand', filename: 'page.vue', source: parse(page).descriptor.template!.content })
    const props: object[] = []
    const render = execute(template.code, {}, {
      openBlock: () => {},
      createBlock: (_component: unknown, value: object) => { props.push(value) },
      resolveComponent: () => 'Child',
    }).render as (context: object, cache: unknown[]) => unknown
    const pretty = () => 'pretty'
    render({ pretty }, [])
    assert.equal((props[0] as { format: unknown }).format, pretty)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('renames free JSX expressions while preserving JSX attributes and imported types', async () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'info.ts'), 'export interface Info { value: string }')
    const source = `import type { Info } from './info'
function local(format: (value: number) => string) { return format(3) }
export const label: Info['value'] = format(1) + ':' + local(value => 'local:' + value)
export const element = <div format={format(2)} />
`
    writeFileSync(join(dir, 'consumer.tsx'), source)
    const result = await runRename('format', 'pretty', { cwd: dir, scope: 'utils/format.ts', verify: false })
    const output = execute(result.changes.find(change => change.rel === 'consumer.tsx')!.after, {
      pretty: (value: number) => `#${value}`,
      React: { createElement: (_tag: unknown, props: object) => props },
    })
    assert.equal(output.label, '#1:local:3')
    assert.equal((output.element as { format: unknown }).format, '#2')
    assert.equal(readFileSync(join(dir, 'consumer.tsx'), 'utf8'), source)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it.each(['script-and-template', 'template-only', 'template-alias'])('keeps semantic renames for explicit imports: %s', async (usage) => {
  const dir = fixture()
  try {
    const imported = usage === 'template-alias' ? 'format as local' : 'format'
    const label = usage === 'script-and-template' ? 'format(1)' : '"unused"'
    const call = usage === 'template-alias' ? 'local(2)' : 'format(2)'
    writeFileSync(join(dir, 'pages/index.vue'), `<script setup lang="ts">import { ${imported} } from "../utils/format"; const label = ${label}</script><template>{{ ${call} }}</template>`)
    const result = await runRename('format', 'pretty', { cwd: dir, scope: 'utils/format.ts', verify: false })
    const page = result.changes.find(change => change.rel === 'pages/index.vue')!.after
    const provider = execute(result.changes.find(change => change.rel === 'utils/format.ts')!.after, {})
    const state = setup(page, provider)
    assert.equal(state.label, usage === 'script-and-template' ? '#1' : 'unused')
    const displayed: unknown[] = []
    const compiled = compileTemplate({ id: 'import', filename: 'page.vue', source: parse(page).descriptor.template!.content })
    const render = execute(compiled.code, {}, { toDisplayString: (value: unknown) => {
      displayed.push(value)
    } }).render as (context: object, cache: unknown[]) => unknown
    render(state, [])
    assert.deepEqual(displayed, ['#2'])
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it.each(['js', 'jsx'])('preserves local function names in %s Nuxt consumers', async (extension) => {
  const dir = fixture()
  try {
    const source = `function nested() {
  function format(value) { return 'local:' + value }
  return format.name + ':' + format(9)
}
export const label = format(1) + ':' + nested()
`
    writeFileSync(join(dir, `consumer.${extension}`), source)
    const result = await runRename('format', 'pretty', { cwd: dir, scope: 'utils/format.ts', verify: false })
    const output = execute(result.changes.find(change => change.rel === `consumer.${extension}`)!.after, { pretty: (value: number) => `#${value}` })
    assert.equal(output.label, '#1:format:local:9')
    assert.equal(readFileSync(join(dir, `consumer.${extension}`), 'utf8'), source)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('refuses unresolved aliases of the renamed export before source writes', async () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, '.nuxt/imports.d.ts'), `declare global { const pretty: typeof import('../utils/format')['format'] } export {}`)
    const source = '<script setup lang="ts">const label = pretty(1)</script>'
    writeFileSync(join(dir, 'pages/index.vue'), source)
    await assert.rejects(runRename('format', 'renamed', { cwd: dir, scope: 'utils/format.ts', verify: false }), /unresolved Nuxt auto-import uses/)
    assert.equal(setup(source, { pretty: (value: number) => `#${value}` }).label, '#1')
    assert.equal(readFileSync(join(dir, 'pages/index.vue'), 'utf8'), source)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

it('refuses a target supplied by the JavaScript runtime', async () => {
  const dir = fixture()
  try {
    const source = '<script setup lang="ts">const label = format(1)</script>'
    writeFileSync(join(dir, 'pages/index.vue'), source)
    await assert.rejects(async () => {
      const result = await runRename('format', 'Math', { cwd: dir, scope: 'utils/format.ts', verify: false })
      setup(result.changes.find(change => change.rel === 'pages/index.vue')!.after, {})
    }, /binding|capture/)
    assert.equal(setup(source, { format: (value: number) => `#${value}` }).label, '#1')
    assert.equal(readFileSync(join(dir, 'pages/index.vue'), 'utf8'), source)
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})
