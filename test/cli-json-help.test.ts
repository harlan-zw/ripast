import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'

const cli = resolve('packages/cli/bin/ripide.mjs')
const cases = ['rename', 'rename-file', 'scan'].flatMap(command =>
  ['artifact', 'fields', 'minify'].map(option => ({ command, option })),
)

it.each(cases)('$command help explains --$option requires JSON before use', ({ command, option }) => {
  const result = spawnSync(process.execPath, [cli, command, '--help'], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
  assert.equal(result.status, 0, result.stderr)
  const line = result.stdout.split('\n').find(line => new RegExp(`--${option}(?:=|\\s)`).test(line))
  assert.match(line ?? '', /Requires --json\./, `${command} --${option} must explain its prerequisite`)
})
