import { expect, it } from 'vitest'
import { createCliEngine } from '../packages/cli/src/engine.ts'
import { makeFixture } from './helpers.ts'

const imports = { importModule: async () => {
  throw new Error('Broken installed Vue adapter')
} }

it.each(['rename', 'move', 'rename-file'])('allows pure TypeScript %s when an unrelated installed Vue adapter is broken', async (operation) => {
  const fx = makeFixture({
    'source.ts': 'export const target = 1',
    'consumer.ts': 'import { target } from \'./source\'\nconsole.log(target)',
  })
  try {
    const options = { cwd: fx.dir, verifyMode: 'none' as const }
    const engine = await createCliEngine(fx.dir, true, imports)
    const result = operation === 'rename'
      ? await engine.rename('target', 'next', options)
      : operation === 'move'
        ? await engine.move('target', 'source.ts', 'destination.ts', options)
        : await engine.renameFile('source.ts', 'destination.ts', options)
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
    ...(kind === 'nuxt' ? { 'package.json': '{"dependencies":{"nuxt":"*"}}', 'nuxt.config.ts': 'export default {}' } : { 'Unchanged.vue': '<template>{{ 1 }}</template>' }),
  })
  try {
    await expect(createCliEngine(fx.dir, true, imports)).rejects.toThrow('Broken installed Vue adapter')
  }
  finally {
    fx.cleanup()
  }
})
