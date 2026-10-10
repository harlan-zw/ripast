import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { createEngine } from '../packages/core/src/index.ts'
import { makeFixture } from './helpers.ts'

it.each(['repair', 'remove', 'unchanged'] as const)('uses final-plan diagnostics after %s hook changes', async (mode) => {
  const before = 'export const shared = 1\nexport const next = 2\n'
  const fixture = makeFixture({ 'source.ts': before })
  const engine = createEngine({ extensions: [{
    name: 'hook',
    suffixes: ['.custom'],
    parse: ({ path, source }) => ({ _tag: 'Script', source, start: 0, filename: `${path}.ts` }),
    setup(hooks) {
      hooks.hook('plan:ready', ({ changes }) => {
        if (mode === 'repair') {
          for (const change of changes)
            change.after = change.after.replace('export const next = 2', 'export const previous = 2')
        }
        if (mode === 'remove')
          changes.splice(0)
      })
    },
  }] })
  try {
    const plan = await engine.rename('shared', 'next', { cwd: fixture.dir, verifyMode: 'project' })
    if (mode === 'unchanged') {
      assert.ok(plan.regressions.some(regression => regression.code === 2451))
      assert.throws(() => engine.commit(plan), /Verification failed/)
      assert.equal(fixture.read('source.ts'), before)
      return
    }
    assert.deepEqual(plan.regressions, [])
    assert.deepEqual(plan.verification, mode === 'remove'
      ? { _tag: 'Skipped', reason: 'no-changes' }
      : { _tag: 'Checked', checks: [{ checker: 'typescript', scope: 'project', files: 1, newErrors: 0 }] })
    engine.commit(plan)
    assert.equal(readFileSync(join(fixture.dir, 'source.ts'), 'utf8'), mode === 'remove' ? before : 'export const next = 1\nexport const previous = 2\n')
  }
  finally { fixture.cleanup() }
})
