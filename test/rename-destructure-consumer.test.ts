import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { runRename } from '../packages/core/src/index.ts'
import { writeChanges } from '../packages/core/src/util.ts'
import { makeFixture } from './helpers.ts'

it.each(['useStore', 'Store'])('rename updates external import type qualifiers beside a local %s binding', async (name) => {
  const fx = makeFixture({
    'store.ts': `export class ${name} {}\nexport namespace ${name} { export class Entry {} }\n`,
    'load.ts': `import * as store from './store.ts'\nconst { ${name} } = store\nexport type T = typeof import('./store.ts').${name}\nexport type U = import('./store.ts').${name}\nexport type V = typeof import('./store.ts').${name}.Entry\nexport type W = import('./store.ts').${name}.Entry\nconst alias: typeof ${name} = ${name}\nconst label: typeof ${name}.name = ${name}.name\nexport const load = () => ({ ${name}, alias, label })\n`,
  })
  try {
    const result = await runRename(name, 'AppStore', { cwd: fx.dir, scope: 'store.ts', vue: false })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(`${fx.dir}/load.ts`).href)
    const loaded = consumer.load()
    assert.equal(loaded[name], loaded.alias)
    assert.equal(loaded.label, 'AppStore')
    assert.equal('AppStore' in loaded, false)
  }
  finally { fx.cleanup() }
})

it.each([
  ['component', 'export function UseStore() { return null }', '<UseStore></UseStore>'],
  ['qualified component', 'export const UseStore = { View: () => null }', '<UseStore.View></UseStore.View>'],
])('rename preserves JSX references to a destructured %s binding', async (_, declaration, element) => {
  const fx = makeFixture({
    'store.ts': `${declaration}\n`,
    'view.tsx': `export async function render() {\n  const { UseStore } = await import('./store.ts')\n  return ${element}\n}\n`,
  })
  try {
    const result = await runRename('UseStore', 'UseAppStore', { cwd: fx.dir, scope: 'store.ts', vue: false })
    assert.deepEqual(result.regressions, [])
  }
  finally { fx.cleanup() }
})

it('rename changes source re-exports and preserves local export aliases beside a consumer binding', async () => {
  const fx = makeFixture({
    'store.ts': 'export function useStore() { return 1 }\n',
    'load.ts': `import * as store from './store.ts'\nconst { useStore } = store\nexport { useStore } from './store.ts'\nexport { useStore as localStore }\nexport const invoke = () => useStore()\n`,
  })
  try {
    const result = await runRename('useStore', 'useAppStore', { cwd: fx.dir, scope: 'store.ts', vue: false })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(`${fx.dir}/load.ts`).href)
    assert.equal(consumer.useAppStore(), 1)
    assert.equal(consumer.localStore(), 1)
    assert.equal(consumer.invoke(), 1)
  }
  finally { fx.cleanup() }
})

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
