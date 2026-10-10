import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { rmSync, symlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { runRename, writeChanges } from '@ripast/core'
import { findFiles, findFilesMany } from '@ripast/core/adapter'
import { afterEach, beforeEach, it, vi } from 'vitest'
import { makeGitFixture } from './helpers.ts'

const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
let tools: ReturnType<typeof makeGitFixture>
beforeEach(() => {
  tools = makeGitFixture({}, false)
  symlinkSync(git, join(tools.dir, 'git'))
  vi.stubEnv('PATH', tools.dir)
})
afterEach(() => {
  vi.unstubAllEnvs()
  tools.cleanup()
})

it.skipIf(spawnSync('rg', ['--version']).error !== undefined)('prefers ripgrep and does not retry a no-match result through Git', () => {
  vi.unstubAllEnvs()
  const fx = makeGitFixture({ 'source.ts': 'target' }, false)
  try {
    fx.write('.git/index', 'broken')
    assert.deepEqual(findFiles('target', { cwd: fx.dir }), [join(fx.dir, 'source.ts')])
    assert.deepEqual(findFilesMany(['target'], { cwd: fx.dir }), [join(fx.dir, 'source.ts')])
    assert.deepEqual(findFiles('', { cwd: fx.dir, listAll: true }), [join(fx.dir, 'source.ts')])
    assert.deepEqual(findFiles('missing', { cwd: fx.dir }), [])
    assert.throws(() => findFiles('[', { cwd: fx.dir, fixedStrings: false }), /rg failed/)
  }
  finally { fx.cleanup() }
})

it('excludes ignored untracked files and searches only the requested folder with Git', () => {
  const fx = makeGitFixture({ '.gitignore': 'ignored.ts\n', 'outside.ts': 'target' }, false)
  try {
    fx.write('src/new.ts', 'target')
    fx.write('src/ignored.ts', 'target')
    const opts = { cwd: join(fx.dir, 'src') }
    const expected = [join(fx.dir, 'src/new.ts')]
    assert.deepEqual(findFiles('target', opts), expected)
    assert.deepEqual(findFilesMany(['target'], opts), expected)
    assert.deepEqual(findFiles('', { ...opts, listAll: true }), expected)
  }
  finally { fx.cleanup() }
})

it('searches untracked files across path batches with Git regex', () => {
  const fx = makeGitFixture({}, false)
  try {
    const expected = Array.from({ length: 65 }, (_, index) => fx.write(`src/file${index}.ts`, 'target123')).sort()
    assert.deepEqual(findFiles('target[0-9]+', { cwd: join(fx.dir, 'src'), fixedStrings: false }).sort(), expected)
  }
  finally { fx.cleanup() }
})

it('searches tracked working files and untracked files', () => {
  const fx = makeGitFixture({ 'tracked.ts': 'old', 'deleted.ts': 'target' }, false)
  try {
    fx.write('tracked.ts', 'target')
    fx.write('untracked.ts', 'target')
    rmSync(join(fx.dir, 'deleted.ts'))
    const expected = ['tracked.ts', 'untracked.ts'].map(path => join(fx.dir, path))
    assert.deepEqual(findFiles('target', { cwd: fx.dir }).sort(), expected)
    assert.deepEqual(findFilesMany(['target', 'old'], { cwd: fx.dir }).sort(), expected)
    assert.deepEqual(findFiles('', { cwd: fx.dir, listAll: true }).sort(), expected)
  }
  finally { fx.cleanup() }
})

it('renames references in untracked files with the Git fallback', async () => {
  const fx = makeGitFixture({ 'source.ts': 'export const oldName = 1\n' })
  try {
    fx.write('consumer.ts', "import { oldName } from './source'\nexport const value = oldName\n")
    const result = await runRename('oldName', 'newName', { cwd: fx.dir })
    writeChanges(result.changes)
    assert.equal(fx.read('source.ts'), 'export const newName = 1\n')
    assert.equal(fx.read('consumer.ts'), "import { newName } from './source'\nexport const value = newName\n")
  }
  finally { fx.cleanup() }
})

it('searches untracked files with an empty index', () => {
  const fx = makeGitFixture({}, false)
  try {
    fx.write('untracked.ts', 'target')
    assert.deepEqual(findFiles('target', { cwd: fx.dir }), [join(fx.dir, 'untracked.ts')])
    assert.deepEqual(findFiles('', { cwd: fx.dir, listAll: true }), [join(fx.dir, 'untracked.ts')])
  }
  finally { fx.cleanup() }
})

it.each([
  [['{app,server}/**/*.ts', '!server/generated/**'], ['app/main.ts', 'server/main.ts']],
  [['*.ts', '!server/**', 'server/main.ts'], ['app/main.ts', 'server/main.ts']],
  [['/app/**/*.ts'], ['app/main.ts']],
  [['*.ts', '!**/main.ts'], []],
] as const)('preserves glob selection for %j', (glob, expected) => {
  const fx = makeGitFixture({ 'app/main.ts': 'target', 'server/main.ts': 'target', 'server/generated/main.ts': 'target' }, false)
  try {
    const opts = { cwd: fx.dir, glob: [...glob] }
    const paths = (values: string[]) => values.map(path => relative(fx.dir, path)).sort()
    assert.deepEqual(paths(findFiles('target', opts)), expected)
    assert.deepEqual(paths(findFilesMany(['target'], opts)), expected)
    assert.deepEqual(paths(findFiles('', { ...opts, listAll: true })), expected)
  }
  finally { fx.cleanup() }
})

it('searches only the requested directory despite Git full-name configuration', () => {
  const fx = makeGitFixture({ 'outside.ts': 'target', 'src/inside.ts': 'target' }, false)
  try {
    execFileSync('git', ['config', 'grep.fullName', 'true'], { cwd: fx.dir })
    const opts = { cwd: join(fx.dir, 'src') }
    assert.deepEqual(findFiles('target', opts), [join(fx.dir, 'src/inside.ts')])
    assert.deepEqual(findFiles('', { ...opts, listAll: true }), [join(fx.dir, 'src/inside.ts')])
  }
  finally { fx.cleanup() }
})

it('skips binary files and symlinks during content search', () => {
  const fx = makeGitFixture({ 'binary.ts': 'target\0', 'source.ts': 'target' }, false)
  try {
    symlinkSync(join(fx.dir, 'source.ts'), join(fx.dir, 'link.ts'))
    execFileSync('git', ['add', 'link.ts'], { cwd: fx.dir })
    assert.deepEqual(findFiles('target', { cwd: fx.dir }), [join(fx.dir, 'source.ts')])
    assert.deepEqual(findFiles('', { cwd: fx.dir, listAll: true }), [join(fx.dir, 'binary.ts'), join(fx.dir, 'source.ts')])
  }
  finally { fx.cleanup() }
})

it('supports explicit Git extended regular expressions', () => {
  const fx = makeGitFixture({ 'match.ts': 'target123', 'other.ts': 'targetabc' }, false)
  try {
    assert.deepEqual(findFiles('target[0-9]+', { cwd: fx.dir, fixedStrings: false }), [join(fx.dir, 'match.ts')])
    assert.deepEqual(findFiles('target[0-9]+', { cwd: fx.dir }), [])
  }
  finally { fx.cleanup() }
})

it('keeps tracked files when ignore files change', () => {
  const fx = makeGitFixture({ '.hidden.ts': 'target', 'ignored.ts': 'target', 'space and\nnewline.ts': 'target' }, false)
  try {
    fx.write('.gitignore', '*.ts\n')
    fx.write('.ignore', '*.ts\n')
    fx.write('.rgignore', '*.ts\n')
    const expected = ['.hidden.ts', 'ignored.ts', 'space and\nnewline.ts'].map(path => join(fx.dir, path))
    assert.deepEqual(findFiles('target', { cwd: fx.dir }), expected)
    assert.deepEqual(findFiles('', { cwd: fx.dir, listAll: true }), expected)
  }
  finally { fx.cleanup() }
})

it('surfaces Git failures instead of falling back to untracked files', () => {
  const fx = makeGitFixture({ 'tracked.ts': 'target' }, false)
  try {
    fx.write('untracked.ts', 'target')
    fx.write('.git/index', 'broken')
    assert.throws(() => findFiles('target', { cwd: fx.dir }), /Git search failed/)
    assert.throws(() => findFiles('', { cwd: fx.dir, listAll: true }), /Git search failed/)
  }
  finally { fx.cleanup() }
})

it('reports invalid Git regex patterns', () => {
  const fx = makeGitFixture({ 'tracked.ts': 'target' }, false)
  try {
    assert.throws(() => findFiles('[', { cwd: fx.dir, fixedStrings: false }), /Git search failed/)
  }
  finally { fx.cleanup() }
})
