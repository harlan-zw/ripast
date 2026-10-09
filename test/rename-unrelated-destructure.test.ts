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
    const result = await runRename('Store', 'AppStore', { cwd: fx.dir, scope: 'store.js', vue: false })
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
