import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { runCssClassRename, writeChanges } from '@ripast/core'
import { rgFiles, rgFilesMany } from '@ripast/core/adapter'
import { it, vi } from 'vitest'
import { makeFixture } from './helpers.ts'

const files = {
  'src/App.vue': '<template><div class="card">app</div></template>\n',
  'node_modules/dummy/Widget.vue': '<template><div class="card">dependency</div></template>\n',
  'packages/app/node_modules/other/Widget.vue': '<template><div class="card">nested dependency</div></template>\n',
}

it('cSS rename plans and applies only project files by default without Git ignore rules', async () => {
  const fx = makeFixture(files, false)
  try {
    const result = await runCssClassRename(new Map([['card', 'panel']]), { cwd: fx.dir })
    assert.deepEqual(result.changes.map(change => change.rel), ['src/App.vue'])
    assert.equal(fx.read('src/App.vue'), files['src/App.vue'])
    writeChanges(result.changes)
    assert.equal(fx.read('src/App.vue'), files['src/App.vue'].replace('card', 'panel'))
    assert.equal(fx.read('node_modules/dummy/Widget.vue'), files['node_modules/dummy/Widget.vue'])
    assert.equal(fx.read('packages/app/node_modules/other/Widget.vue'), files['packages/app/node_modules/other/Widget.vue'])
  }
  finally { fx.cleanup() }
})

it.each([false, true])('cLI CSS rename preserves dependencies with apply=%s', (apply) => {
  const fx = makeFixture(files, false)
  try {
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      '--no-warnings',
      resolve('packages/cli/src/cli.ts'),
      'css-class-rename',
      'card',
      'panel',
      '--json',
      ...(apply ? ['--apply'] : []),
    ], { cwd: fx.dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const output = JSON.parse(result.stdout)
    assert.equal(output.applied, apply)
    assert.deepEqual(output.changes.map((change: { path: string }) => change.path), ['src/App.vue'])
    assert.equal(fx.read('src/App.vue'), apply ? files['src/App.vue'].replace('card', 'panel') : files['src/App.vue'])
    assert.equal(fx.read('node_modules/dummy/Widget.vue'), files['node_modules/dummy/Widget.vue'])
    assert.equal(fx.read('packages/app/node_modules/other/Widget.vue'), files['packages/app/node_modules/other/Widget.vue'])
  }
  finally { fx.cleanup() }
})

it.each([
  [undefined, ['src/App.vue']],
  [['**/*.vue'], ['src/App.vue']],
  [['!src/**'], []],
  [['**/*.vue', '!node_modules/**'], ['src/App.vue']],
  [['**/*node_modules*/**'], []],
  [['node_modules/dummy/*.vue'], ['node_modules/dummy/Widget.vue']],
  [['{node_modules}/{dummy}/*.vue'], ['node_modules/dummy/Widget.vue']],
  [['**/node_modules/**/*.vue'], ['node_modules/dummy/Widget.vue', 'packages/app/node_modules/other/Widget.vue']],
  [['node_modules/dummy/*.vue', '**/*.vue'], ['node_modules/dummy/Widget.vue', 'src/App.vue']],
  [['**/node_modules/**/*.vue', '!node_modules/**'], ['packages/app/node_modules/other/Widget.vue']],
  [['!node_modules/**', '**/node_modules/**/*.vue'], ['packages/app/node_modules/other/Widget.vue']],
] as const)('discovery preserves dependency opt-in and fallback parity for %j', (glob, expected) => {
  const fx = makeFixture(files, false)
  const opts = { cwd: fx.dir, glob: glob ? [...glob] : undefined }
  const paths = (values: string[]) => values.map(path => relative(fx.dir, path)).sort()
  const check = () => {
    assert.deepEqual(paths(rgFiles('card', opts)), expected)
    assert.deepEqual(paths(rgFiles('', { ...opts, listAll: true })), expected)
    assert.deepEqual(paths(rgFilesMany(['card'], opts)), expected)
  }
  try {
    check()
    vi.stubEnv('PATH', fx.dir)
    check()
  }
  finally {
    vi.unstubAllEnvs()
    fx.cleanup()
  }
})
