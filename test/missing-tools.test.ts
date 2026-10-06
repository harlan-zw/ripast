import assert from 'node:assert/strict'
import { symlinkSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { it, vi } from 'vitest'
import { rgFiles, rgFilesMany } from '../packages/core/src/adapter.ts'
import { scan } from '../packages/core/src/index.ts'
import vueAdapter from '../packages/vue/src/index.ts'
import { makeFixture } from './helpers.ts'

it.each([
  ['ignored directories', { '.git/config': '', '.gitignore': 'ignored/\n', 'ignored/a.ts': 'target' }, ['*.ts', 'ignored/**'], []],
  ['explicit directory overrides', { '.git/config': '', '.gitignore': 'ignored/\n', 'ignored/a.ts': 'target' }, ['*.ts', 'ignored'], ['ignored/a.ts']],
  ['nested repositories', { '.git/config': '', '.gitignore': 'blocked/\n', 'sub/.git/config': '', 'sub/blocked/a.ts': 'target' }, ['*.ts'], ['sub/blocked/a.ts']],
  ['literal extglobs', { 'a.ts': 'target', '@(a|b).ts': 'target' }, ['@(a|b).ts'], ['@(a|b).ts']],
  ['literal brace alternatives', { 'a1.ts': 'target', 'a1..3.ts': 'target', 'a{1..3}.ts': 'target' }, ['a{1..3}.ts'], ['a1..3.ts']],
] as const)('fallback preserves ripgrep selection for %s', (_name, files, glob, expected) => {
  const fx = makeFixture(files, false)
  const run = () => rgFiles('target', { cwd: fx.dir, glob: [...glob] }).map(path => relative(fx.dir, path)).sort()
  try {
    assert.deepEqual(run(), expected)
    vi.stubEnv('PATH', fx.dir)
    assert.deepEqual(run(), expected)
  }
  finally {
    vi.unstubAllEnvs()
    fx.cleanup()
  }
})

it.each([
  ['single-pattern search', (cwd: string) => rgFiles('target', { cwd })],
  ['file listing', (cwd: string) => rgFiles('', { cwd, listAll: true })],
  ['batch search', (cwd: string) => rgFilesMany(['target', 'other'], { cwd })],
] as const)('%s works without ripgrep and matches its file selection', (_name, run) => {
  const fx = makeFixture({
    '.git/config': '',
    '.gitignore': 'ignored.ts\nignored-dir/\nnode_modules/\n',
    '.ignore': 'ignore-dir/\n',
    '.rgignore': 'rgignore-dir/\n',
    'visible.ts': 'export const target = 1',
    '.hidden.ts': 'target',
    'ignored.ts': 'target',
    'src/nested.ts': 'target',
    'ignored-dir/no.ts': 'target',
    'ignore-dir/no.ts': 'target',
    'rgignore-dir/no.ts': 'target',
    'node_modules/no.ts': 'target',
    '.claude/worktrees/task/no.ts': 'target',
    'nested/.gitignore': 'skip/\n*.ts\n!keep.ts\n',
    'nested/keep.ts': 'target',
    'nested/ignored.ts': 'target',
    'nested/skip/no.ts': 'target',
  }, false)
  try {
    const expected = ['.hidden.ts', 'ignored.ts', 'nested/ignored.ts', 'nested/keep.ts', 'src/nested.ts', 'visible.ts']
    const paths = (files: string[]) => files.map(path => relative(fx.dir, path)).sort()
    assert.deepEqual(paths(run(fx.dir)), expected)
    vi.stubEnv('PATH', fx.dir)
    assert.deepEqual(paths(run(fx.dir)), expected)
  }
  finally {
    vi.unstubAllEnvs()
    fx.cleanup()
  }
})

it('fallback honors ordered globs, braces, binary filtering, and symlink exclusion', () => {
  const fx = makeFixture({
    'src/a.ts': 'target',
    'src/b.js': 'target',
    'src/no.spec.ts': 'target',
    'src/restored.spec.ts': 'target',
    'other/a.ts': 'target',
    'src/binary.ts': '\0target',
  }, false)
  symlinkSync(resolve(fx.dir, 'src'), resolve(fx.dir, 'src/loop'), 'dir')
  try {
    const opts = { cwd: fx.dir, glob: ['src/*.{ts,js}', '!*.spec.ts', 'src/restored.spec.ts'] }
    const paths = (files: string[]) => files.map(path => relative(fx.dir, path)).sort()
    const expected = ['src/a.ts', 'src/b.js', 'src/restored.spec.ts']
    assert.deepEqual(paths(rgFiles('target', opts)), expected)
    vi.stubEnv('PATH', fx.dir)
    assert.deepEqual(paths(rgFiles('target', opts)), expected)
  }
  finally {
    vi.unstubAllEnvs()
    fx.cleanup()
  }
})

it('fallback respects parent ignore rules when called from a subdirectory', () => {
  const fx = makeFixture({
    '.git/config': '',
    '.gitignore': 'src/blocked/\n',
    'src/visible.ts': 'target',
    'src/blocked/no.ts': 'target',
  }, false)
  try {
    vi.stubEnv('PATH', fx.dir)
    assert.deepEqual(rgFiles('target', { cwd: resolve(fx.dir, 'src') }), [resolve(fx.dir, 'src/visible.ts')])
  }
  finally {
    vi.unstubAllEnvs()
    fx.cleanup()
  }
})

it('scan and the Vue adapter work without ripgrep', () => {
  const fx = makeFixture({
    'source.ts': 'export const target = 1',
    'View.vue': '<template>{{ target }}</template>',
  }, false)
  try {
    vi.stubEnv('PATH', fx.dir)
    assert.ok(scan('target', { cwd: fx.dir }).some(hit => hit.file === 'source.ts' && hit.kind === 'identifier-binding'))
    assert.equal(vueAdapter.hasFilesContaining!(fx.dir, 'target'), true)
    assert.equal(vueAdapter.hasFilesContaining!(fx.dir, 'missing'), false)
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

it.each(['direct', 'include', 'repository'] as const)('fallback matches %s Git excludes and repository excludes', (source) => {
  const fx = makeFixture({
    '.git/config': '',
    '.git/info/exclude': 'info-dir/\n',
    'global-ignore': 'global-dir/\nUPPER/\n',
    'visible.ts': 'target',
    'info-dir/no.ts': 'target',
    'global-dir/no.ts': 'target',
    'UPPER/no.ts': 'target',
    'upper/yes.ts': 'target',
  }, false)
  try {
    fx.write('shared.conf', `[core]\nexcludesfile = ${resolve(fx.dir, 'global-ignore')}\n`)
    fx.write('.gitconfig', source === 'direct' ? fx.read('shared.conf') : source === 'include' ? '[include]\npath = shared.conf\n' : '')
    if (source === 'repository')
      fx.write('.git/config', fx.read('shared.conf'))
    vi.stubEnv('HOME', fx.dir)
    vi.stubEnv('XDG_CONFIG_HOME', resolve(fx.dir, '.config'))
    vi.stubEnv('GIT_CONFIG_GLOBAL', '')
    const paths = (files: string[]) => files.map(path => relative(fx.dir, path)).sort()
    const expected = source === 'direct' ? ['upper/yes.ts', 'visible.ts'] : ['UPPER/no.ts', 'global-dir/no.ts', 'upper/yes.ts', 'visible.ts']
    assert.deepEqual(paths(rgFiles('target', { cwd: fx.dir })), expected)
    vi.stubEnv('PATH', fx.dir)
    assert.deepEqual(paths(rgFiles('target', { cwd: fx.dir })), expected)
  }
  finally {
    vi.unstubAllEnvs()
    fx.cleanup()
  }
})

it('fallback refuses regex searches rather than changing regex semantics', () => {
  const fx = makeFixture({}, false)
  vi.stubEnv('PATH', fx.dir)
  try {
    assert.throws(() => rgFiles('target.*', { cwd: fx.dir, fixedStrings: false }), /Regex searches require ripgrep/)
  }
  finally {
    vi.unstubAllEnvs()
    fx.cleanup()
  }
})

it('missing working directory remains an error', () => {
  assert.throws(() => rgFiles('target', { cwd: '/ripast-missing-directory-for-test' }), /ENOENT/)
})
