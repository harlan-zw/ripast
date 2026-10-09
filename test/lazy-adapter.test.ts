import { expect, it, vi } from 'vitest'
import { runMove, runRename, runRenameFile } from '../packages/core/src/index.ts'
import { makeFixture } from './helpers.ts'

vi.mock('../packages/core/src/adapter.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/core/src/adapter.ts')>()
  return { ...actual, loadAdapter: async () => {
    throw new Error('Broken installed Vue adapter')
  } }
})

it.each(['rename', 'move', 'rename-file'])('allows pure TypeScript %s when an unrelated installed Vue adapter is broken', async (operation) => {
  const fx = makeFixture({
    'source.ts': 'export const target = 1',
    'consumer.ts': 'import { target } from \'./source\'\nconsole.log(target)',
  })
  try {
    const options = { cwd: fx.dir, verify: false }
    const result = operation === 'rename'
      ? await runRename('target', 'next', options)
      : operation === 'move'
        ? await runMove('target', 'source.ts', 'destination.ts', options)
        : await runRenameFile('source.ts', 'destination.ts', options)
    expect(result.changes.some(change => change.rel === 'consumer.ts')).toBe(true)
    expect(result.regressions).toEqual([])
  }
  finally {
    fx.cleanup()
  }
})

it.each(['nuxt', 'vue-project'])('keeps required %s adapter failures visible', async (kind) => {
  const fx = makeFixture({
    'source.ts': 'export const target = 1',
    ...(kind === 'nuxt' ? { 'nuxt.config.ts': 'export default {}' } : { 'Unchanged.vue': '<template>{{ 1 }}</template>' }),
  })
  try {
    await expect(runRename('target', 'next', { cwd: fx.dir, verify: 'project' })).rejects.toThrow('Broken installed Vue adapter')
  }
  finally {
    fx.cleanup()
  }
})
