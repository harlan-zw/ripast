import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { renameSync, symlinkSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { runRenameFile, writeChanges } from '../packages/core/src/index.ts'
import { makeFixture } from './helpers.ts'

it('rename-file updates explicit source extensions when module kind changes', async () => {
  const fx = makeFixture({
    'source.ts': 'export const value = 42\n',
    'consumer.ts': 'import { value } from \'./source.ts\'\nexport const result = value\n',
  })
  try {
    const result = await runRenameFile('source.ts', 'target.mts', { cwd: fx.dir, verify: false, vue: false })
    renameSync(result.fileMove.from, result.fileMove.to)
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `console.log((await import(${JSON.stringify(pathToFileURL(`${fx.dir}/consumer.ts`).href)})).result)`], { encoding: 'utf8' })
    assert.equal(output.trim(), '42')
  }
  finally { fx.cleanup() }
})

it('rename-file refuses symbolic link sources before moving them', async () => {
  const fx = makeFixture({ 'source.ts': 'export const value = 42\n' })
  try {
    symlinkSync('source.ts', `${fx.dir}/link.ts`)
    await assert.rejects(runRenameFile('link.ts', 'nested/link.ts', { cwd: fx.dir, verify: false, vue: false }), /symbolic link/)
  }
  finally { fx.cleanup() }
})
