import type { Fixture } from './helpers.ts'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, symlinkSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

// Copy the built CLI so its dynamic imports cannot resolve workspace adapters.
function prepareIsolatedLauncher(fx: Fixture): string {
  const launcher = fx.write('node_modules/ripide/bin/ripide.mjs', '')
  copyFileSync(resolve('packages/cli/bin/ripide.mjs'), launcher)
  fx.write('node_modules/ripide/package.json', '{"type":"module","version":"0.8.0"}')
  cpSync(resolve('packages/cli/dist'), join(fx.dir, 'node_modules/ripide/dist'), { recursive: true })
  for (const name of ['citty', 'cross-spawn', 'diff', 'ripide-api', 'std-env'])
    symlinkSync(resolve('packages/cli/node_modules', name), join(fx.dir, 'node_modules', name), 'junction')
  return launcher
}

const discoveryCommands = [
  ['scan', 'target'],
  ['tree'],
  ['unused'],
  ['css-class-scan'],
  ['css-class-rename', 'old-token', 'new-token'],
]

it.each(discoveryCommands)('isolated launcher bootstraps authored Vue before %s without manifest markers', (...args) => {
  const fx = makeFixture({
    'package.json': '{"type":"module"}',
    'Component.vue': '<script setup lang="ts">const target = 1</script><template><div class="old-token">{{ target }}</div></template>',
    'pnpm': '#!/bin/sh\necho pnpm > manager\nprintf "%s\\n" "$@" > args\nexit 0\n',
  })
  try {
    chmodSync(resolve(fx.dir, 'pnpm'), 0o755)
    const child = spawnSync(process.execPath, [prepareIsolatedLauncher(fx), ...args], {
      cwd: fx.dir,
      env: { ...process.env, PATH: `${fx.dir}${delimiter}${process.env.PATH}`, RIPIDE_REEXEC: '' },
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(fx.read('manager').trim(), 'pnpm')
    assert.deepEqual(fx.read('args').trim().split('\n'), ['dlx', '--package=ripide@0.8.0', '--package=ripide-vue@0.8.0', 'ripide', ...args])
  }
  finally { fx.cleanup() }
})

const noBootstrapCases: { name: string, files: Record<string, string>, args: string[] }[] = [
  { name: 'script project', files: {}, args: ['tree'] },
  { name: 'ignored Vue source', files: { '.ignore': 'ignored/\n', 'ignored/Component.vue': '<template><div /></template>' }, args: ['tree'] },
  { name: 'help with authored Vue', files: { 'Component.vue': '<template><div /></template>' }, args: ['tree', '--help'] },
]

it.each(noBootstrapCases)('isolated launcher skips adapter bootstrap for $name', ({ files, args }) => {
  const fx = makeFixture({
    'package.json': '{"type":"module"}',
    'source.ts': 'export const target = 1',
    'pnpm': '#!/bin/sh\necho pnpm > manager\nexit 91\n',
    ...files,
  })
  try {
    chmodSync(resolve(fx.dir, 'pnpm'), 0o755)
    const child = spawnSync(process.execPath, [prepareIsolatedLauncher(fx), ...args], {
      cwd: fx.dir,
      env: { ...process.env, PATH: `${fx.dir}${delimiter}${process.env.PATH}`, RIPIDE_REEXEC: '' },
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(child.status, 0, child.stderr)
    assert.equal(existsSync(resolve(fx.dir, 'manager')), false)
    if (args.includes('--help'))
      assert.match(child.stdout, /USAGE/)
    else
      assert.match(child.stdout, /source\.ts/)
  }
  finally { fx.cleanup() }
})
