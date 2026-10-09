import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync } from 'node:fs'
import { delimiter, resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { makeFixture, prepareLauncher } from './helpers.ts'

it.each([
  ['rename', 'old', 'next', '--json', '--no-json'],
  ['rename', 'old', 'next', '--json=true', '--json=false'],
  ['rename', '--', 'old', '--json'],
])('preserves adapter text when JSON is disabled or positional: %j', (...args) => {
  const fixture = makeFixture({
    'package.json': '{"dependencies":{"vue":"*"}}',
    'pnpm': '#!/bin/sh\nprintf "adapter text\\n"\nexit 0\n',
  })
  try {
    const launcher = prepareLauncher(fixture)
    chmodSync(resolve(fixture.dir, 'pnpm'), 0o755)
    const result = spawnSync(process.execPath, [launcher, ...args], {
      cwd: fixture.dir,
      env: { ...process.env, PATH: `${fixture.dir}${delimiter}${process.env.PATH}`, RIPIDE_REEXEC: '' },
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'adapter text\n')
    assert.doesNotMatch(result.stderr, /JSON|Unexpected token/)
  }
  finally {
    fixture.cleanup()
  }
})

it('preserves the complete large adapter JSON and its failure exit', () => {
  const payload = { status: 'refused', diagnostics: 'detail'.repeat(40_000) }
  const fixture = makeFixture({
    'package.json': '{"dependencies":{"vue":"*"}}',
    'pnpm': `#!/bin/sh\nprintf '%s' '${JSON.stringify(payload)}'\nexit 7\n`,
  })
  try {
    const launcher = prepareLauncher(fixture)
    chmodSync(resolve(fixture.dir, 'pnpm'), 0o755)
    const result = spawnSync(process.execPath, [launcher, 'rename', 'old', 'next', '--no-json', '--json'], {
      cwd: fixture.dir,
      env: { ...process.env, PATH: `${fixture.dir}${delimiter}${process.env.PATH}`, RIPIDE_REEXEC: '' },
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(result.status, 7, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), payload)
  }
  finally {
    fixture.cleanup()
  }
})

it.each([
  ['--no-json', '--json'],
  ['--json=false', '--json=true'],
])('forwards one JSON value when the final flag enables JSON: %j', (...flags) => {
  const fixture = makeFixture({
    'package.json': '{"dependencies":{"vue":"*"}}',
    'pnpm': '#!/bin/sh\nprintf \'{"adapter":"complete"}\\n\'\nexit 0\n',
  })
  try {
    const launcher = prepareLauncher(fixture)
    chmodSync(resolve(fixture.dir, 'pnpm'), 0o755)
    const result = spawnSync(process.execPath, [launcher, 'rename', 'old', 'next', ...flags], {
      cwd: fixture.dir,
      env: { ...process.env, PATH: `${fixture.dir}${delimiter}${process.env.PATH}`, RIPIDE_REEXEC: '' },
      encoding: 'utf8',
      timeout: 10_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), { adapter: 'complete' })
  }
  finally {
    fixture.cleanup()
  }
})
