import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { runRename } from '../packages/core/src/index.ts'
import { writeChanges } from '../packages/core/src/util.ts'
import { makeFixture } from './helpers.ts'

it.each([
  ['later declaration', 'var { useStore } = store; var useStore = () => 2', 2],
  ['earlier declaration', 'var useStore = () => 2; var { useStore } = store', 1],
  ['default binding', 'var { useStore = () => 9 } = store; var useStore = () => 2', 2],
  ['block declaration', 'var { useStore } = store; if (true) { var useStore = () => 2 }', 2],
  ['later assignment', 'var { useStore } = store; var useStore; useStore = () => 2', 2],
  ['alias declaration', 'var { useStore } = store; var { replacement: useStore } = { replacement: () => 2 }', 2],
  ['parameter declaration', 'var { useStore } = store; var useStore = () => 2', 2, 'useStore = () => 9'],
])('rename preserves a consumer binding shared with a %s', async (_, declaration, expected, parameter = '') => {
  const fx = makeFixture({
    'store.ts': 'export function useStore() { return 1 }\n',
    'load.ts': `import * as store from './store.ts'
export function load(${parameter}) {
  ${declaration}
  const shadow = (useStore: () => number) => useStore()
  return { useStore, invoke: () => useStore(), shadow }
}
`,
  })
  try {
    const result = await runRename('useStore', 'useAppStore', { cwd: fx.dir, scope: 'store.ts', vue: false })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(`${fx.dir}/load.ts`).href)
    const loaded = consumer.load()
    assert.equal(loaded.useStore(), expected)
    assert.equal(loaded.invoke(), expected)
    assert.equal(loaded.shadow(() => 7), 7)
  }
  finally { fx.cleanup() }
})

it('rename still renames an intentionally selected repeated local binding', async () => {
  const fx = makeFixture({
    'load.ts': `export function load() {
  var { useStore } = { useStore: () => 1 }
  var useStore = () => 2
  return { useStore, invoke: () => useStore() }
}
`,
  })
  try {
    const result = await runRename('useStore', 'useAppStore', { cwd: fx.dir, scope: 'load.ts', allowMultiple: true, vue: false })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const consumer = await import(pathToFileURL(`${fx.dir}/load.ts`).href)
    const loaded = consumer.load()
    assert.equal(loaded.useAppStore(), 2)
    assert.equal(loaded.invoke(), 2)
  }
  finally { fx.cleanup() }
})
