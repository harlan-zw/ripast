import assert from 'node:assert/strict'
import { runCommand } from 'citty'
import { it } from 'vitest'
import { defineStrictCommand } from '../packages/cli/src/command.ts'

it('commands refuse options that would otherwise be ignored', async () => {
  let ran = false
  const command = defineStrictCommand({
    args: { pattern: { type: 'positional' }, glob: { type: 'string' } },
    run() { ran = true },
  })
  await assert.rejects(runCommand(command, { rawArgs: ['hits', '--scope', 'a.ts'] }), /Unknown option: --scope/)
  assert.equal(ran, false)
})

it('commands refuse extra positional paths before running', async () => {
  let ran = false
  const command = defineStrictCommand({
    args: { from: { type: 'positional' }, to: { type: 'positional' } },
    run() { ran = true },
  })
  await assert.rejects(runCommand(command, { rawArgs: ['hits', 'markedHits', 'a.ts'] }), /Unexpected positional argument: a.ts/)
  assert.equal(ran, false)
})

it('commands accept kebab-case options and negated booleans', async () => {
  const command = defineStrictCommand({
    args: { verifyMode: { type: 'string' }, vue: { type: 'boolean' } },
    run({ args }) { return { mode: args.verifyMode, vue: args.vue } },
  })
  const result = await runCommand(command, { rawArgs: ['--verify-mode=none', '--no-vue'] })
  assert.deepEqual(result.result, { mode: 'none', vue: false })
})

it('commands refuse positional names used as ignored options', async () => {
  const command = defineStrictCommand({
    args: { pattern: { type: 'positional' } },
    run({ args }) { return args.pattern },
  })
  await assert.rejects(runCommand(command, { rawArgs: ['hits', '--pattern=ignored'] }), /Unknown option: --pattern/)
})

it.each(['--no-scope', '--scope', '--scope='])('commands refuse invalid string options %s before running', async (option) => {
  let ran = false
  const command = defineStrictCommand({
    args: { scope: { type: 'string' } },
    run() { ran = true },
  })
  await assert.rejects(runCommand(command, { rawArgs: [option] }), /--scope requires a non-empty string/)
  assert.equal(ran, false)
})

it.each([
  { rawArgs: ['--changed'], changed: '', json: false },
  { rawArgs: ['--changed', '--json'], changed: '', json: true },
  { rawArgs: ['--changed', 'HEAD~1', '--json'], changed: 'HEAD~1', json: true },
])('commands preserve optional values and following flags: $rawArgs', async ({ rawArgs, changed, json }) => {
  const command = defineStrictCommand({
    args: { changed: { type: 'string' }, json: { type: 'boolean', default: false } },
    run({ args }) { return { changed: args.changed, json: args.json } },
  }, ['changed'])
  const result = await runCommand(command, { rawArgs })
  assert.deepEqual(result.result, { changed, json })
})
