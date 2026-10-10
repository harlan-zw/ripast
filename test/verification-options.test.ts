import assert from 'node:assert/strict'
import { it } from 'vitest'
import { resolveVerificationOptions, resolveVerifyMode, runDelete, runMove, runRename, runRenameFile, runReplace } from '../packages/core/src/index.ts'

it.each([false, true, '', 'all', null, 0, {}])('rejects invalid verification mode %j', (value) => {
  assert.throws(() => resolveVerifyMode(value as never), /verifyMode.*none.*touched.*project/)
})

it.each([false, true, '', 'all', null, 0, {}])('rejects invalid default verification mode %j', (value) => {
  assert.throws(() => resolveVerifyMode(undefined, value as never), /verifyMode.*none.*touched.*project/)
  assert.throws(() => resolveVerificationOptions({}, value as never), /verifyMode.*none.*touched.*project/)
})

it.each(['none', 'touched', 'project'] as const)('resolves omitted verification options with %s defaults', (mode) => {
  assert.equal(resolveVerifyMode(undefined, mode), mode)
  assert.equal(resolveVerificationOptions({}, mode), mode)
})

const operations = [
  { name: 'rename', run: (opts: never) => runRename('a', 'b', opts) },
  { name: 'move', run: (opts: never) => runMove('a', 'a.ts', 'b.ts', opts) },
  { name: 'replace', run: (opts: never) => runReplace('a', 'b', opts) },
  { name: 'delete', run: (opts: never) => runDelete('a', 'a.ts', opts) },
  { name: 'rename-file', run: (opts: never) => runRenameFile('a.ts', 'b.ts', opts) },
]

it.each(operations)('$name rejects legacy options before filesystem work', async ({ run }) => {
  for (const verify of [undefined, false, true, 'none']) {
    await assert.rejects(run({ cwd: '/missing-verification-fixture', verify } as never), /verify.*removed.*verifyMode/)
  }
})

it.each(operations)('$name rejects invalid modes before filesystem work', async ({ run }) => {
  await assert.rejects(run({ cwd: '/missing-verification-fixture', verifyMode: 'all' } as never), /verifyMode.*none.*touched.*project/)
})
