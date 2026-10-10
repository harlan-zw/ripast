import type { Extension } from '../packages/core/src/index.ts'
import assert from 'node:assert/strict'
import { cpSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { createEngine } from '../packages/core/src/index.ts'
import { createVueExtension } from '../packages/vue/src/index.ts'
import { makeFixture } from './helpers.ts'

it.each(['unchanged', 'newline', 'removed', 'undone', 'both'] as const)('verifies final Nuxt auto-import metadata for %s hooks', async (mode) => {
  const fx = makeFixture({}, false)
  cpSync(new URL('./fixtures/nuxt/', import.meta.url), fx.dir, { recursive: true })
  fx.write('pages/index.vue', '<script setup lang="ts">const label = format(1)</script><template>{{ format(2) }}</template>')
  fx.write('consumer.ts', 'export const label = format(3)\n')
  const generated = fx.read('.nuxt/imports.d.ts')
  const engine = createEngine({ extensions: [{ ...createVueExtension(), setup(hooks) {
    hooks.hook('plan:ready', ({ changes }) => {
      if (mode === 'removed')
        changes.splice(0)
      if (mode === 'newline')
        changes.find(change => change.rel === 'utils/format.ts')!.after += '\n'
      if (mode === 'undone') {
        for (const change of changes)
          change.after = `${change.before}\n`
      }
      if (mode === 'both') {
        for (const change of changes)
          change.after = change.rel === 'utils/format.ts' ? `${change.after}\n${change.before}` : `${change.before}\n`
      }
    })
  } }] })
  try {
    const result = await engine.rename('format', 'pretty', { cwd: fx.dir, scope: 'utils/format.ts', verifyMode: 'project' })
    assert.deepEqual(result.regressions, [])
    engine.commit(result)
    assert.equal(fx.read('.nuxt/imports.d.ts'), generated)
    if (mode === 'removed' || mode === 'undone' || mode === 'both') {
      assert.match(fx.read('consumer.ts'), /format\(3\)/)
      assert.match(fx.read('utils/format.ts'), /function format/)
    }
    else {
      assert.match(fx.read('consumer.ts'), /pretty\(3\)/)
      assert.match(fx.read('utils/format.ts'), /function pretty/)
    }
    if (mode === 'removed')
      assert.deepEqual(result.verification, { _tag: 'Skipped', reason: 'no-changes' })
  }
  finally { fx.cleanup() }
})

it.each([false, true])('preserves planner refusal when a native hook changes, modified=%s', async (modified) => {
  const fx = makeFixture({
    'source.ts': 'export const shared = 1\n',
    'view.custom': 'template references ./source#shared\n',
  })
  const refusal = { file: join(fx.dir, 'view.custom'), line: 1, col: 1, code: 9001, message: 'The template cannot rename this binding.' }
  const extension: Extension = {
    name: 'custom',
    suffixes: ['.custom'],
    operations: ['rename'],
    parse: ({ path }) => ({ _tag: 'Script', source: '', start: 0, filename: `${path}.ts` }),
    planRename: async () => ({ changes: [], regressions: [refusal], warnings: [], scanned: 1 }),
    setup(hooks) {
      if (modified)
        hooks.hook('plan:ready', ({ changes }) => { changes.find(change => change.rel === 'source.ts')!.after += '\n' })
    },
  }
  const engine = createEngine({ extensions: [extension] })
  try {
    const result = await engine.rename('shared', 'next', { cwd: fx.dir, verifyMode: 'touched' })
    assert.deepEqual(result.regressions, [refusal])
    assert.throws(() => engine.commit(result), /Verification failed/)
    assert.equal(fx.read('source.ts'), 'export const shared = 1\n')
    assert.equal(fx.read('view.custom'), 'template references ./source#shared\n')
  }
  finally { fx.cleanup() }
})

it('refuses authored metadata that conflicts with a verification-only projection', async () => {
  const fx = makeFixture({}, false)
  cpSync(new URL('./fixtures/nuxt/', import.meta.url), fx.dir, { recursive: true })
  fx.write('consumer.ts', 'export const label = format(3)\n')
  const generated = fx.read('.nuxt/imports.d.ts')
  const engine = createEngine({ extensions: [{ ...createVueExtension(), setup(hooks) {
    hooks.hook('plan:ready', ({ changes }) => {
      changes.push({ path: join(fx.dir, '.nuxt/imports.d.ts'), rel: '.nuxt/imports.d.ts', before: generated, after: 'declare global { const pretty: number } export {}' })
    })
  } }] })
  try {
    await assert.rejects(engine.rename('format', 'pretty', { cwd: fx.dir, scope: 'utils/format.ts', verifyMode: 'project' }), /Conflicting extension edits/)
    assert.equal(fx.read('.nuxt/imports.d.ts'), generated)
    assert.equal(fx.read('consumer.ts'), 'export const label = format(3)\n')
  }
  finally { fx.cleanup() }
})
