import type { Verification } from 'ripide-api'
import assert from 'node:assert/strict'
import { Writable } from 'node:stream'
import { it } from 'vitest'
import { compactVerification, formatRegressions, formatVerification, printDiffs, summarize } from '../packages/cli/src/presentation/index.ts'

it('writes a readable patch and summarizes changed lines', () => {
  const chunks: string[] = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString())
      callback()
    },
  })
  const changes = [{ path: '/project/a.ts', rel: 'a.ts', before: 'export const count = 1\n', after: 'export const count = 2\n' }]
  printDiffs(changes, stream)
  assert.match(chunks.join(''), /--- a.ts/)
  assert.match(chunks.join(''), /-export const count = 1\n\+export const count = 2/)
  assert.deepEqual(summarize(changes), { files: 1, linesAdded: 1, linesRemoved: 1 })
})

it('renders completed verification receipts without inventing a success', () => {
  assert.equal(formatVerification({ _tag: 'Skipped', reason: 'disabled' }), 'verification: skipped (disabled)')
  const receipt: Verification = { _tag: 'Checked', checks: [{ checker: 'typescript', scope: 'project', files: 3, newErrors: 1, ignoredErrors: 2 }] }
  assert.equal(formatVerification(receipt), 'typescript diagnostics: project, 3 files, 1 new errors, 2 ignored errors')
  assert.deepEqual(compactVerification(receipt), [['typescript', 'project', 3, 1, 2]])
})

it('renders diagnostics with project relative paths', () => {
  assert.equal(formatRegressions([{ file: '/project/src/a.ts', line: 2, col: 4, code: 2322, message: 'Type mismatch' }], '/project'), '1 new type diagnostic introduced:\n  src/a.ts:2:4 TS2322 Type mismatch')
})
