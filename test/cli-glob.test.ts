import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

it.each([
  ['brace alternates', '{app,server}/**/*.ts,extra/**/*.ts,!server/generated/**', ['app/main.ts', 'extra/main.ts', 'server/main.ts']],
  ['character classes', 'characters/[a,].ts,app/**/*.ts', ['app/main.ts', 'characters/,.ts', 'characters/a.ts']],
  ['escaped commas', 'literal\\,name/*.ts,app/**/*.ts', ['app/main.ts', 'literal,name/main.ts']],
  ['brace exclusions', '**/*.ts,!{server,extra}/**,!characters/**,!literal\\,name/**', ['app/main.ts', 'outside/main.ts']],
])('forwards %s and top-level comma globs to ripgrep', (_name, glob, files) => {
  const fixture = makeFixture({
    'app/main.ts': 'export const target = 1\n',
    'server/main.ts': 'export const target = 2\n',
    'server/generated/ignore.ts': 'export const target = 3\n',
    'extra/main.ts': 'export const target = 4\n',
    'outside/main.ts': 'export const target = 5\n',
    'characters/a.ts': 'export const target = 6\n',
    'characters/,.ts': 'export const target = 7\n',
    'literal,name/main.ts': 'export const target = 8\n',
  })
  try {
    const output = execFileSync(process.execPath, [
      '--experimental-strip-types',
      '--no-warnings',
      resolve('packages/cli/src/cli.ts'),
      'scan',
      'target',
      '--glob',
      glob,
      '--json',
    ], { cwd: fixture.dir, encoding: 'utf8' })
    const hits = JSON.parse(output) as Array<{ file: string }>
    assert.deepEqual([...new Set(hits.map(hit => hit.file))].sort(), files)
  }
  finally { fixture.cleanup() }
})
