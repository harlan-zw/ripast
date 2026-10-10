import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { runRename } from '../packages/core/src/index.ts'
import { writeChanges } from '../packages/core/src/util.ts'
import { makeFixture } from './helpers.ts'

it.each([
  ['inline object', 'var { Store } = { Store: class Replacement { value = 9 } }'],
  ['named object', 'const replacement = { Store: class Replacement { value = 9 } }; var { Store } = replacement'],
  ['another module', 'var { Store } = other'],
  ['default binding', 'var { Store = class Fallback { value = 11 } } = { Store: class Replacement { value = 9 } }'],
  ['earlier object', 'var { Store } = store', 7, 'var { Store } = { Store: class Replacement { value = 9 } }'],
  ['re-exported module', 'var { Store } = barrel', 7],
  ['assignment pattern', '({ Store } = { Store: class Replacement { value = 9 } })'],
  ['for loop', 'for (var { Store } of [{ Store: class Replacement { value = 9 } }]) {}'],
  ['explicit alias', 'var { Store: Store } = { Store: class Replacement { value = 9 } }'],
])('rename preserves source keys for a shared binding with an %s', async (_, replacement, expected = 9, initial = 'var { Store } = store') => {
  const fx = makeFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' },
      include: ['**/*.js'],
    }),
    'store.js': 'export class Store { value = 7 }\n',
    'other.js': 'export class Store { value = 9 }\n',
    'barrel.js': 'export { Store } from \'./store.js\'\n',
    'load.js': `import * as store from './store.js'
import * as other from './other.js'
import * as barrel from './barrel.js'
export function load() {
  ${initial};
  ${replacement}
  /** @type {typeof Store} */
  const Alias = Store
  return { Store, Alias, value: new Store().value, imported: new store.Store().value }
}
`,
  })
  try {
    const result = await runRename('Store', 'AppStore', { cwd: fx.dir, scope: 'store.js' })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(`${fx.dir}/load.js`).href)
    const loaded = consumer.load()
    assert.equal(loaded.value, expected)
    assert.equal(loaded.imported, 7)
    assert.equal(loaded.Store, loaded.Alias)
  }
  finally { fx.cleanup() }
})

it.each([
  ['default export', 'export default class Store { value = 7 }', 'export { default as Store } from \'./store.js\''],
  ['named export', 'export class Store { value = 7 }', 'import { Store as Original } from \'./store.js\'; export { Original as Store }'],
  ['explicit export', 'export class Store { value = 7 }', 'export { Store as Store } from \'./store.js\'', 'AppStore'],
  ['explicit import', 'export class Store { value = 7 }', 'import { Store as Store } from \'./store.js\'; export { Store }', 'AppStore'],
])('rename respects the public name of a %s alias', async (_, declaration, barrel, publicName = 'Store') => {
  const fx = makeFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { allowJs: true, checkJs: true, noEmit: true, target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler' },
      include: ['**/*.js'],
    }),
    'store.js': `${declaration}\n`,
    'barrel.js': `${barrel}\n`,
    'load.js': 'import * as barrel from \'./barrel.js\'; const { Store } = barrel; export const load = () => new Store().value\n',
  })
  try {
    const result = await runRename('Store', 'AppStore', { cwd: fx.dir, scope: 'store.js' })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(`${fx.dir}/load.js`).href)
    assert.equal(consumer.load(), 7)
    const exported = await import(pathToFileURL(`${fx.dir}/barrel.js`).href)
    assert.equal(new exported[publicName]().value, 7)
  }
  finally { fx.cleanup() }
})
