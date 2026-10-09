import { expect, it, vi } from 'vitest'
import { getDoctorCheckNames, runDoctor } from '../packages/core/src/index.ts'
import { makeFixture } from './helpers.ts'

const loaded = vi.hoisted(() => ({ doctor: undefined as unknown }))

vi.mock('../packages/core/src/adapter.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/core/src/adapter.ts')>()
  return { ...actual, loadAdapter: async () => ({ doctor: loaded.doctor }) }
})

it.each([
  {},
  null,
  'old adapter',
  { checks: 'phantom-component' },
  { checks: ['valid', 42] },
  { checks: [''] },
  { checks: [' bad-name '] },
])('rejects malformed doctor registrations with an adapter migration error: %j', async (doctor) => {
  loaded.doctor = doctor
  await expect(runDoctor({ cwd: '/missing-doctor-fixture', frameworks: ['nuxt'] })).rejects.toThrow(/ripide-vue.*doctor\.checks.*array.*check names/)
  await expect(getDoctorCheckNames({ frameworks: ['vue'] })).rejects.toThrow(/ripide-vue.*doctor\.checks/)
})

it.each(['entryFiles', 'extraFindings', 'filterFinding'])('rejects a malformed doctor.%s callback', async (field) => {
  loaded.doctor = { checks: [], [field]: true }
  await expect(runDoctor({ cwd: '/missing-doctor-fixture', frameworks: ['vue'] })).rejects.toThrow(new RegExp(`ripide-vue.*doctor\\.${field}.*function`))
})

it('propagates a failed framework check instead of returning a clean partial report', async () => {
  const failure = new Error('Framework manifest cannot be read')
  loaded.doctor = {
    checks: ['framework-check'],
    extraFindings: () => { throw failure },
  }
  const fixture = makeFixture({ 'source.ts': 'export const value = 1' })
  try {
    await expect(runDoctor({ cwd: fixture.dir, frameworks: ['vue'], checks: ['framework-check'] })).rejects.toBe(failure)
  }
  finally {
    fixture.cleanup()
  }
})
