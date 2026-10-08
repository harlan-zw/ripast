import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { runDelete } from '@ripast/core'
import ts from 'typescript'
import { it } from 'vitest'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ripast-nuxt-delete-'))
  cpSync(new URL('./fixtures/nuxt/', import.meta.url), dir, { recursive: true })
  writeFileSync(join(dir, 'pages/index.vue'), '<template><p>Unused</p></template>')
  return dir
}

it.each([
  '<script setup lang="ts">const label = format(7)</script><template>{{ label }}</template>',
  '<template>{{ format(7) }}</template>',
  '<script lang="ts">export default { name: "NormalScriptIsLongerThanSetupScript" }</script><script setup>const label = format(7)</script><template>{{ label }}</template>',
])('refuses deletion of a live Nuxt auto-import: %s', async (source) => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'pages/index.vue'), source)
    const before = readFileSync(join(dir, 'utils/format.ts'), 'utf8')
    await assert.rejects(() => runDelete('format', 'utils/format.ts', { cwd: dir }), /auto-import/)
    assert.equal(readFileSync(join(dir, 'pages/index.vue'), 'utf8'), source)
    assert.equal(readFileSync(join(dir, 'utils/format.ts'), 'utf8'), before)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([
  `declare global { const pretty: typeof import("../utils/format")["format"] } export {}`,
  `declare global { const pretty: typeof import("../utils/format").format } export {}`,
  `declare global { const pretty: UnwrapRef<typeof import("../utils/format")["format"]> } export {}`,
  `export { format as pretty } from '../utils/format'`,
])('refuses consumers of generated aliases: %s', async (metadata) => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, '.nuxt/imports.d.ts'), metadata)
    writeFileSync(join(dir, 'pages/index.vue'), '<template>{{ pretty(7) }}</template>')
    await assert.rejects(() => runDelete('format', 'utils/format.ts', { cwd: dir }), /auto-imports.*pages\/index.vue/)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('reads current Nuxt global declarations under types with root export metadata', async () => {
  const dir = fixture()
  try {
    mkdirSync(join(dir, '.nuxt/types'))
    writeFileSync(join(dir, '.nuxt/imports.d.ts'), `export { format } from '../utils/format'`)
    writeFileSync(join(dir, '.nuxt/types/imports.d.ts'), `declare global { const format: typeof import('../../utils/format').format } export {}`)
    writeFileSync(join(dir, 'pages/index.vue'), '<template>{{ format(7) }}</template>')
    await assert.rejects(() => runDelete('format', 'utils/format.ts', { cwd: dir }), /auto-imports/)
    writeFileSync(join(dir, 'pages/index.vue'), '<template>Unused</template>')
    const result = await runDelete('format', 'utils/format.ts', { cwd: dir })
    const exports = {}
    runInNewContext(ts.transpileModule(result.changes[0]!.after, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports })
    assert.deepEqual(exports, {})
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each(['missing', 'malformed', 'bare-package', 'missing-export'])('refuses unresolved generated metadata: %s', async (kind) => {
  const dir = fixture()
  try {
    if (kind === 'missing')
      unlinkSync(join(dir, '.nuxt/imports.d.ts'))
    else if (kind === 'malformed')
      writeFileSync(join(dir, '.nuxt/imports.d.ts'), 'declare global { const format: typeof import(')
    else if (kind === 'bare-package')
      writeFileSync(join(dir, '.nuxt/imports.d.ts'), `declare global { const pretty: typeof import('workspace-provider')['format'] } export {}`)
    else
      writeFileSync(join(dir, '.nuxt/imports.d.ts'), 'export {}')
    const before = readFileSync(join(dir, 'utils/format.ts'), 'utf8')
    await assert.rejects(() => runDelete('format', 'utils/format.ts', { cwd: dir, verify: false }), /cannot resolve auto-import metadata/)
    assert.equal(readFileSync(join(dir, 'utils/format.ts'), 'utf8'), before)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('deletes an inactive provider without capturing the active global binding', async () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'utils/active.ts'), 'export function format(value: number) { return value * 10 }')
    writeFileSync(join(dir, '.nuxt/imports.d.ts'), `declare global { const format: typeof import('../utils/active')['format'] } export {}`)
    const source = '<template>{{ format(7) }}</template>'
    writeFileSync(join(dir, 'pages/index.vue'), source)
    const result = await runDelete('format', 'utils/format.ts', { cwd: dir })
    const exports = {}
    runInNewContext(ts.transpileModule(result.changes[0]!.after, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports })
    assert.deepEqual(exports, {})
    assert.equal(readFileSync(join(dir, 'pages/index.vue'), 'utf8'), source)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('checks each nested Nuxt app before deleting a workspace provider', async () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'utils/active.ts'), 'export function format(value: number) { return value * 10 }')
    writeFileSync(join(dir, '.nuxt/imports.d.ts'), `declare global { const format: typeof import('../utils/active')['format'] } export {}`)
    mkdirSync(join(dir, 'apps/site/.nuxt'), { recursive: true })
    mkdirSync(join(dir, 'apps/site/pages'))
    writeFileSync(join(dir, 'apps/site/.nuxt/imports.d.ts'), `declare global { const pretty: typeof import('../../../utils/format')['format'] } export {}`)
    writeFileSync(join(dir, 'apps/site/pages/index.vue'), '<template>{{ pretty(7) }}</template>')
    await assert.rejects(() => runDelete('format', 'utils/format.ts', { cwd: dir }), /auto-imports.*apps\/site\/pages\/index.vue/)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('matches a symlinked source to its active generated provider', async () => {
  const dir = fixture()
  try {
    symlinkSync('format.ts', join(dir, 'utils/link.ts'))
    writeFileSync(join(dir, 'pages/index.vue'), '<template>{{ format(7) }}</template>')
    await assert.rejects(() => runDelete('format', 'utils/link.ts', { cwd: dir }), /auto-imports/)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('preserves unrelated named import aliases while deleting an unused provider', async () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'other.ts'), 'export function format(value: number) { return value * 10 }')
    writeFileSync(join(dir, 'consumer.ts'), `import { format as other } from './other'; export const label = other(7)`)
    const result = await runDelete('format', 'utils/format.ts', { cwd: dir })
    const exports = {}
    runInNewContext(ts.transpileModule(result.changes[0]!.after, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports })
    assert.deepEqual(exports, {})
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('refuses an external Nuxt template whose implicit bindings cannot be inspected', async () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'pages/index.vue'), '<script setup lang="ts">const unrelated = 1</script><template src="./external.html"></template>')
    writeFileSync(join(dir, 'pages/external.html'), '<p>{{ format(7) }}</p>')
    const provider = readFileSync(join(dir, 'utils/format.ts'), 'utf8')
    await assert.rejects(() => runDelete('format', 'utils/format.ts', { cwd: dir }), /external Nuxt template/)
    assert.equal(readFileSync(join(dir, 'utils/format.ts'), 'utf8'), provider)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('refuses escaped TypeScript auto-import consumers', async () => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'consumer.ts'), 'export const label = for\\u006Dat(7)')
    await assert.rejects(() => runDelete('format', 'utils/format.ts', { cwd: dir, verify: false }), /auto-import/)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([
  '<template><p>Unused</p></template>',
  '<script setup>const format = value => value * 10; const label = format(7)</script><template>{{ label }}</template>',
  '<script setup lang="ts">defineProps<{ format: (value: number) => string }>()</script><template>{{ format(7) }}</template>',
  '<script setup>const rows = [1]</script><template><p v-for="format in rows">{{ format }}</p></template>',
  '<template><Widget v-slot="{ format }">{{ format(7) }}</Widget></template>',
])('deletes an unused Nuxt helper while preserving local bindings: %s', async (source) => {
  const dir = fixture()
  try {
    writeFileSync(join(dir, 'pages/index.vue'), source)
    writeFileSync(join(dir, 'utils/format.ts'), `${readFileSync(join(dir, 'utils/format.ts'), 'utf8')}\nexport const keep = 2\n`)
    const generated = readFileSync(join(dir, '.nuxt/imports.d.ts'), 'utf8')
    const result = await runDelete('format', 'utils/format.ts', { cwd: dir })
    assert.deepEqual(result.regressions, [])
    const exports = {}
    runInNewContext(ts.transpileModule(result.changes[0]!.after, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports })
    assert.deepEqual(exports, { keep: 2 })
    assert.equal(readFileSync(join(dir, 'pages/index.vue'), 'utf8'), source)
    assert.equal(readFileSync(join(dir, '.nuxt/imports.d.ts'), 'utf8'), generated)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
