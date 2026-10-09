import assert from 'node:assert/strict'
import { renameSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { it, vi } from 'vitest'
import { makeFixture } from './helpers.ts'

vi.mock('../packages/core/src/adapter.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/core/src/adapter.ts')>(),
  loadAdapter: async () => { throw new Error('Vue adapter must stay disabled') },
}))

const { runRenameFile } = await import('../packages/core/src/rename-file.ts')
const { writeChanges } = await import('../packages/core/src/util.ts')

it('renames TypeScript imports when the Vue adapter is explicitly disabled', async () => {
  const fx = makeFixture({
    'source.ts': 'export const value = 42\n',
    'consumer.ts': 'import { value } from "./source.ts"\nexport const result = value + 1\n',
  })
  try {
    const result = await runRenameFile('source.ts', 'renamed.ts', { cwd: fx.dir, verifyMode: 'none' as const })
    writeChanges(result.changes)
    renameSync(result.fileMove.from, result.fileMove.to)
    const consumer = await import(pathToFileURL(join(fx.dir, 'consumer.ts')).href)
    assert.equal(consumer.result, 43)
  }
  finally { fx.cleanup() }
})
