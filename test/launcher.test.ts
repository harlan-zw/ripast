import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { makeFixture, prepareLauncher } from './helpers.ts'

it('launcher installs missing adapters through pnpm without running npm', () => {
  const fx = makeFixture({
    'package.json': '{"type":"module","dependencies":{"vue":"*"}}',
    'npx': '#!/bin/sh\necho npx > manager\nexit 91\n',
    'pnpm': '#!/bin/sh\necho pnpm > manager\nprintf "%s\\n" "$@" > args\nexit 0\n',
  })
  try {
    const launcher = prepareLauncher(fx)
    for (const name of ['npx', 'pnpm']) chmodSync(resolve(fx.dir, name), 0o755)
    const child = spawnSync(process.execPath, [launcher, 'rename', 'old', 'next'], {
      cwd: fx.dir,
      env: { ...process.env, PATH: `${fx.dir}${delimiter}${process.env.PATH}`, RIPIDE_REEXEC: '' },
      encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(fx.read('manager').trim(), 'pnpm')
    assert.deepEqual(fx.read('args').trim().split('\n'), ['dlx', '--package=ripide', '--package=ripide-vue', 'ripide', 'rename', 'old', 'next'])
  }
  finally { fx.cleanup() }
})

it('installed import-only adapters need no pnpm to show help', () => {
  const fx = makeFixture({
    'package.json': '{"dependencies":{"vue":"*"}}',
    'node_modules/ripide-vue/package.json': '{"type":"module","exports":{".":{"types":"./index.d.ts","import":"./index.mjs"}}}',
    'node_modules/ripide-vue/index.mjs': '',
    'bin/.keep': '',
  }, false)
  try {
    const child = spawnSync(process.execPath, [prepareLauncher(fx), '--help'], {
      cwd: fx.dir,
      env: { ...process.env, PATH: fx.dir, RIPIDE_REEXEC: '' },
      encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /USAGE/)
    assert.doesNotMatch(child.stderr, /pnpm was not found/)
  }
  finally { fx.cleanup() }
})

it('installs an adapter when its import entry is missing', () => {
  const fx = makeFixture({
    'package.json': '{"type":"module","dependencies":{"vue":"*"}}',
    'node_modules/ripide-vue/package.json': '{"exports":{".":{"import":"./missing.mjs"}}}',
    'pnpm': '#!/bin/sh\necho pnpm > manager\nexit 0\n',
    'bin/.keep': '',
  }, false)
  try {
    prepareLauncher(fx)
    chmodSync(resolve(fx.dir, 'pnpm'), 0o755)
    const child = spawnSync(process.execPath, [resolve(fx.dir, 'bin/ripide.mjs'), '--help'], {
      cwd: fx.dir,
      env: { ...process.env, PATH: `${fx.dir}${delimiter}${process.env.PATH}`, RIPIDE_REEXEC: '' },
      encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(fx.read('manager').trim(), 'pnpm')
  }
  finally { fx.cleanup() }
})

it('built CLI renames a symbol without ripgrep when Vue work is disabled', () => {
  const fx = makeFixture({
    'package.json': '{"dependencies":{"vue":"*"}}',
    'source.ts': 'export const target = 1',
  })
  try {
    const child = spawnSync(process.execPath, [resolve('packages/cli/bin/ripide.mjs'), 'rename', 'target', 'next', '--no-vue', '--no-verify', '--profile', 'full', '--json'], {
      cwd: fx.dir,
      env: { ...process.env, PATH: fx.dir, RIPIDE_REEXEC: '' },
      encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr)
    const result = JSON.parse(child.stdout)
    assert.ok(result.changes.some((change: { after: string }) => change.after.includes('export const next')))
    assert.match(child.stderr, /Using Node file search/)
    assert.doesNotMatch(child.stderr, /pnpm was not found/)
  }
  finally { fx.cleanup() }
})

it('launcher explains missing package managers when an adapter needs installation', () => {
  const fx = makeFixture({
    'package.json': '{"type":"module","dependencies":{"vue":"*"}}',
  }, false)
  try {
    const child = spawnSync(process.execPath, [prepareLauncher(fx), 'scan', 'target'], {
      cwd: fx.dir,
      env: { ...process.env, PATH: fx.dir, RIPIDE_REEXEC: '' },
      encoding: 'utf8',
    })
    assert.equal(child.status, 1)
    assert.match(child.stderr, /pnpm.*npm.*PATH/)
    assert.match(child.stderr, /ripide-vue/)
    assert.match(child.stderr, /https:\/\/pnpm.io\/installation/)
    assert.match(child.stderr, /npm install -g ripide ripide-vue/)
    assert.match(child.stderr, /--no-vue/)
  }
  finally { fx.cleanup() }
})

it('launcher falls back to npm with a separate prefix and preserves project cwd', () => {
  const fx = makeFixture({
    'package.json': '{"dependencies":{"vue":"*"},"devEngines":{"packageManager":{"name":"pnpm","onFail":"error"}}}',
    'npm': '#!/bin/sh\npwd > cwd\nprintf "%s\\n" "$@" > args\nprintf "%s" "$RIPIDE_REEXEC" > reexec\nexit 0\n',
  }, false)
  try {
    const launcher = prepareLauncher(fx)
    chmodSync(resolve(fx.dir, 'npm'), 0o755)
    const child = spawnSync(process.execPath, [launcher, 'rename', 'old name', 'next'], {
      cwd: fx.dir,
      env: { ...process.env, PATH: fx.dir, RIPIDE_REEXEC: '' },
      encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr)
    const args = fx.read('args').trim().split('\n')
    assert.deepEqual(args.slice(0, 2), ['exec', '--yes'])
    assert.match(args[2], /^--prefix=/)
    const prefix = args[2].slice('--prefix='.length)
    assert.notEqual(prefix, fx.dir)
    assert.equal(existsSync(prefix), false, 'temporary npm prefix gets removed')
    assert.deepEqual(args.slice(3), ['--package=ripide', '--package=ripide-vue', '--', 'ripide', 'rename', 'old name', 'next'])
    assert.equal(fx.read('cwd').trim(), fx.dir)
    assert.equal(fx.read('reexec'), '1')
  }
  finally { fx.cleanup() }
})

it('launcher does not fall back when pnpm runs and fails', () => {
  const fx = makeFixture({
    'package.json': '{"dependencies":{"vue":"*"}}',
    'pnpm': '#!/bin/sh\nexit 17\n',
    'npm': '#!/bin/sh\necho called > npm-called\nexit 0\n',
  }, false)
  try {
    const launcher = prepareLauncher(fx)
    for (const name of ['pnpm', 'npm']) chmodSync(resolve(fx.dir, name), 0o755)
    const child = spawnSync(process.execPath, [launcher, 'scan', 'target'], {
      cwd: fx.dir,
      env: { ...process.env, PATH: fx.dir, RIPIDE_REEXEC: '' },
      encoding: 'utf8',
    })
    assert.equal(child.status, 17)
    assert.equal(existsSync(resolve(fx.dir, 'npm-called')), false)
  }
  finally { fx.cleanup() }
})
