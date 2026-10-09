import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

const cli = resolve('packages/cli/src/cli.ts')
function run(cwd: string, args: string[], agent = false, json = true) {
  const env = { ...process.env }
  for (const key of ['AI_AGENT', 'CLAUDECODE', 'CLAUDE_CODE', 'REPL_ID', 'GEMINI_CLI', 'CODEX_SANDBOX', 'CODEX_THREAD_ID', 'OPENCODE', 'AUGMENT_AGENT', 'GOOSE_PROVIDER', 'JUNIE_DATA', 'JUNIE_SHIM_PATH', 'COPILOT_AGENT', 'COPILOT_CLI', 'CURSOR_AGENT'])
    delete env[key]
  env.AI_AGENT = agent ? 'contract-test' : ''
  env.EDITOR = ''
  env.TERM_PROGRAM = ''
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args, ...(json ? ['--json'] : [])], {
    cwd,
    encoding: 'utf8',
    env,
  })
}

it('jSON discovery has the same compact contract with or without agent detection', () => {
  const fixture = makeFixture({ 'source.ts': 'export const answer = 42\n' })
  try {
    for (const profile of [[], ['--profile', 'auto'], ['--profile', 'full']]) {
      const direct = run(fixture.dir, ['scan', 'answer', ...profile])
      const agent = run(fixture.dir, ['scan', 'answer', ...profile], true)
      assert.equal(direct.status, 0, direct.stderr)
      assert.equal(agent.stdout, direct.stdout)
      const result = JSON.parse(direct.stdout)
      assert.equal(result._tag, 'Result')
      assert.equal(result.command, 'scan')
      assert.equal(result.base, fixture.dir)
      assert.ok(result.data)
    }
  }
  finally { fixture.cleanup() }
})

it('default text still detects agents while explicit JSON detail ignores detection', () => {
  const fixture = makeFixture({ 'source.ts': 'export const answer = 42\n' })
  try {
    const human = run(fixture.dir, ['scan', 'answer'], false, false)
    const agent = run(fixture.dir, ['scan', 'answer'], true, false)
    assert.equal(human.status, 0, human.stderr)
    assert.equal(agent.status, 0, agent.stderr)
    assert.doesNotMatch(human.stdout, /# profile: agent/)
    assert.match(agent.stdout, /# profile: agent \(contract-test\)/)
  }
  finally { fixture.cleanup() }
})

it.each([['scan', '--help'], ['--version']])('help and version retain the JSON envelope for %s', (...args) => {
  const fixture = makeFixture()
  try {
    const result = run(fixture.dir, args)
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload._tag, 'Result')
    assert.equal(payload.base, fixture.dir)
    assert.equal(payload.command, args[0] === 'scan' ? 'scan' : 'ripide')
    assert.ok(args[0] === 'scan' ? payload.data.usage.includes('scan') : /^\d+\./.test(payload.data.version))
  }
  finally { fixture.cleanup() }
})

it.each(['--verify', '--no-verify'])('removed verification flag %s fails before effects', (flag) => {
  const source = 'export const answer = 42\n'
  const fixture = makeFixture({ 'source.ts': source })
  try {
    const result = run(fixture.dir, ['rename', 'answer', 'next', '--apply', flag])
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stdout)._tag, 'Error')
    assert.match(JSON.parse(result.stdout).data.message, /Unknown option/)
    assert.equal(fixture.read('source.ts'), source)
  }
  finally { fixture.cleanup() }
})

it('mutation tags distinguish preview, apply, and empty without changing source during preview', () => {
  const fixture = makeFixture({ 'source.ts': 'export const className = "font-semibold"\n' })
  try {
    const preview = run(fixture.dir, ['css-class-rename', 'font-semibold', 'font-medium'])
    assert.equal(JSON.parse(preview.stdout)._tag, 'Preview')
    assert.match(fixture.read('source.ts'), /font-semibold/)
    const applied = run(fixture.dir, ['css-class-rename', 'font-semibold', 'font-medium', '--apply'])
    assert.equal(JSON.parse(applied.stdout)._tag, 'Applied')
    assert.match(fixture.read('source.ts'), /font-medium/)
    const empty = run(fixture.dir, ['css-class-rename', 'font-semibold', 'font-medium', '--apply'])
    assert.equal(JSON.parse(empty.stdout)._tag, 'Empty')
  }
  finally { fixture.cleanup() }
})

it.each([['scan', 'answer', '--verify-mode', 'none'], ['scan', 'answer', '--profile', 'bad']])('jSON failures retain command metadata for %s', (...args) => {
  const fixture = makeFixture({ 'source.ts': 'export const answer = 42\n' })
  try {
    const result = run(fixture.dir, args)
    assert.equal(result.status, 1)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload._tag, 'Error')
    assert.equal(payload.command, 'scan')
    assert.match(payload.data.message, /option|profile/i)
  }
  finally { fixture.cleanup() }
})
