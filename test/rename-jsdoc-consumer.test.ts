import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { runRename } from '../packages/core/src/index.ts'
import { writeChanges } from '../packages/core/src/util.ts'
import { makeFixture } from './helpers.ts'

it.each([
  ['top-level', '', ''],
  ['function-local', 'export function load() {\n', '}\n'],
])('rename preserves %s consumer bindings in JSDoc and updates module types', async (_, prefix, suffix) => {
  const fx = makeFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' },
      include: ['**/*.js'],
    }),
    'store.js': 'export class Store { value = 7 }\n',
    'load.js': `import * as store from './store.js'\n${prefix}const { Store } = store\n/** @type {typeof Store} */\nconst Alias = Store\n/** @type {typeof Store.prototype.value} */\nconst value = 7\n/** @type {typeof import('./store.js').Store} */\nconst External = Store\n/** @type {import('./store.js').Store} */\nconst instance = new Store()\nconst shadow = () => {\n  class Store { value = 9 }\n  /** @type {typeof Store} */\n  const Shadow = Store\n  return new Shadow().value\n}\n${prefix ? 'return' : 'export const load = () =>'} ({ Store, Alias, External, instance, value, shadow: shadow() })\n${suffix}`,
  })
  try {
    const result = await runRename('Store', 'AppStore', { cwd: fx.dir, scope: 'store.js', vue: false })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(`${fx.dir}/load.js`).href)
    const loaded = consumer.load()
    assert.equal(loaded.Store, loaded.Alias)
    assert.equal(loaded.Store, loaded.External)
    assert.equal(loaded.instance.value, loaded.value)
    assert.equal(loaded.shadow, 9)
    assert.equal('AppStore' in loaded, false)
  }
  finally { fx.cleanup() }
})

it('rename preserves JSDoc references to a redeclared consumer binding', async () => {
  const fx = makeFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' },
      include: ['**/*.js'],
    }),
    'store.js': 'export function useStore() { return 1 }\n',
    'load.js': `import * as store from './store.js'\nexport function load() {\n  var { useStore } = store\n  var useStore = () => 2\n  /** @type {typeof useStore} */\n  const Alias = useStore\n  return { useStore, Alias, invoke: () => useStore() }\n}\n`,
  })
  try {
    const result = await runRename('useStore', 'useAppStore', { cwd: fx.dir, scope: 'store.js', vue: false })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(`${fx.dir}/load.js`).href)
    const loaded = consumer.load()
    assert.equal(loaded.useStore(), 2)
    assert.equal(loaded.Alias, loaded.useStore)
    assert.equal(loaded.invoke(), 2)
  }
  finally { fx.cleanup() }
})
