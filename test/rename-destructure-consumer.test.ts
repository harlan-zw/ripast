import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { runRename } from '../packages/core/src/index.ts'
import { writeChanges } from '../packages/core/src/util.ts'
import { makeFixture } from './helpers.ts'

it.each([
  ['shorthand', '', 'const { useStore } = await import(\'./store.ts\')'],
  ['default binding', '', 'const { useStore = () => 9 } = await import(\'./store.ts\')'],
  ['mutable binding', '', 'let { useStore } = await import(\'./store.ts\'); useStore = useStore'],
  ['namespace binding through a re-export', 'import * as store from \'./barrel.ts\'\n', 'const { useStore } = store'],
])('rename preserves the local name and returned shape of a %s consumer', async (_, prefix, binding) => {
  const fx = makeFixture({
    'store.ts': 'export function useStore() { return 1 }\n',
    'barrel.ts': 'export { useStore } from \'./store.ts\'\n',
    'load.ts': `import { useStore } from './store.ts'\n${prefix}export function direct() { return useStore() }\nexport async function load() {\n  ${binding}\n  const alias: typeof useStore = useStore\n  const name: typeof useStore.name = useStore.name\n  const shadow = (useStore: () => number) => useStore()\n  return { useStore, value: useStore(), invoke: () => useStore(), alias, shadow, name, imported: (await import('./store.ts')).useStore() }\n}\nexport async function caller() {\n  const { useStore } = await load()\n  return useStore()\n}\n`,
  })
  try {
    const result = await runRename('useStore', 'useAppStore', { cwd: fx.dir, scope: 'store.ts', vue: false })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(`${fx.dir}/load.ts`).href)
    const store = await consumer.load()
    assert.equal(store.useStore(), 1)
    assert.equal(store.value, 1)
    assert.equal(store.invoke(), 1)
    assert.equal(store.alias(), 1)
    assert.equal(store.name, store.useStore.name)
    assert.equal(store.shadow(() => 2), 2)
    assert.equal(store.imported, 1)
    assert.equal(consumer.direct(), 1)
    assert.equal('useAppStore' in store, false)
    assert.equal(await consumer.caller(), 1)
  }
  finally { fx.cleanup() }
})
