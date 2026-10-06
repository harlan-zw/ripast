import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync } from 'node:fs'
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
