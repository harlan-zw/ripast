import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { makeFixture } from './helpers.ts'

describe('doctor exit status', () => {
  it.each(['auto', 'agent', 'full', 'json'])('reports findings consistently with %s output', (profile) => {
    const fx = makeFixture({
      'target.ts': 'export const present = 1',
      'consumer.ts': 'import { missing } from "./target"\nconsole.log(missing)',
    })
    try {
      const result = spawnSync(process.execPath, [
        '--experimental-strip-types',
        '--no-warnings',
        resolve('packages/cli/src/cli.ts'),
        'doctor',
        '--checks',
        'stale-import',
        ...(profile === 'json' ? ['--json'] : ['--profile', profile]),
      ], { cwd: fx.dir, encoding: 'utf8', env: { ...process.env, CODEX_THREAD_ID: 'doctor-profile-test' } })
      expect(result.error).toBeUndefined()
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('missing')
      expect(result.status).toBe(1)
      if (profile === 'auto' || profile === 'agent')
        expect(result.stdout).toMatch(/^# profile: agent/)
      if (profile === 'json')
        expect(JSON.parse(result.stdout).results[0].check).toBe('stale-import')
    }
    finally { fx.cleanup() }
  })

  it.each(['auto', 'agent', 'full', 'json'])('succeeds without findings with %s output', (profile) => {
    const fx = makeFixture({
      'target.ts': 'export const present = 1',
      'consumer.ts': 'import { present } from "./target"\nconsole.log(present)',
    })
    try {
      const result = spawnSync(process.execPath, [
        '--experimental-strip-types',
        '--no-warnings',
        resolve('packages/cli/src/cli.ts'),
        'doctor',
        '--checks',
        'stale-import',
        ...(profile === 'json' ? ['--json'] : ['--profile', profile]),
      ], { cwd: fx.dir, encoding: 'utf8', env: { ...process.env, CODEX_THREAD_ID: 'doctor-profile-test' } })
      expect(result.error).toBeUndefined()
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      if (profile === 'auto' || profile === 'agent')
        expect(result.stdout).toMatch(/^# profile: agent/)
      if (profile === 'json')
        expect(JSON.parse(result.stdout).results).toEqual([])
    }
    finally { fx.cleanup() }
  })
})
