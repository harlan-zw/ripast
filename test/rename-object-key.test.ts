import assert from 'node:assert/strict'
import { it } from 'vitest'
import { runRename } from '../packages/core/src/index.ts'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

it.each([
  'await importOriginal<typeof import(\'@/store\')>()',
  '(await importOriginal()) as typeof import(\'@/store\')',
])('rename updates typed references beside an unrelated object key: %s', async (actual) => {
  const before = `declare const vi: { mock(path: string, factory: (importOriginal: <T>() => Promise<T>) => unknown): void }
vi.mock('@/store', async (importOriginal) => {
  const actual = ${actual}
  return { ...actual, useStore: Object.assign(() => actual.useStore(), actual.useStore) }
})

`
  const fx = makeFixture({
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, paths: { '@/*': ['./src/*'] } }, include: ['src'] }),
    'src/store.ts': 'export function useStore() { return 1 }\n',
    'src/mock.ts': before,
  })
  try {
    const result = await runRename('useStore', 'useAppStore', { ...{ cwd: fx.dir, scope: 'src/store.ts' }, engine: vueServices() })
    assert.equal(result.changes.find(change => change.rel === 'src/mock.ts')?.after, before.replaceAll('actual.useStore', 'actual.useAppStore'))
    assert.deepEqual(result.regressions, [])
  }
  finally { fx.cleanup() }
})

it('rename preserves properties and shadows that resolve to other declarations', async () => {
  const before = `import * as other from './other'
const plain = { useStore: () => 2 }
declare const load: <T>() => Promise<T>
async function mock() {
  const actual = await load<typeof import('./store')>()
  return { useStore: () => actual.useStore(), unrelated: other.useStore() + plain.useStore() }
}
function local() {
  const actual = { useStore: () => 3 }
  return actual.useStore()
}
`
  const fx = makeFixture({
    'store.ts': 'export function useStore() { return 1 }\n',
    'other.ts': 'export function useStore() { return 2 }\n',
    'mock.ts': before,
  })
  try {
    const result = await runRename('useStore', 'useAppStore', { ...{ cwd: fx.dir, scope: 'store.ts' }, engine: vueServices() })
    assert.equal(result.changes.find(change => change.rel === 'mock.ts')?.after, before.replace('actual.useStore()', 'actual.useAppStore()'))
    assert.equal(result.changes.some(change => change.rel === 'other.ts'), false)
    assert.deepEqual(result.regressions, [])
  }
  finally { fx.cleanup() }
})
