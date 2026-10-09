import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'vitest'
import { runMove } from '../packages/core/src/move.ts'
import { runRenameFile } from '../packages/core/src/rename-file.ts'
import { runRename } from '../packages/core/src/rename.ts'
import { scan } from '../packages/core/src/scan.ts'
import { writeChanges } from '../packages/core/src/util.ts'

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures/nuxt')

function makeNuxtFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ripide-nuxt-'))
  cpSync(fixtureRoot, dir, { recursive: true })
  return {
    dir,
    read: (rel: string) => readFileSync(join(dir, rel), 'utf8'),
    write: (rel: string, content: string) => {
      const abs = join(dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function applyRenameFile(result: Awaited<ReturnType<typeof runRenameFile>>) {
  writeChanges(result.changes)
  mkdirSync(dirname(result.fileMove.to), { recursive: true })
  renameSync(result.fileMove.from, result.fileMove.to)
  if (result.selfChange)
    writeFileSync(result.fileMove.to, result.selfChange.after)
}

describe('nuxt auto-imports', () => {
  it('renames an auto-imported composable in script and template call sites', async () => {
    const fx = makeNuxtFixture()
    try {
      const generated = fx.read('.nuxt/imports.d.ts')
      const result = await runRename('useCounter', 'useTally', { cwd: fx.dir, verifyMode: 'none' as const })
      assert.ok(result.changes.every(change => !change.rel.startsWith('.nuxt/')), 'does not rewrite generated .nuxt files')
      writeChanges(result.changes)

      assert.match(fx.read('composables/useCounter.ts'), /export function useTally/)
      assert.match(fx.read('pages/index.vue'), /const count = useTally\(\)/)
      assert.doesNotMatch(fx.read('pages/index.vue'), /useCounter/)
      assert.equal(fx.read('.nuxt/imports.d.ts'), generated)
    }
    finally { fx.cleanup() }
  })

  it('renames auto-imported component tags after a component file rename', async () => {
    const fx = makeNuxtFixture()
    try {
      const generated = fx.read('.nuxt/components.d.ts')
      const result = await runRenameFile('components/MyButton.vue', 'components/PrimaryButton.vue', { cwd: fx.dir, verifyMode: 'none' as const })
      assert.ok(result.changes.every(change => !change.rel.startsWith('.nuxt/')), 'does not rewrite generated .nuxt files')
      applyRenameFile(result)

      assert.ok(existsSync(join(fx.dir, 'components/PrimaryButton.vue')))
      const page = fx.read('pages/index.vue')
      assert.match(page, /<PrimaryButton :label="label" \/>/)
      assert.match(page, /<primary-button>\{\{ format\(count\.value\) \}\}<\/primary-button>/)
      assert.doesNotMatch(page, /MyButton|my-button/)
      assert.equal(fx.read('.nuxt/components.d.ts'), generated)
    }
    finally { fx.cleanup() }
  })

  it('moves an auto-imported util within Nuxt auto-import scope without touching consumers', async () => {
    const fx = makeNuxtFixture()
    try {
      const result = await runMove('format', 'utils/format.ts', 'utils/string.ts', { cwd: fx.dir, verifyMode: 'none' as const })
      writeChanges(result.changes)

      assert.match(fx.read('utils/string.ts'), /export function format/)
      assert.match(fx.read('pages/index.vue'), /const label = format\(count\.value\)/)
      assert.doesNotMatch(fx.read('pages/index.vue'), /import \{ format \}/)
    }
    finally { fx.cleanup() }
  })

  it('adds explicit imports when moving an auto-imported util out of Nuxt scope', async () => {
    const fx = makeNuxtFixture()
    try {
      const generated = fx.read('.nuxt/imports.d.ts')
      const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { cwd: fx.dir, verifyMode: 'none' as const })
      assert.ok(result.changes.every(change => !change.rel.startsWith('.nuxt/')), 'does not rewrite generated .nuxt files')
      writeChanges(result.changes)

      assert.match(fx.read('lib/format.ts'), /export function format/)
      assert.match(fx.read('pages/index.vue'), /import \{ format \} from '\.\.\/lib\/format'/)
      assert.match(fx.read('pages/index.vue'), /\{\{ format\(count\.value\) \}\}/)
      assert.equal(fx.read('.nuxt/imports.d.ts'), generated)
    }
    finally { fx.cleanup() }
  })

  it('adds explicit imports to TS consumers when moving an auto-imported util out of scope', async () => {
    const fx = makeNuxtFixture()
    try {
      fx.write('plugins/consumer.ts', 'export const pluginLabel = format(7)\n')
      const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { cwd: fx.dir, verifyMode: 'none' as const })
      writeChanges(result.changes)

      assert.match(fx.read('plugins/consumer.ts'), /import \{ format \} from '\.\.\/lib\/format'/)
      assert.match(fx.read('plugins/consumer.ts'), /export const pluginLabel = format\(7\)/)
    }
    finally { fx.cleanup() }
  })

  it('merges explicit imports into an existing target-module import', async () => {
    const fx = makeNuxtFixture()
    try {
      fx.write('lib/format.ts', 'export const existing = 1\n')
      fx.write('pages/merge.vue', `<script setup lang="ts">\nimport { existing } from '../lib/format'\nconst label = format(existing)\n</script>\n<template>{{ label }}</template>\n`)
      const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { cwd: fx.dir, verifyMode: 'none' as const })
      writeChanges(result.changes)

      const page = fx.read('pages/merge.vue')
      assert.match(page, /import \{ existing, format \} from '\.\.\/lib\/format'/)
      assert.equal((page.match(/from '\.\.\/lib\/format'/g) ?? []).length, 1)
    }
    finally { fx.cleanup() }
  })

  it('refuses move-out-of-scope when a Vue auto-import consumer has no script block', async () => {
    const fx = makeNuxtFixture()
    try {
      fx.write('pages/template-only.vue', `<template><p>{{ format(1) }}</p></template>\n`)
      await assert.rejects(
        () => runMove('format', 'utils/format.ts', 'lib/format.ts', { cwd: fx.dir, verifyMode: 'none' as const }),
        /ripide move: "format" is auto-imported in Nuxt; moving to .*lib\/format\.ts removes it from auto-import scope/,
      )
    }
    finally { fx.cleanup() }
  })

  it('treats configured Nuxt import dirs as auto-import scope', async () => {
    const fx = makeNuxtFixture()
    try {
      fx.write('nuxt.config.ts', `export default defineNuxtConfig({\n  imports: { dirs: ['custom'] },\n})\n`)
      fx.write('custom/formatCustom.ts', 'export function customFormat(value: number) { return value + 1 }\n')
      fx.write('pages/custom.vue', `<script setup lang="ts">\nconst value = customFormat(1)\n</script>\n<template>{{ value }}</template>\n`)
      const result = await runMove('customFormat', 'custom/formatCustom.ts', 'custom/string.ts', { cwd: fx.dir, verifyMode: 'none' as const })
      writeChanges(result.changes)

      assert.match(fx.read('custom/string.ts'), /export function customFormat/)
      assert.doesNotMatch(fx.read('pages/custom.vue'), /import \{ customFormat \}/)
      assert.match(fx.read('pages/custom.vue'), /const value = customFormat\(1\)/)
    }
    finally { fx.cleanup() }
  })

  it('does not rename shadowed Nuxt fallback identifiers in script or template', async () => {
    const fx = makeNuxtFixture()
    try {
      fx.write('pages/shadow.vue', `<script setup lang="ts">\nconst useCounter = () => 'local'\nconst local = useCounter()\n</script>\n<template><p>{{ useCounter() }} {{ local }}</p></template>\n`)
      const result = await runRename('useCounter', 'useTally', { cwd: fx.dir, verifyMode: 'none' as const })
      writeChanges(result.changes)

      const page = fx.read('pages/shadow.vue')
      assert.match(page, /const useCounter = \(\) => 'local'/)
      assert.match(page, /const local = useCounter\(\)/)
      assert.match(page, /\{\{ useCounter\(\) \}\}/)
      assert.doesNotMatch(page, /useTally/)
    }
    finally { fx.cleanup() }
  })

  it('renames kebab-only auto-imported component tags after a component file rename', async () => {
    const fx = makeNuxtFixture()
    try {
      fx.write('pages/kebab.vue', `<template><my-button label="kebab"></my-button></template>\n`)
      const result = await runRenameFile('components/MyButton.vue', 'components/PrimaryButton.vue', { cwd: fx.dir, verifyMode: 'none' as const })
      applyRenameFile(result)

      assert.match(fx.read('pages/kebab.vue'), /<primary-button label="kebab"><\/primary-button>/)
      assert.doesNotMatch(fx.read('pages/kebab.vue'), /my-button/)
    }
    finally { fx.cleanup() }
  })

  it('prefers a tsconfig path alias for util explicit imports across layers', async () => {
    const fx = makeNuxtFixture()
    try {
      fx.write('.nuxt/tsconfig.json', JSON.stringify({
        compilerOptions: {
          baseUrl: '..',
          paths: { '#lib/*': ['lib/*'] },
        },
      }))
      const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { cwd: fx.dir, verifyMode: 'none' as const })
      writeChanges(result.changes)
      assert.match(fx.read('pages/index.vue'), /import \{ format \} from '#lib\/format'/)
    }
    finally { fx.cleanup() }
  })

  it('warns when renaming a component that is referenced via resolveComponent() string', async () => {
    const fx = makeNuxtFixture()
    try {
      fx.write('pages/dynamic.vue', `<script setup lang="ts">\nconst Comp = resolveComponent('MyButton')\n</script>\n<template><component :is="Comp" /></template>\n`)
      const result = await runRenameFile('components/MyButton.vue', 'components/PrimaryButton.vue', { cwd: fx.dir, verifyMode: 'none' as const })
      assert.ok(result.warnings.some(w => /resolveComponent\(\) in 1 file/.test(w) && /pages\/dynamic\.vue/.test(w)))
      applyRenameFile(result)
      assert.match(fx.read('pages/dynamic.vue'), /resolveComponent\('PrimaryButton'\)/)
    }
    finally { fx.cleanup() }
  })

  it('adds explicit imports to vue consumers when moving a component out of auto-import scope', async () => {
    const fx = makeNuxtFixture()
    try {
      const result = await runRenameFile('components/MyButton.vue', 'lib/MyButton.vue', { cwd: fx.dir, verifyMode: 'none' as const })
      applyRenameFile(result)
      const page = fx.read('pages/index.vue')
      assert.match(page, /import MyButton from '\.\.\/lib\/MyButton\.vue'/)
      assert.match(page, /<MyButton :label="label" \/>/)
    }
    finally { fx.cleanup() }
  })

  it('prefers a tsconfig path alias over a relative specifier for cross-layer component imports', async () => {
    const fx = makeNuxtFixture()
    try {
      fx.write('.nuxt/tsconfig.json', JSON.stringify({
        compilerOptions: {
          baseUrl: '..',
          paths: { '#lib/*': ['lib/*'] },
        },
      }))
      const result = await runRenameFile('components/MyButton.vue', 'lib/MyButton.vue', { cwd: fx.dir, verifyMode: 'none' as const })
      applyRenameFile(result)
      assert.match(fx.read('pages/index.vue'), /import MyButton from '#lib\/MyButton\.vue'/)
    }
    finally { fx.cleanup() }
  })

  it('adds explicit imports for sibling exports when moving an auto-imported composable file out of scope', async () => {
    const fx = makeNuxtFixture()
    try {
      fx.write('composables/useCounter.ts', `import { ref } from 'vue'\n\nexport function useCounter() {\n  return ref(useCounterStart())\n}\n\nexport function useCounterStart() {\n  return 1\n}\n`)
      fx.write('.nuxt/imports.d.ts', `${fx.read('.nuxt/imports.d.ts')}\ndeclare global { const useCounterStart: typeof import('../composables/useCounter')['useCounterStart'] }\n`)
      fx.write('pages/sibling.vue', `<script setup lang="ts">\nconst counter = useCounter()\nconst start = useCounterStart()\n</script>\n<template>{{ counter }} {{ start }}</template>\n`)
      const result = await runRenameFile('composables/useCounter.ts', 'internal/composables/useCounter.ts', { cwd: fx.dir, verifyMode: 'none' as const })
      applyRenameFile(result)

      const page = fx.read('pages/sibling.vue')
      assert.match(page, /import \{[^}]*\buseCounter\b[^}]*\} from '\.\.\/internal\/composables\/useCounter'/, 'useCounter explicit import added')
      assert.match(page, /import \{[^}]*\buseCounterStart\b[^}]*\} from '\.\.\/internal\/composables\/useCounter'/, 'sibling export explicit import added')
      assert.equal((page.match(/from '\.\.\/internal\/composables\/useCounter'/g) ?? []).length, 1, 'imports merged into one line')
    }
    finally { fx.cleanup() }
  })

  it('rewrites a moved composable\'s own relative imports when depth changes', async () => {
    const fx = makeNuxtFixture()
    try {
      fx.write('shared/constant.ts', 'export const ONE = 1\n')
      fx.write('composables/useThing.ts', `import { ONE } from '../shared/constant'\nexport function useThing() { return ONE }\n`)
      fx.write('.nuxt/imports.d.ts', `${fx.read('.nuxt/imports.d.ts')}\ndeclare global { const useThing: typeof import('../composables/useThing')['useThing'] }\n`)
      fx.write('pages/thing.vue', `<script setup lang="ts">\nconst v = useThing()\n</script>\n<template>{{ v }}</template>\n`)
      const result = await runRenameFile('composables/useThing.ts', 'internal/composables/useThing.ts', { cwd: fx.dir, verifyMode: 'none' as const })
      applyRenameFile(result)

      assert.match(fx.read('internal/composables/useThing.ts'), /from '\.\.\/\.\.\/shared\/constant/, 'moved file\'s own relative import updated for new depth')
    }
    finally { fx.cleanup() }
  })

  it('scans auto-imported Nuxt usages in pages', () => {
    const fx = makeNuxtFixture()
    try {
      const hits = scan('format', { cwd: fx.dir, kinds: ['identifier-reference'] })
      assert.ok(hits.some(hit => hit.file === 'pages/index.vue' && hit.snippet.includes('format(count.value)')))
    }
    finally { fx.cleanup() }
  })
})
