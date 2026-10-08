import assert from 'node:assert/strict'
import { it } from 'vitest'
import { runDelete } from '../packages/core/src/index.ts'
import { makeFixture } from './helpers.ts'

it('delete refuses reflective dynamic imports of the declaration module', async () => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\n',
    'consumer.ts': 'export const result = Object.values(await import(\'./source.ts\'))[0]()\n',
  })
  try {
    await assert.rejects(runDelete('helper', 'source.ts', { cwd: fx.dir, verify: false }), /dynamic import.*consumer\.ts/)
  }
  finally { fx.cleanup() }
})

it('delete permits dynamic imports of unrelated modules', async () => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\nexport const other = 1\n',
    'other.ts': 'export const value = 3\n',
    'consumer.ts': 'export const result = Object.values(await import(\'./other.ts\'))[0]\n',
  })
  try {
    const result = await runDelete('helper', 'source.ts', { cwd: fx.dir, verify: false })
    assert.equal(result.changes.length, 1)
  }
  finally { fx.cleanup() }
})

it('delete refuses module type queries that include the declaration export', async () => {
  const fx = makeFixture({
    'source.ts': 'export function helper() { return 42 }\n',
    'consumer.ts': 'export type All = typeof import(\'./source.ts\')\n',
  })
  try {
    await assert.rejects(runDelete('helper', 'source.ts', { cwd: fx.dir, verify: false }), /dynamic import.*consumer\.ts/)
  }
  finally { fx.cleanup() }
})
