import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, symlinkSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

it('launcher installs missing adapters through pnpm without running npm', () => {
  const fx = makeFixture({
    'package.json': '{"type":"module","dependencies":{"vue":"*"}}',
    'npx': '#!/bin/sh\necho npx > manager\nexit 91\n',
    'pnpm': '#!/bin/sh\necho pnpm > manager\nprintf "%s\\n" "$@" > args\nexit 0\n',
  })
  try {
    copyFileSync(resolve('packages/cli/bin/ripast.mjs'), resolve(fx.dir, 'ripast.mjs'))
    for (const name of ['npx', 'pnpm']) chmodSync(resolve(fx.dir, name), 0o755)
    const child = spawnSync(process.execPath, [resolve(fx.dir, 'ripast.mjs'), 'rename', 'old', 'next'], {
      cwd: fx.dir,
      env: { ...process.env, PATH: `${fx.dir}${delimiter}${process.env.PATH}`, RIPAST_REEXEC: '' },
      encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(fx.read('manager').trim(), 'pnpm')
    assert.deepEqual(fx.read('args').trim().split('\n'), ['dlx', '--package=@ripast/cli', '--package=@ripast/vue', 'ripast', 'rename', 'old', 'next'])
  }
  finally { fx.cleanup() }
})

it('installed adapters need no pnpm to show help', () => {
  const fx = makeFixture({
    'package.json': '{"dependencies":{"vue":"*"}}',
    'node_modules/@ripast/vue/index.js': '',
    'bin/.keep': '',
  }, false)
  try {
    copyFileSync(resolve('packages/cli/bin/ripast.mjs'), resolve(fx.dir, 'bin/ripast.mjs'))
    symlinkSync(resolve('packages/cli/dist'), resolve(fx.dir, 'dist'), 'dir')
    const child = spawnSync(process.execPath, [resolve(fx.dir, 'bin/ripast.mjs'), '--help'], {
      cwd: fx.dir,
      env: { ...process.env, PATH: fx.dir, RIPAST_REEXEC: '' },
      encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /USAGE/)
    assert.doesNotMatch(child.stderr, /pnpm was not found/)
  }
  finally { fx.cleanup() }
})

it('built CLI shows ripgrep guidance when Vue work is disabled', () => {
  const fx = makeFixture({ 'package.json': '{"dependencies":{"vue":"*"}}' }, false)
  try {
    const child = spawnSync(process.execPath, [resolve('packages/cli/bin/ripast.mjs'), 'rename', 'target', 'next', '--no-vue'], {
      cwd: fx.dir,
      env: { ...process.env, PATH: fx.dir, RIPAST_REEXEC: '' },
      encoding: 'utf8',
    })
    assert.equal(child.status, 1)
    assert.match(child.stderr, /ripgrep \(rg\).*PATH/)
    assert.match(child.stderr, /rg --version/)
    assert.doesNotMatch(child.stderr, /pnpm was not found/)
  }
  finally { fx.cleanup() }
})

it('launcher explains missing pnpm when an adapter needs installation', () => {
  const fx = makeFixture({
    'package.json': '{"type":"module","dependencies":{"vue":"*"}}',
  }, false)
  try {
    copyFileSync(resolve('packages/cli/bin/ripast.mjs'), resolve(fx.dir, 'ripast.mjs'))
    const child = spawnSync(process.execPath, [resolve(fx.dir, 'ripast.mjs'), 'scan', 'target'], {
      cwd: fx.dir,
      env: { ...process.env, PATH: fx.dir, RIPAST_REEXEC: '' },
      encoding: 'utf8',
    })
    assert.equal(child.status, 1)
    assert.match(child.stderr, /pnpm.*PATH/)
    assert.match(child.stderr, /@ripast\/vue/)
    assert.match(child.stderr, /npx get-pnpm/)
    assert.match(child.stderr, /npm install -g @ripast\/cli @ripast\/vue/)
    assert.match(child.stderr, /--no-vue/)
  }
  finally { fx.cleanup() }
})
