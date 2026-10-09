import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rgFiles } from 'ripide-api/adapter'
import { it } from 'vitest'
import { createCliEngine } from '../packages/cli/src/engine.ts'

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
  await assert.rejects(createCliEngine(process.cwd(), true, { importModule: async () => {
    throw failure
  } }), (error: unknown) => error === failure)
})

it('surfaces a missing transitive adapter dependency', async () => {
  const failure = Object.assign(new Error('Cannot find package \'broken-dependency\' imported from ripide-vue'), { code: 'ERR_MODULE_NOT_FOUND' })
  await assert.rejects(createCliEngine(process.cwd(), true, { importModule: async () => {
    throw failure
  } }), (error: unknown) => error === failure)
})

it('refuses a missing requested extension instead of omitting consumers', async () => {
  const attempted: string[] = []
  await assert.rejects(createCliEngine(process.cwd(), true, { importModule: async (specifier) => {
    attempted.push(specifier)
    throw Object.assign(new Error(`Cannot find package '${specifier}'`), { code: 'ERR_MODULE_NOT_FOUND' })
  } }), /Cannot find package/)
  assert.equal(attempted[0], 'ripide-vue')
  assert.equal(attempted.length, 1)
})
