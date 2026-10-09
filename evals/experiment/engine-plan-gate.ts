import type { Engine } from 'ripide-api'
import type { PlanGate } from './grading.ts'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkChangedVerifiedPlan } from './grading.ts'

/** Measures issued-plan fingerprint protection, not whole-project freshness. */
export async function checkEnginePlanCapability(engine: Engine | null): Promise<PlanGate> {
  if (!engine)
    return checkChangedVerifiedPlan(null)
  const cwd = mkdtempSync(join(tmpdir(), 'ripide-plan-gate-'))
  const files = {
    'api.ts': 'export const old = 1\n',
    'consumer.ts': 'import { old } from \'./api\'\nexport const result = old\n',
  }
  const reset = () => Object.entries(files).forEach(([name, source]) => writeFileSync(join(cwd, name), source))
  const snapshot = () => JSON.stringify(Object.keys(files).map(name => [name, readFileSync(join(cwd, name)).toString('base64')]))
  try {
    writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true }, include: ['*.ts'] }))
    reset()
    const plan = () => engine.rename('old', 'next', { cwd, verifyMode: 'project' })
    const control = await plan()
    if (control.verification._tag !== 'Checked' || !control.changes.length || control.regressions.length)
      return { _tag: 'Failed', reason: 'The control plan did not complete verification without regressions.' }
    engine.commit(control)
    if (Object.entries(files).some(([name, source]) => readFileSync(join(cwd, name), 'utf8') !== source.replaceAll('old', 'next')))
      return { _tag: 'Failed', reason: 'The unchanged verified plan did not commit its proposed source.' }
    reset()
    return await checkChangedVerifiedPlan({
      plan,
      tamper(plan) {
        plan.changes[0]!.after += 'export const injected = true\n'
        return plan
      },
      commit(plan) {
        return Promise.resolve().then(() => {
          engine.commit(plan)
          return { _tag: 'Committed' as const }
        }).catch((error: unknown) => {
          if (error instanceof Error && error.message === 'Plan changed after verification; changes were refused')
            return { _tag: 'ValidationRefused' as const, reason: error.message }
          throw error
        })
      },
      snapshot,
    })
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}
