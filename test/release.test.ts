import { describe, expect, it } from 'vitest'
import { planRelease, publicationDecision } from '../scripts/release.ts'

const packages = ['@ripast/core', '@ripast/vue', '@ripast/cli'].map(name => ({ name, version: '0.5.0' }))

describe('release plan', () => {
  it('publishes matching package versions to latest', () => {
    expect(planRelease('v0.5.0', packages)).toEqual({ version: '0.5.0', npmTag: 'latest' })
  })

  it('keeps prereleases off latest', () => {
    expect(planRelease('v0.6.0-beta.1', packages.map(pkg => ({ ...pkg, version: '0.6.0-beta.1' }))).npmTag).toBe('beta')
  })

  it.each(['main', 'v0.5.0;echo injected', 'v00.5.0', 'v0.5.0-01'])('rejects an invalid release tag: %s', (tag) => {
    expect(() => planRelease(tag, packages)).toThrow('Pass a version tag')
  })

  it('rejects mixed package versions', () => {
    expect(() => planRelease('v0.5.0', [{ ...packages[0], version: '0.4.0' }, ...packages.slice(1)])).toThrow('must match')
  })

  it('rejects missing or duplicate packages', () => {
    expect(() => planRelease('v0.5.0', packages.slice(1))).toThrow('core, Vue, and CLI')
    expect(() => planRelease('v0.5.0', [packages[0], packages[0], packages[2]])).toThrow('core, Vue, and CLI')
  })
})

describe('publication retry', () => {
  it('publishes only a missing version', () => {
    expect(publicationDecision({ status: 1, stdout: '{"error":{"code":"E404"}}' }, 'sha512-local')).toBe('publish')
  })

  it('skips an already published identical artifact', () => {
    expect(publicationDecision({ status: 0, stdout: '"sha512-local"' }, 'sha512-local')).toBe('skip')
  })

  it('accepts the single-version array returned by npm 12', () => {
    expect(publicationDecision({ status: 0, stdout: '["sha512-local"]' }, 'sha512-local')).toBe('skip')
    expect(() => publicationDecision({ status: 0, stdout: '["sha512-local","sha512-other"]' }, 'sha512-local')).toThrow('different artifact')
  })

  it('rejects an existing version with different bytes', () => {
    expect(() => publicationDecision({ status: 0, stdout: '"sha512-other"' }, 'sha512-local')).toThrow('different artifact')
  })

  it('propagates registry outages and authentication failures', () => {
    expect(() => publicationDecision({ status: 1, stdout: '{"error":{"code":"E503"}}' }, 'sha512-local')).toThrow('Registry lookup failed')
    expect(() => publicationDecision({ status: 1, stdout: '{"error":{"code":"E401"}}' }, 'sha512-local')).toThrow('Registry lookup failed')
    expect(() => publicationDecision({ status: null, stdout: '' }, 'sha512-local')).toThrow('Registry lookup failed')
  })
})
