import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { createEngine } from 'ripide-api'
import { expect, it } from 'vitest'
import { checkEnginePlanCapability } from '../evals/experiment/index.ts'

it('reports actual engine changed-plan protection instead of an unavailable SDK', () => {
  const result = spawnSync(process.execPath, [resolve('evals/experiment/capability-gate.ts')], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ _tag: 'Passed' })
})

it('preserves unavailable capabilities and actual infrastructure errors', async () => {
  expect(await checkEnginePlanCapability(null)).toMatchObject({ _tag: 'Unavailable' })
  const engine = createEngine()
  const failure = new Error('Native checker failed')
  let commits = 0
  await expect(checkEnginePlanCapability({ ...engine, commit(plan) {
    if (++commits === 2)
      throw failure
    engine.commit(plan)
  } })).rejects.toBe(failure)
})

it('fails when a refusal changes source bytes', async () => {
  const engine = createEngine()
  let commits = 0
  const result = await checkEnginePlanCapability({ ...engine, commit(plan) {
    if (++commits === 2) {
      writeFileSync(plan.changes[0]!.path, 'unexpected write\n')
      throw new Error('Plan changed after verification; changes were refused')
    }
    engine.commit(plan)
  } })
  expect(result).toEqual({ _tag: 'Failed', reason: 'The rejected plan changed source bytes.' })
})

it('fails when an engine accepts a changed plan', async () => {
  const engine = createEngine()
  let commits = 0
  const result = await checkEnginePlanCapability({ ...engine, commit(plan) {
    if (++commits === 1)
      engine.commit(plan)
  } })
  expect(result).toEqual({ _tag: 'Failed', reason: 'The SDK accepted a changed verified plan.' })
})

it('does not count a plan with new diagnostics as a successful verified control', async () => {
  const engine = createEngine({ extensions: [{
    name: 'regression',
    suffixes: ['.custom'],
    parse: ({ source, path }) => ({ _tag: 'Script', source, start: 0, filename: `${path}.ts` }),
    setup(hooks) {
      hooks.hook('plan:ready', ({ changes }) => {
        changes[0]!.after += 'const broken: string = 1\n'
      })
    },
  }] })
  expect(await checkEnginePlanCapability(engine)).toEqual({ _tag: 'Failed', reason: 'The control plan did not complete verification without regressions.' })
})
