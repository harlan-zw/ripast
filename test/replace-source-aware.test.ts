import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { createEngine, runReplace, writeChanges } from 'ripide-api'
import { createVueExtension } from 'ripide-vue'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

it('replaces a selected provider through local and public aliases without capturing names', async () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module"}',
    'legacy.ts': 'export function original() { return "old" }\n',
    'other.ts': 'export function original() { return "other" }\n',
    'next.ts': 'export function replacement() { return "new" }\n',
    'public.ts': 'export { original as publicName } from "./legacy.ts"\n',
    'use.ts': 'import { original as alias } from "./legacy.ts"\nimport { publicName as publicAlias } from "./public.ts"\nimport { original } from "./other.ts"\nconst replacement = "local"\nconsole.log([alias(), publicAlias(), original(), replacement].join(","))\n',
  })
  try {
    const result = await runReplace('original', 'replacement', {
      cwd: fixture.dir,
      sourceScope: 'legacy.ts',
      targetScope: 'next.ts',
      verifyMode: 'project',
    })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'use.ts'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(output.trim(), 'new,new,other,local')
    const barrelOutput = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', 'import { publicName } from "./public.ts"; console.log(publicName())'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(barrelOutput.trim(), 'new')
  }
  finally { fixture.cleanup() }
})

it('retargets aliases through star barrel chains and preserves public names', async () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module"}',
    'legacy.ts': 'export function original() { return 1 }\nexport function keep() { return 2 }\n',
    'inner.ts': 'export { original as publicName, keep } from "./legacy.ts"\n',
    'outer.ts': 'export * from "./inner.ts"\n',
    'next.ts': 'export function replacement() { return 40 }\n',
    'use.ts': 'import { publicName as alias, keep } from "./outer.ts"\nconsole.log(alias() + keep())\n',
  })
  try {
    const result = await runReplace('original', 'replacement', { cwd: fixture.dir, sourceScope: 'legacy.ts', targetScope: 'next.ts' })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', 'import { publicName, keep } from "./outer.ts"; console.log(publicName() + keep())'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(output.trim(), '42')
  }
  finally { fixture.cleanup() }
})

it('selects an exported alias from a star source barrel', async () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module"}',
    'legacy.ts': 'export function original() { return 1 }\n',
    'inner.ts': 'export { original as publicName } from "./legacy.ts"\n',
    'outer.ts': 'export * from "./inner.ts"\n',
    'next.ts': 'export function replacement() { return 42 }\n',
    'use.ts': 'import { publicName as alias } from "./outer.ts"\nconsole.log(alias())\n',
  })
  try {
    const result = await runReplace('publicName', 'replacement', { cwd: fixture.dir, sourceScope: 'outer.ts', targetScope: 'next.ts' })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'use.ts'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(output.trim(), '42')
  }
  finally { fixture.cleanup() }
})

it('retargets default imports while preserving their local names', async () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module"}',
    'legacy.ts': 'export default function original() { return 1 }\n',
    'next.ts': 'export function replacement() { return 42 }\n',
    'use.ts': 'import alias from "./legacy.ts"\nconsole.log(alias())\n',
  })
  try {
    const result = await runReplace('default', 'replacement', { cwd: fixture.dir, sourceScope: 'legacy.ts', targetScope: 'next.ts' })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'use.ts'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(output.trim(), '42')
  }
  finally { fixture.cleanup() }
})

it('keeps type-only aliases erased and checks wrapper implementations', async () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module"}',
    'legacy.ts': 'export interface Original { value: number }\n',
    'public.ts': 'export type { Original as PublicType } from "./legacy.ts"\n',
    'next.ts': 'export interface Replacement { value: number }\n',
    'use.ts': 'import type { PublicType as Alias } from "./public.ts"\nconst item: Alias = { value: 42 }\nconsole.log(item.value)\n',
  })
  try {
    const result = await runReplace('Original', 'Replacement', { cwd: fixture.dir, sourceScope: 'legacy.ts', targetScope: 'next.ts' })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'use.ts'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(output.trim(), '42')
  }
  finally { fixture.cleanup() }
})

it.each([
  ['namespace import', 'import * as legacy from "./legacy.ts"\nconsole.log(legacy.original())\n'],
  ['exported namespace', 'export * as legacy from "./legacy.ts"\n'],
])('refuses a selected provider in an unsupported %s before writes', async (_, consumer) => {
  const fixture = makeFixture({
    'legacy.ts': 'export function original() { return 1 }\n',
    'next.ts': 'export function replacement() { return 42 }\n',
    'first.ts': 'import { original as alias } from "./legacy.ts"\nconsole.log(alias())\n',
    'use.ts': consumer,
  })
  try {
    await assert.rejects(runReplace('original', 'replacement', { cwd: fixture.dir, sourceScope: 'legacy.ts', targetScope: 'next.ts', verifyMode: 'none' }), /cannot retarget.*namespace/)
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'first.ts'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(output.trim(), '1')
  }
  finally { fixture.cleanup() }
})

it('refuses ambiguous star providers before returning edits', async () => {
  const fixture = makeFixture({
    'legacy.ts': 'export function original() { return 1 }\n',
    'other.ts': 'export function original() { return 2 }\n',
    'public.ts': 'export * from "./legacy.ts"\nexport * from "./other.ts"\n',
    'next.ts': 'export function replacement() { return 42 }\n',
  })
  try {
    await assert.rejects(runReplace('original', 'replacement', { cwd: fixture.dir, sourceScope: 'legacy.ts', targetScope: 'next.ts', verifyMode: 'none' }), /ambiguous providers/)
  }
  finally { fixture.cleanup() }
})

it('leaves the selected replacement wrapper implementation callable', async () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module"}',
    'legacy.ts': 'export function original() { return 40 }\n',
    'next.ts': 'import { original as wrapped } from "./legacy.ts"\nexport function replacement() { return wrapped() + 2 }\n',
    'public.ts': 'export { replacement } from "./next.ts"\n',
    'use.ts': 'import { original as alias } from "./legacy.ts"\nconsole.log(alias())\n',
  })
  try {
    const result = await runReplace('original', 'replacement', { cwd: fixture.dir, sourceScope: 'legacy.ts', targetScope: 'public.ts' })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'use.ts'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(output.trim(), '42')
  }
  finally { fixture.cleanup() }
})

it('exposes provider selection through the public CLI', () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module"}',
    'legacy.ts': 'export function original() { return 1 }\n',
    'next.ts': 'export function replacement() { return 42 }\n',
    'use.ts': 'import { original as alias } from "./legacy.ts"\nconsole.log(alias())\n',
  })
  try {
    execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', resolve('packages/cli/src/cli.ts'), 'replace', 'original', 'replacement', '--source-scope', 'legacy.ts', '--target-scope', 'next.ts', '--apply'], { cwd: fixture.dir, encoding: 'utf8' })
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'use.ts'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(output.trim(), '42')
  }
  finally { fixture.cleanup() }
})

it('exposes provider selection through the engine SDK', async () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module"}',
    'legacy.ts': 'export function original() { return 1 }\n',
    'next.ts': 'export function replacement() { return 42 }\n',
    'use.ts': 'import { original as alias } from "./legacy.ts"\nconsole.log(alias())\n',
  })
  try {
    const result = await createEngine().replace('original', 'replacement', { cwd: fixture.dir, sourceScope: 'legacy.ts', targetScope: 'next.ts' })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'use.ts'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(output.trim(), '42')
  }
  finally { fixture.cleanup() }
})

it('refuses framework source files before returning a partial plan', async () => {
  const fixture = makeFixture({
    'legacy.ts': 'export function original() { return 1 }\n',
    'next.ts': 'export function replacement() { return 42 }\n',
    'use.vue': '<script setup lang="ts">import { original as alias } from "./legacy.ts"; console.log(alias())</script>\n',
  })
  try {
    await assert.rejects(createEngine({ extensions: [createVueExtension()] }).replace('original', 'replacement', { cwd: fixture.dir, sourceScope: 'legacy.ts', targetScope: 'next.ts' }), /does not support replace|requires native TypeScript or JavaScript/)
  }
  finally { fixture.cleanup() }
})

it('refuses barrel retargeting that would make a replacement wrapper recurse', async () => {
  const fixture = makeFixture({
    'legacy.ts': 'export function original() { return 40 }\n',
    'old-public.ts': 'export { original as publicName } from "./legacy.ts"\n',
    'next.ts': 'import { publicName as wrapped } from "./old-public.ts"\nexport function replacement() { return wrapped() + 2 }\n',
    'use.ts': 'import { original as alias } from "./legacy.ts"\nconsole.log(alias())\n',
  })
  try {
    await assert.rejects(runReplace('original', 'replacement', { cwd: fixture.dir, sourceScope: 'legacy.ts', targetScope: 'next.ts' }), /replacement dependency/)
  }
  finally { fixture.cleanup() }
})

it('refuses cyclic barrel identities before returning edits', async () => {
  const fixture = makeFixture({
    'legacy.ts': 'export function original() { return 1 }\n',
    'one.ts': 'export * from "./two.ts"\nexport * from "./legacy.ts"\n',
    'two.ts': 'export * from "./one.ts"\n',
    'next.ts': 'export function replacement() { return 42 }\n',
  })
  try {
    await assert.rejects(runReplace('original', 'replacement', { cwd: fixture.dir, sourceScope: 'legacy.ts', targetScope: 'next.ts', verifyMode: 'none' }), /cyclic barrel/)
  }
  finally { fixture.cleanup() }
})

it('refuses an unproven dynamic replacement dependency', async () => {
  const fixture = makeFixture({
    'legacy.ts': 'export function original() { return 40 }\n',
    'old-public.ts': 'export { original as publicName } from "./legacy.ts"\n',
    'next.ts': 'export async function replacement() { const { publicName } = await import("./old-public.ts"); return publicName() + 2 }\n',
    'use.ts': 'import { original as alias } from "./legacy.ts"\nconsole.log(alias())\n',
  })
  try {
    await assert.rejects(runReplace('original', 'replacement', { cwd: fixture.dir, sourceScope: 'legacy.ts', targetScope: 'next.ts', verifyMode: 'none' }), /dynamic replacement dependency/)
  }
  finally { fixture.cleanup() }
})

it('keeps a type-only star export erased when the target also has a runtime value', async () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module"}',
    'legacy.ts': 'export interface Original { value: number }\n',
    'public.ts': 'export * from "./legacy.ts"\n',
    'next.ts': 'export class Replacement { value = 42 }\n',
    'use.ts': 'import type { Original as Alias } from "./public.ts"\nconst item: Alias = { value: 42 }\nconsole.log(item.value)\n',
  })
  try {
    const result = await runReplace('Original', 'Replacement', { cwd: fixture.dir, sourceScope: 'legacy.ts', targetScope: 'next.ts' })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', 'import * as publicModule from "./public.ts"; console.log(Object.hasOwn(publicModule, "Original"))'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(output.trim(), 'false')
  }
  finally { fixture.cleanup() }
})

it('preserves type-only value forwarding through a star chain', async () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module"}',
    'legacy.ts': 'export class Original { value = 1 }\n',
    'inner.ts': 'export type * from "./legacy.ts"\n',
    'outer.ts': 'export * from "./inner.ts"\n',
    'next.ts': 'export class Replacement { value = 42 }\n',
    'use.ts': 'import type { Original as Alias } from "./outer.ts"\nconst item: Alias = { value: 42 }\nconsole.log(item.value)\n',
  })
  try {
    const result = await runReplace('Original', 'Replacement', { cwd: fixture.dir, sourceScope: 'legacy.ts', targetScope: 'next.ts' })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', 'import * as publicModule from "./outer.ts"; console.log(Object.hasOwn(publicModule, "Original"))'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(output.trim(), 'false')
  }
  finally { fixture.cleanup() }
})

it('refuses a declaration-only package dependency that can hide wrapper recursion', async () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module"}',
    'legacy.ts': 'export function original() { return 40 }\n',
    'old-public.ts': 'export { original as wrapped } from "./legacy.ts"\n',
    'node_modules/bridge/package.json': '{"name":"bridge","type":"module","types":"index.d.ts","main":"index.js"}',
    'node_modules/bridge/index.d.ts': 'export { wrapped } from "../../old-public.ts"\n',
    'node_modules/bridge/index.js': 'export { wrapped } from "../../old-public.ts"\n',
    'next.ts': 'import { wrapped } from "bridge"\nexport function replacement() { return wrapped() + 2 }\n',
    'use.ts': 'import { original as alias } from "./legacy.ts"\nconsole.log(alias())\n',
  })
  try {
    await assert.rejects(runReplace('original', 'replacement', { cwd: fixture.dir, sourceScope: 'legacy.ts', targetScope: 'next.ts', verifyMode: 'none' }), /declaration-only replacement dependency/)
  }
  finally { fixture.cleanup() }
})
