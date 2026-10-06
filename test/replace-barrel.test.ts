import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { runReplace, writeChanges } from '@ripast/core'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

it('migrates a same-name import to a curated barrel alias and merges imports', async () => {
  const fixture = makeFixture({
    'package.json': JSON.stringify({ type: 'module', imports: { '#site-config/server': './server/index.ts' } }),
    'legacy.ts': 'export function getSiteConfig() { return "old" }\n',
    'server/utils.ts': 'export function getSiteConfig() { return "new" }\nexport function createSitePathResolver() { return "-path" }\n',
    'server/index.ts': 'export { getSiteConfig, createSitePathResolver } from "./utils.ts"\n',
    'use.ts': 'import { getSiteConfig } from "./legacy.ts"\nimport { createSitePathResolver } from "#site-config/server"\nconsole.log(getSiteConfig() + createSitePathResolver())\n',
  })
  try {
    const result = await runReplace('getSiteConfig', 'getSiteConfig', {
      cwd: fixture.dir,
      targetScope: 'server/index.ts',
      targetImport: '#site-config/server',
      verify: false,
    })
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'use.ts'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(output.trim(), 'new-path')
    assert.doesNotMatch(fixture.read('use.ts'), /legacy\.ts/)
    assert.equal(fixture.read('use.ts').match(/from "#site-config\/server"/g)?.length, 1)
  }
  finally { fixture.cleanup() }
})

it('preserves wrapper implementations behind a selected barrel', async () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module"}',
    'old.ts': 'export function old() { return 10 }\n',
    'wrapper.ts': 'import { old } from "./old.ts"\nexport function better() { return old() + 1 }\n',
    'index.ts': 'export { better } from "./wrapper.ts"\n',
    'use.ts': 'import { old } from "./old.ts"\nconsole.log(old())\n',
  })
  try {
    const result = await runReplace('old', 'better', { cwd: fixture.dir, targetScope: 'index.ts', verify: false })
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'use.ts'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(output.trim(), '11')
  }
  finally { fixture.cleanup() }
})

it.each([
  'export type { Shape } from "./types.ts"\n',
  'export { Shape } from "./types.ts"\n',
  'export { Details as Shape } from "./types.ts"\n',
])('preserves type-only imports through a named barrel', async (barrel) => {
  const fixture = makeFixture({
    'package.json': JSON.stringify({ type: 'module', imports: { '#public': './server/index.ts' } }),
    'legacy.ts': 'export interface Legacy { value: number }\n',
    'server/types.ts': 'export interface Shape { value: number }\nexport interface Details { value: number }\n',
    'server/index.ts': barrel,
    'use.ts': 'import type { Legacy } from "./legacy.ts"\nconst item: Legacy = { value: 42 }\nconsole.log(item.value)\n',
  })
  try {
    const result = await runReplace('Legacy', 'Shape', { cwd: fixture.dir, targetScope: 'server/index.ts', targetImport: '#public' })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'use.ts'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(output.trim(), '42')
    assert.match(fixture.read('use.ts'), /import type \{ Shape \} from/)
  }
  finally { fixture.cleanup() }
})

it('resolves an external producer barrel with an explicit consumer alias', async () => {
  const producer = makeFixture({
    'utils.ts': 'export function getSiteConfig() { return { url: "https://example.com" } }\n',
    'index.ts': 'export { getSiteConfig } from "./utils.ts"\n',
  })
  const consumer = makeFixture({
    'legacy.ts': 'export function getSiteConfig() { return { url: "https://old.example.com" } }\n',
    'use.ts': 'import { getSiteConfig } from "./legacy.ts"\nexport const url: string = getSiteConfig().url\n',
  })
  consumer.write('tsconfig.json', JSON.stringify({
    compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, allowImportingTsExtensions: true, paths: { '#site-config/server': [`${producer.dir}/index.ts`] } },
    include: ['**/*.ts'],
  }))
  try {
    const result = await runReplace('getSiteConfig', 'getSiteConfig', { cwd: consumer.dir, targetScope: `${producer.dir}/index.ts`, targetImport: '#site-config/server' })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    assert.match(consumer.read('use.ts'), /from ["']#site-config\/server["']/)
    assert.equal(producer.read('index.ts'), 'export { getSiteConfig } from "./utils.ts"\n')
  }
  finally {
    producer.cleanup()
    consumer.cleanup()
  }
})

it('exposes barrel alias targeting through the public CLI', () => {
  const fixture = makeFixture({
    'package.json': '{"type":"module","imports":{"#public":"./index.ts"}}',
    'old.ts': 'export function old() { return 10 }\n',
    'utils.ts': 'export function next() { return 42 }\n',
    'index.ts': 'export { next as better } from "./utils.ts"\n',
    'use.ts': 'import { old } from "./old.ts"\nconsole.log(old())\n',
  })
  try {
    execFileSync(process.execPath, [
      '--experimental-strip-types',
      '--no-warnings',
      resolve('packages/cli/src/cli.ts'),
      'replace',
      'old',
      'better',
      '--target-scope',
      'index.ts',
      '--target-import',
      '#public',
      '--no-verify',
      '--apply',
    ], { cwd: fixture.dir, encoding: 'utf8' })
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'use.ts'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(output.trim(), '42')
  }
  finally { fixture.cleanup() }
})

it('keeps default target discovery on direct declarations', async () => {
  const fixture = makeFixture({
    'old.ts': 'export function old() { return 10 }\n',
    'utils.ts': 'export function better() { return 42 }\n',
    'index.ts': 'export { better } from "./utils.ts"\n',
    'use.ts': 'import { old } from "./old.ts"\nconsole.log(old())\n',
  })
  try {
    const result = await runReplace('old', 'better', { cwd: fixture.dir, verify: false })
    writeChanges(result.changes)
    assert.match(fixture.read('use.ts'), /from ["']\.\/utils\.ts["']/)
  }
  finally { fixture.cleanup() }
})

it.each(['', '#bad path', '#bad"path', '#bad\\path'])('refuses invalid explicit import paths before edits', async (targetImport) => {
  const fixture = makeFixture({
    'utils.ts': 'export function better() { return 42 }\n',
    'use.ts': 'import { old } from "legacy"\nconsole.log(old())\n',
  })
  try {
    await assert.rejects(runReplace('old', 'better', { cwd: fixture.dir, targetImport }), /--target-import requires/)
    assert.equal(fixture.read('use.ts'), 'import { old } from "legacy"\nconsole.log(old())\n')
  }
  finally { fixture.cleanup() }
})
