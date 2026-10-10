import type { DoctorAdapter } from '../packages/core/src/adapter.ts'
import { expect, it } from 'vitest'
import { createEngine, getDoctorCheckNames, runDoctor } from '../packages/core/src/index.ts'
import { createVueExtension } from '../packages/vue/src/index.ts'
import { makeFixture } from './helpers.ts'

function services(doctor: unknown) {
  const vue = createVueExtension()
  return createEngine({ extensions: [{ ...vue, semantic: { ...vue.semantic!, doctor: doctor as DoctorAdapter } }] }).services
}

it.each([
  {},
  null,
  'old adapter',
  { checks: 'phantom-component' },
  { checks: ['valid', 42] },
  { checks: [''] },
  { checks: [' bad-name '] },
])('rejects malformed doctor registrations with an adapter migration error: %j', async (doctor) => {
  const engine = services(doctor)
  await expect(runDoctor({ cwd: '/missing-doctor-fixture', engine })).rejects.toThrow(/ripide-vue.*doctor\.checks.*array.*check names/)
  await expect(getDoctorCheckNames({ engine })).rejects.toThrow(/ripide-vue.*doctor\.checks/)
})

it.each(['entryFiles', 'extraFindings', 'filterFinding'])('rejects a malformed doctor.%s callback', async (field) => {
  const engine = services({ checks: [], [field]: true })
  await expect(runDoctor({ cwd: '/missing-doctor-fixture', engine })).rejects.toThrow(new RegExp(`ripide-vue.*doctor\\.${field}.*function`))
})

it('propagates a failed framework check instead of returning a clean partial report', async () => {
  const failure = new Error('Framework manifest cannot be read')
  const engine = services({
    checks: ['framework-check'],
    extraFindings: () => { throw failure },
  })
  const fixture = makeFixture({ 'source.ts': 'export const value = 1' })
  try {
    await expect(runDoctor({ cwd: fixture.dir, engine, checks: ['framework-check'] })).rejects.toBe(failure)
  }
  finally {
    fixture.cleanup()
  }
})
