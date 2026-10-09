import type { FrameworkAdapter } from '@ripast/core'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from '@ripast/core'
import { parseSourceFile } from '@ripast/core/adapter'
import vue from '@ripast/vue'
import { expect, it } from 'vitest'

it('isolates extension suffix ownership and authored source positions', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'engine-'))
  try {
    writeFileSync(join(cwd, 'source.other'), 'header\nexport const value = 1')
    const engine = createEngine({ extensions: [{ name: 'other', suffixes: ['.other'], parse(path, source) {
      const scriptStart = source.indexOf('export')
      const scriptSource = source.slice(scriptStart)
      return { scriptStart, scriptEnd: source.length, scriptSource, program: parseSourceFile(`${path}.ts`, scriptSource).program, isSfc: true }
    } }] })
    expect(engine.scan('value', { cwd })).toMatchObject([{ file: 'source.other', line: 2, col: 14 }])
    expect(createEngine().scan('value', { cwd })).toEqual([])
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
it('rejects duplicate ownership and broken initialization', () => {
  const extension = { name: 'other', suffixes: ['.other'], parse: () => {
    throw new Error('unused')
  } }
  expect(() => createEngine({ extensions: [extension, { ...extension, name: 'duplicate' }] })).toThrow(/ownership/)
  expect(() => createEngine({ extensions: [{ ...extension, setup: () => {
    throw new Error('broken')
  } }] })).toThrow('broken')
})
function otherExtension(): FrameworkAdapter {
  return {
    name: 'other',
    suffixes: ['.other'],
    operations: ['rename'],
    parse(_path, source) {
      // This grammar is not TypeScript: @use value. Offsets belong to authored source.
      const offset = source.indexOf('value')
      return { scriptSource: source, scriptStart: 0, scriptEnd: source.length, isSfc: false, program: { type: 'Program', start: 0, end: source.length, body: [{ type: 'ExpressionStatement', start: offset, end: offset + 5, expression: { type: 'Identifier', name: 'value', start: offset, end: offset + 5 } }] } }
    },
    setup(hooks) {
      hooks.hook('operation:plan', (context) => {
        if (context.operation !== 'rename')
          return
        const path = join(context.cwd, 'consumer.other')
        const before = readFileSync(path, 'utf8')
        const after = before.replace(`@use ${context.args[0]}`, `@use ${context.args[1]}`)
        context.changes.push({ path, rel: 'consumer.other', before, after })
      })
    },
    verifyPlan(context) {
      const source = context.changes.find(change => change.rel === 'consumer.other')?.after
      if (source?.includes('@use broken'))
        context.regressions.push({ file: 'consumer.other', line: 1, col: 6, code: 1, message: 'Invalid binding' })
    },
  }
}
it('plans and verifies mixed script and custom grammar consumers before applying', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'engine-mixed-'))
  try {
    writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, module: 'ESNext', moduleResolution: 'bundler' }, include: ['*.ts', '*.vue'] }))
    writeFileSync(join(cwd, 'source.ts'), 'export const value = 42')
    writeFileSync(join(cwd, 'consumer.ts'), 'import { value } from \'./source\'; export const output = value')
    writeFileSync(join(cwd, 'consumer.other'), '@use value\n@use unrelated')
    writeFileSync(join(cwd, 'consumer.vue'), '<script setup lang="ts">import { value } from "./source"</script><template>{{ value }}</template>')
    const engine = createEngine({ extensions: [vue, otherExtension()] })
    expect(engine.scan('value', { cwd }).find(hit => hit.file === 'consumer.other')).toMatchObject({ line: 1, col: 6 })
    const failed = await engine.runRename('value', 'broken', { cwd })
    expect(failed.regressions.some(regression => regression.message === 'Invalid binding')).toBe(true)
    expect(() => engine.apply(failed)).toThrow(/Verification failed/)
    expect(readFileSync(join(cwd, 'consumer.other'), 'utf8')).toBe('@use value\n@use unrelated')
    const result = await engine.runRename('value', 'renamed', { cwd })
    expect(result.regressions).toEqual([])
    expect(result.changes.map(change => change.rel).sort()).toEqual(['consumer.other', 'consumer.ts', 'consumer.vue', 'source.ts'])
    expect(readFileSync(join(cwd, 'source.ts'), 'utf8')).toBe('export const value = 42')
    engine.apply(result)
    expect(readFileSync(join(cwd, 'consumer.other'), 'utf8')).toBe('@use renamed\n@use unrelated')
    expect(readFileSync(join(cwd, 'consumer.ts'), 'utf8')).toContain('renamed')
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
it('refuses overlapping suffixes and asynchronous setup before touching source', () => {
  const extension = { name: 'other', suffixes: ['.other'] }
  expect(() => createEngine({ extensions: [extension, { name: 'nested', suffixes: ['.nested.other'] }] })).toThrow(/ownership/)
  expect(() => createEngine({ extensions: [{ ...extension, async setup() {
  } }] })).toThrow(/synchronous/)
})
it('applies a file rename and consumer edits through one commit boundary', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'engine-file-'))
  try {
    writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, module: 'ESNext', moduleResolution: 'bundler' }, include: ['*.ts', '*.vue'] }))
    writeFileSync(join(cwd, 'source.ts'), 'export const value = 42')
    writeFileSync(join(cwd, 'consumer.ts'), 'import { value } from \'./source\'; export const output = value')
    const engine = createEngine()
    const result = await engine.runRenameFile('source.ts', 'renamed.ts', { cwd, verify: false })
    engine.apply(result)
    expect(readFileSync(join(cwd, 'renamed.ts'), 'utf8')).toBe('export const value = 42')
    expect(readFileSync(join(cwd, 'consumer.ts'), 'utf8')).toContain('./renamed')
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
it('refuses unsupported mutations and duplicate semantic ownership', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'engine-unsupported-'))
  try {
    writeFileSync(join(cwd, 'source.ts'), 'export const value = 1')
    writeFileSync(join(cwd, 'consumer.other'), '@use value')
    const engine = createEngine({ extensions: [{ name: 'other', suffixes: ['.other'] }] })
    await expect(engine.runRename('value', 'renamed', { cwd, verify: false })).rejects.toThrow(/does not support rename/)
    expect(readFileSync(join(cwd, 'source.ts'), 'utf8')).toBe('export const value = 1')
    expect(() => createEngine({ extensions: [
      { name: 'first', suffixes: ['.one'], semanticService: 'shared' },
      { name: 'second', suffixes: ['.two'], semanticService: 'shared' },
    ] })).toThrow(/semantic service ownership/)
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
it('verifies script changes introduced by plan hooks and blocks conflicting plans', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'engine-hook-'))
  try {
    writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, module: 'ESNext', moduleResolution: 'bundler' }, include: ['*.ts', '*.vue'] }))
    writeFileSync(join(cwd, 'source.ts'), 'export const value = 42')
    const extension: FrameworkAdapter = { name: 'hook', suffixes: ['.hook'], setup(hooks) {
      hooks.hook('operation:plan', (context) => {
        context.changes[0]!.after = 'export const renamed: string = 42'
      })
    } }
    const engine = createEngine({ extensions: [extension] })
    const result = await engine.runRename('value', 'renamed', { cwd })
    expect(result.regressions).toMatchObject([{ code: 2322 }])
    expect(() => engine.apply(result)).toThrow(/Verification failed/)
    const conflicting = createEngine({ extensions: [{ ...extension, setup(hooks) {
      hooks.hook('operation:plan', (context) => {
        context.changes.push({ ...context.changes[0]!, after: 'export const conflict = 0' })
      })
    } }] })
    await expect(conflicting.runRename('value', 'renamed', { cwd })).rejects.toThrow(/Duplicate extension plan/)
    expect(readFileSync(join(cwd, 'source.ts'), 'utf8')).toBe('export const value = 42')
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
