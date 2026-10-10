import assert from 'node:assert/strict'
import { join } from 'node:path'
import { findRegressions, runRename, startTsServer } from 'ripide-api'
import { diagnosticRegressions } from 'ripide-api/adapter'
import { createVueExtension } from 'ripide-vue'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

it.each([
  {
    name: 'does not trade an existing error for the same error at another declaration',
    before: 'export const a: string = 1\nexport const b: string = "ok"\n',
    after: 'export const a: string = "ok"\nexport const b: string = 1\n',
    expected: [{ line: 2, col: 14, code: 2322 }],
  },
  {
    name: 'does not trade errors between declarations on one line',
    before: 'export const a: string = 1; export const b: string = "ok"\n',
    after: 'export const a: string = "ok"; export const b: string = 1\n',
    expected: [{ line: 1, col: 45, code: 2322 }],
  },
  {
    name: 'preserves an existing error after inserting a line',
    before: 'export const a: string = 1\n',
    after: '// inserted\nexport const a: string = 1\n',
    expected: [],
  },
  {
    name: 'preserves an existing error after shifting its column',
    before: 'export const a: string = 1\n',
    after: 'export    const a: string = 1\n',
    expected: [],
  },
  {
    name: 'reports a new identical error while retaining another existing error',
    before: 'export const a: string = 1\nexport const b: string = 1\nexport const c: string = "ok"\n',
    after: 'export const a: string = "ok"\nexport const b: string = 1\nexport const c: string = 1\n',
    expected: [{ line: 3, col: 14, code: 2322 }],
  },
])('$name', async ({ before, after, expected }) => {
  const fx = makeFixture({ 'value.ts': before })
  const server = await startTsServer(fx.dir)
  try {
    const path = join(fx.dir, 'value.ts')
    const regressions = await findRegressions(server, [{ path, rel: 'value.ts', before, after }], [path])
    assert.deepEqual(regressions.map(({ line, col, code }) => ({ line, col, code })), expected)
  }
  finally {
    server.dispose()
    fx.cleanup()
  }
})

it('does not trade a Vue script error for the same error at another declaration', async () => {
  const before = '<script setup lang="ts">\nconst a: string = 1\nconst b: string = "ok"\n</script>\n<template>{{ a }} {{ b }}</template>\n'
  const after = '<script setup lang="ts">\nconst a: string = "ok"\nconst b: string = 1\n</script>\n<template>{{ a }} {{ b }}</template>\n'
  const fx = makeFixture({
    'Comp.vue': before,
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['**/*.vue'] }),
  })
  try {
    const path = join(fx.dir, 'Comp.vue')
    const regressions = await createVueExtension().semantic!.regressions(join(fx.dir, 'tsconfig.json'), fx.dir, [{ path, rel: 'Comp.vue', before, after }])
    assert.deepEqual(regressions.map(({ line, col, code }) => ({ line, col, code })), [{ line: 3, col: 7, code: 2322 }])
  }
  finally { fx.cleanup() }
})

it('does not reuse one baseline diagnostic to hide duplicate new diagnostics', () => {
  const diagnostic = {
    code: 2322,
    message: 'same error',
    range: { start: { line: 0, character: 6 }, end: { line: 0, character: 7 } },
  }
  const regressions = diagnosticRegressions(
    new Map([['value.ts', [diagnostic]]]),
    new Map([['value.ts', [diagnostic, diagnostic]]]),
    [],
  )
  assert.deepEqual(regressions, [{ file: 'value.ts', line: 1, col: 7, code: 2322, message: 'same error' }])
})

it('reports an error whose expression span changed', () => {
  const diagnostic = {
    code: 2322,
    message: 'same error',
    range: { start: { line: 0, character: 10 }, end: { line: 0, character: 11 } },
  }
  const changedDiagnostic = { ...diagnostic, range: { start: { line: 0, character: 10 }, end: { line: 0, character: 15 } } }
  const regressions = diagnosticRegressions(
    new Map([['value.ts', [diagnostic]]]),
    new Map([['value.ts', [changedDiagnostic]]]),
    [{ path: 'value.ts', before: 'const a = 1', after: 'const a = "bad"' }],
  )
  assert.deepEqual(regressions, [{ file: 'value.ts', line: 1, col: 11, code: 2322, message: 'same error' }])
})

it('preserves an existing type error when renaming its declaration', async () => {
  const fx = makeFixture({ 'value.ts': 'export const old: string = 1\n' })
  try {
    const result = await runRename('old', 'newName', { cwd: fx.dir })
    assert.deepEqual(result.regressions, [])
    assert.equal(result.changes[0]?.after, 'export const newName: string = 1\n')
  }
  finally { fx.cleanup() }
})
