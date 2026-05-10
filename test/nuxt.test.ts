import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs'
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
  const dir = mkdtempSync(join(tmpdir(), 'ripast-nuxt-'))
  cpSync(fixtureRoot, dir, { recursive: true })
  return {
    dir,
    read: (rel: string) => readFileSync(join(dir, rel), 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function applyRenameFile(result: Awaited<ReturnType<typeof runRenameFile>>) {
  writeChanges(result.changes)
  mkdirSync(dirname(result.fileMove.to), { recursive: true })
  renameSync(result.fileMove.from, result.fileMove.to)
}

describe('nuxt auto-imports', () => {
  it('renames an auto-imported composable in script and template call sites', async () => {
    const fx = makeNuxtFixture()
    try {
      const generated = fx.read('.nuxt/imports.d.ts')
      const result = await runRename('useCounter', 'useTally', { cwd: fx.dir, verify: false })
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
      const result = await runRenameFile('components/MyButton.vue', 'components/PrimaryButton.vue', { cwd: fx.dir, verify: false })
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
      const result = await runMove('format', 'utils/format.ts', 'utils/string.ts', { cwd: fx.dir, verify: false })
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
      const result = await runMove('format', 'utils/format.ts', 'lib/format.ts', { cwd: fx.dir, verify: false })
      assert.ok(result.changes.every(change => !change.rel.startsWith('.nuxt/')), 'does not rewrite generated .nuxt files')
      writeChanges(result.changes)

      assert.match(fx.read('lib/format.ts'), /export function format/)
      assert.match(fx.read('pages/index.vue'), /import \{ format \} from '\.\.\/lib\/format'/)
      assert.match(fx.read('pages/index.vue'), /\{\{ format\(count\.value\) \}\}/)
      assert.equal(fx.read('.nuxt/imports.d.ts'), generated)
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
