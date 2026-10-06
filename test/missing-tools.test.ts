import assert from 'node:assert/strict'
import { it, vi } from 'vitest'
import { rgFiles, rgFilesMany } from '../packages/core/src/adapter.ts'
import vueAdapter from '../packages/vue/src/index.ts'
import { makeFixture } from './helpers.ts'

it.each([
  ['single-pattern search', (cwd: string) => rgFiles('target', { cwd })],
  ['file listing', (cwd: string) => rgFiles('', { cwd, listAll: true })],
  ['batch search', (cwd: string) => rgFilesMany(['target'], { cwd })],
  ['Vue adapter search', (cwd: string) => vueAdapter.hasFilesContaining!(cwd, 'target')],
] as const)('%s explains how to install missing ripgrep', (_name, run) => {
  const fx = makeFixture({}, false)
  vi.stubEnv('PATH', fx.dir)
  try {
    assert.throws(() => run(fx.dir), (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /ripgrep \(rg\).*PATH/)
      assert.match(error.message, /brew install ripgrep/)
      assert.match(error.message, /sudo apt-get install ripgrep/)
      assert.match(error.message, /winget install BurntSushi\.ripgrep\.MSVC/)
      assert.match(error.message, /rg --version/)
      return true
    })
  }
  finally {
    vi.unstubAllEnvs()
    fx.cleanup()
  }
})

it('empty batch search needs no ripgrep', () => {
  vi.stubEnv('PATH', '')
  try {
    assert.deepEqual(rgFilesMany([]), [])
  }
  finally { vi.unstubAllEnvs() }
})

it('missing working directory does not suggest installing ripgrep', () => {
  assert.throws(() => rgFiles('target', { cwd: '/ripast-missing-directory-for-test' }), (error: unknown) => {
    assert.ok(error instanceof Error)
    assert.doesNotMatch(error.message, /install ripgrep/)
    assert.match(error.message, /ENOENT/)
    return true
  })
})
