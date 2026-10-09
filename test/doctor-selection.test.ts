import { getDoctorCheckNames, runDoctor } from 'ripide-api'
import { expect, it } from 'vitest'
import { makeFixture } from './helpers.ts'

it('runs only requested core checks in a Nuxt project', async () => {
  const fx = makeFixture({
    'nuxt.config.ts': 'export default {}',
    'app.vue': '<template><MissingWidget /></template>',
    'source.ts': 'export const value = 1',
  })
  try {
    const all = await runDoctor({ cwd: fx.dir, frameworks: ['nuxt'] })
    expect(all.findings.some(finding => finding.check === 'phantom-component')).toBe(true)
    const selected = await runDoctor({ cwd: fx.dir, frameworks: ['nuxt'], checks: ['duplicate-export'] })
    expect(selected.findings).toEqual([])
    const frameworkOnly = await runDoctor({ cwd: fx.dir, frameworks: ['nuxt'], checks: ['phantom-component'] })
    expect(frameworkOnly.findings.map(finding => finding.check)).toEqual(['phantom-component'])
    expect(await getDoctorCheckNames({ cwd: fx.dir, frameworks: ['nuxt'] })).toContain('phantom-component')
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
