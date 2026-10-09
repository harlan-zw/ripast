import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { runReplace } from '../packages/core/src/index.ts'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

const cli = resolve('packages/cli/src/cli.ts')

it.each([
  { args: [] },
  { args: ['--glob', 'bridge.ts', '--target-scope', 'replacement.ts'] },
  { args: ['--verify-mode', 'project', '--glob', 'bridge.ts', '--target-scope', 'replacement.ts'] },
])('replacement blocks errors in unchanged consumers with options $args', ({ args }) => {
  const fx = makeFixture({
    'original.ts': 'export function original() { return 42 }\n',
    'replacement.ts': 'export function replacement() { return "text" }\n',
    'bridge.ts': 'import { original } from "./original.ts"\nexport const value = original()\n',
    'consumer.ts': 'import { value } from "./bridge.ts"\nexport const result: number = value\n',
  })
  try {
    const before = fx.read('bridge.ts')
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, 'replace', 'original', 'replacement', '--apply', '--profile', 'full', '--json', ...args], { cwd: fx.dir, encoding: 'utf8' })
    assert.equal(result.status, 1, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.applied, false)
    assert.equal(payload.blockedByRegression, true)
    assert.ok(payload.regressions.some((regression: { file: string, code: number }) => regression.file === `${fx.dir}/consumer.ts` && regression.code === 2322))
    assert.equal(fx.read('bridge.ts'), before)
  }
  finally { fx.cleanup() }
})

it('replacement checks unchanged Vue consumers after changing a TypeScript export', async () => {
  const fx = makeFixture({
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'bundler', noEmit: true }, include: ['**/*.ts', '**/*.vue'] }),
    'original.ts': 'export function original() { return 42 }\n',
    'replacement.ts': 'export function replacement() { return "text" }\n',
    'bridge.ts': 'import { original } from "./original"\nexport const value = original()\n',
    'Comp.vue': '<script setup lang="ts">\nimport { value } from "./bridge"\nconst result: number = value\n</script>\n<template>{{ result }}</template>\n',
  })
  try {
    const result = await runReplace('original', 'replacement', { ...{ cwd: fx.dir }, engine: vueServices() })
    assert.ok(result.regressions.some(regression => regression.file === `${fx.dir}/Comp.vue` && regression.code === 2322), JSON.stringify(result.regressions))
    assert.equal(result.changes.some(change => change.path.endsWith('.vue')), false)
  }
  finally { fx.cleanup() }
})

it.each([
  { verify: undefined, blocked: true },
  { verify: true, blocked: true },
  { verify: 'project' as const, blocked: true },
  { verify: 'touched' as const, blocked: false },
  { verify: false, blocked: false },
  { verify: 'none' as const, blocked: false },
])('replacement respects verification $verify', async ({ verify, blocked }) => {
  const fx = makeFixture({
    'original.ts': 'export function original() { return 42 }\n',
    'replacement.ts': 'export function replacement() { return "text" }\n',
    'bridge.ts': 'import { original } from "./original.ts"\nexport const value = original()\n',
    'consumer.ts': 'import { value } from "./bridge.ts"\nexport const result: number = value\n',
  })
  try {
    const result = await runReplace('original', 'replacement', { ...{ cwd: fx.dir, verify }, engine: vueServices() })
    assert.equal(result.regressions.some(regression => regression.file.endsWith('/consumer.ts') && regression.code === 2322), blocked)
    assert.equal(result.changes[0]?.rel, 'bridge.ts')
  }
  finally { fx.cleanup() }
})
