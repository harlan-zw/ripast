import { getDoctorCheckNames, runDoctor } from 'ripide-api'
import { expect, it } from 'vitest'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

it('runs only requested core checks in a Nuxt project', async () => {
  const fx = makeFixture({
    'nuxt.config.ts': 'export default {}',
    'app.vue': '<template><MissingWidget /></template>',
    'source.ts': 'export const value = 1',
  })
  try {
    const engine = vueServices()
    const all = await runDoctor({ cwd: fx.dir, engine, frameworks: ['nuxt'] })
    expect(all.findings.some(finding => finding.check === 'phantom-component')).toBe(true)
    const selected = await runDoctor({ cwd: fx.dir, engine, frameworks: ['nuxt'], checks: ['duplicate-export'] })
    expect(selected.findings).toEqual([])
    const frameworkOnly = await runDoctor({ cwd: fx.dir, engine, frameworks: ['nuxt'], checks: ['phantom-component'] })
    expect(frameworkOnly.findings.map(finding => finding.check)).toEqual(['phantom-component'])
    expect(await getDoctorCheckNames({ cwd: fx.dir, engine, frameworks: ['nuxt'] })).toContain('phantom-component')
    expect(await getDoctorCheckNames({ cwd: fx.dir, noAdapters: true })).not.toContain('phantom-component')
  }
  finally {
    fx.cleanup()
  }
})

it('rejects unknown check names before reporting a clean project', async () => {
  const fx = makeFixture({ 'source.ts': 'export const value = 1' })
  try {
    await expect(runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-improt'] })).rejects.toThrow(/Unknown doctor check.*stale-improt/)
  }
  finally {
    fx.cleanup()
  }
})

it('reports doctor phase costs without source payloads', async () => {
  const fx = makeFixture({ 'source.ts': 'export const confidentialSourceCanary = 1' })
  const events: { phase: string, ms: number }[] = []
  try {
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-import'], profile: event => events.push(event) })
    expect(report.findings).toEqual([])
    expect(events.map(event => event.phase)).toContain('doctor parse')
    expect(events.map(event => event.phase)).toContain('doctor index')
    expect(events.every(event => Number.isFinite(event.ms) && event.ms >= 0)).toBe(true)
    expect(JSON.stringify(events)).not.toContain('confidentialSourceCanary')
  }
  finally {
    fx.cleanup()
  }
})
