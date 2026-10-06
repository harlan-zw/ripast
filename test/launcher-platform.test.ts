import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { makeFixture, prepareLauncher } from './helpers.ts'

it.each(['pnpm', 'npm'] as const)('launcher runs %s shims with literal arguments', (manager) => {
  const fx = makeFixture({ 'package.json': '{"dependencies":{"vue":"*"}}' }, false)
  try {
    const record = join(fx.dir, 'record.json')
    const script = fx.write('manager.ts', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));`)
    const command = process.platform === 'win32'
      ? fx.write(`${manager}.cmd`, `@echo off\r\n"${process.execPath}" --experimental-strip-types "${script}" %*\r\n`)
      : fx.write(manager, `#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types "${script}" "$@"\n`)
    chmodSync(command, 0o755)
    const args = ['scan', 'space & (literal)', '--glob', 'src/{a,b}.ts']
    const child = spawnSync(process.execPath, [prepareLauncher(fx), ...args], {
      cwd: fx.dir,
      env: { ...process.env, PATH: fx.dir, RIPAST_REEXEC: '' },
      encoding: 'utf8',
    })
    assert.equal(child.status, 0, child.stderr)
    const result = JSON.parse(fx.read('record.json'))
    assert.equal(result.cwd.toLowerCase(), fx.dir.toLowerCase())
    const expected = manager === 'pnpm'
      ? ['dlx', '--package=@ripast/cli', '--package=@ripast/vue', 'ripast', ...args]
      : ['exec', '--yes', result.args[2], '--package=@ripast/cli', '--package=@ripast/vue', '--', 'ripast', ...args]
    assert.deepEqual(result.args, expected)
  }
  finally { fx.cleanup() }
})
