import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadAdapter, rgFiles } from 'ripide-api/adapter'
import { it } from 'vitest'

it('returns every discovered file when filenames exceed the process output buffer', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ripide-discovery-'))
  try {
    const expected: string[] = []
    for (let i = 0; i < 6000; i++) {
      const directory = join(cwd, `${i}`)
      mkdirSync(directory)
      const path = join(directory, `${'long'.repeat(48)}.ts`)
      writeFileSync(path, 'export const value = 1')
      expected.push(path)
    }
    assert.deepEqual(new Set(rgFiles('', { cwd, listAll: true })), new Set(expected))
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

it('preserves a broken adapter import cause instead of treating it as an absent package', async () => {
  const failure = new Error('Adapter dependency initialization failed')
  await assert.rejects(loadAdapter('vue', { importModule: async () => {
    throw failure
  } }), (error: unknown) => error instanceof Error && error.cause === failure)
})

it('surfaces a missing transitive adapter dependency', async () => {
  const failure = Object.assign(new Error('Cannot find package \'broken-dependency\' imported from ripide-vue'), { code: 'ERR_MODULE_NOT_FOUND' })
  await assert.rejects(loadAdapter('vue', { importModule: async () => {
    throw failure
  } }), (error: unknown) => error instanceof Error && error.cause === failure)
})

it('allows fallback only when the requested adapter package is absent', async () => {
  const attempted: string[] = []
  const adapter = await loadAdapter('vue', { importModule: async (specifier) => {
    attempted.push(specifier)
    throw Object.assign(new Error(`Cannot find package '${specifier}'`), { code: 'ERR_MODULE_NOT_FOUND' })
  } })
  assert.equal(adapter, null)
  assert.equal(attempted[0], 'ripide-vue')
  assert.equal(attempted.length, 2)
  assert.ok(attempted[1]?.endsWith('/vue/src/index.ts'))
})
