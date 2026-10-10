import assert from 'node:assert/strict'
import { it } from 'vitest'
import { discoverCliAdapters } from '../packages/cli/src/engine.ts'
import { makeFixture } from './helpers.ts'

const cases: { name: string, files: Record<string, string>, enabled?: boolean, expected: { authoredVue: boolean, adapters: string[] } }[] = [
  { name: 'authored Vue without dependency markers', files: { 'View.vue': '<template><div /></template>' }, expected: { authoredVue: true, adapters: ['vue'] } },
  { name: 'Nuxt dependency without authored Vue', files: { 'package.json': '{"dependencies":{"nuxt":"*"}}' }, expected: { authoredVue: false, adapters: ['vue'] } },
  { name: 'Vue peer dependency', files: { 'package.json': '{"peerDependencies":{"vue":"*"}}' }, expected: { authoredVue: false, adapters: ['vue'] } },
  { name: 'ignored and dependency Vue files', files: { '.ignore': 'ignored/\n', 'ignored/View.vue': '<template />', 'node_modules/example/View.vue': '<template />' }, expected: { authoredVue: false, adapters: [] } },
  { name: 'disabled Vue with authored source', files: { 'View.vue': '<template />', 'package.json': '{"dependencies":{"vue":"*"}}' }, enabled: false, expected: { authoredVue: true, adapters: [] } },
  { name: 'pure TypeScript', files: { 'source.ts': 'export const target = 1' }, expected: { authoredVue: false, adapters: [] } },
]

it.each(cases)('discovers CLI adapter requirements for $name', ({ files, enabled, expected }) => {
  const fx = makeFixture(files)
  try {
    assert.deepEqual(discoverCliAdapters(fx.dir, enabled), expected)
  }
  finally { fx.cleanup() }
})
