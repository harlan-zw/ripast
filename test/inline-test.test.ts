import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInlineTest } from '../packages/cli/src/test-runner.ts'
import { makeFixture } from './helpers.ts'

describe('inline tests', () => {
  it('loads a selected project configuration file', async () => {
    const fixture = makeFixture({
      'math.ts': 'export const add = (a: number, b: number) => a + b',
      'vitest.config.mjs': 'export default { test: { projects: [\'./vitest.one.config.mjs\', \'./vitest.two.config.mjs\'] } }',
      'vitest.one.config.mjs': 'export default { test: { name: \'one\' } }',
      'vitest.two.config.mjs': 'export default { test: { name: \'two\' } }',
    })
    try {
      const result = await runInlineTest({ cwd: fixture.dir, from: 'math.ts', symbol: 'add', project: 'two', source: 'test(\'sum\', () => expect(add(2, 3)).toBe(5))' })
      expect(result._tag, JSON.stringify(result)).toBe('Passed')
    }
    finally { fixture.cleanup() }
  })
  it('rejects a test with no assertions', async () => {
    const fixture = makeFixture({ 'math.ts': 'export const value = 1' })
    try {
      const result = await runInlineTest({ cwd: fixture.dir, from: 'math.ts', source: 'import { test } from \'vitest\'; test(\'empty assertion\', () => {})' })
      expect(result._tag).toBe('Failed')
    }
    finally { fixture.cleanup() }
  })
  it('automatically imports the subject and reports real branch coverage', async () => {
    const fixture = makeFixture({ 'math.ts': 'export function absolute(value: number) { return value < 0 ? -value : value }' })
    try {
      const result = await runInlineTest({ cwd: fixture.dir, from: 'math.ts', symbol: 'absolute', coverageFiles: ['math.ts'], source: 'test(\'negative\', () => expect(absolute(-3)).toBe(3))' })
      expect(result._tag, JSON.stringify(result)).toBe('Passed')
      expect(result.coverage).toEqual(expect.arrayContaining([expect.objectContaining({ file: 'math.ts', name: 'absolute', hits: 1 })]))
      expect(result.coverage[0].branches.flatMap(branch => branch.hits)).toContain(0)
    }
    finally { fixture.cleanup() }
  })
  it('injects the virtual module into a selected inline project', async () => {
    const fixture = makeFixture({ 'math.ts': 'export const add = (a: number, b: number) => a + b', 'vitest.config.mjs': 'export default { test: { projects: [{ test: { name: \'one\' } }, { test: { name: \'two\' } }] } }' })
    try {
      const result = await runInlineTest({ cwd: fixture.dir, from: 'math.ts', symbol: 'add', project: 'two', source: 'test(\'sum\', () => expect(add(2, 3)).toBe(5))' })
      expect(result._tag, JSON.stringify(result)).toBe('Passed')
    }
    finally { fixture.cleanup() }
  })
  it('runs TypeScript against real imports without a project Vitest installation or test file', async () => {
    const fixture = makeFixture({ 'src/math.ts': 'export const add = (a: number, b: number) => a + b' })
    try {
      const result = await runInlineTest({
        cwd: fixture.dir,
        from: 'src/math.ts',
        source: `import { test, expect } from 'vitest'
import { add } from './math.ts'
test('adds', () => { const value: number = add(2, 3); expect(value).toBe(5) })`,
      })
      expect(result._tag).toBe('Passed')
      if (result._tag !== 'Passed')
        throw new Error(JSON.stringify(result))
      expect(result.tests.map(test => [test.name, test.state])).toEqual([['adds', 'passed']])
      expect(readdirSync(join(fixture.dir, 'src'))).toEqual(['math.ts'])
    }
    finally { fixture.cleanup() }
  })

  it('hoists native Vitest mocks before the real dependency evaluates', async () => {
    const fixture = makeFixture({
      'src/dependency.ts': 'throw new Error("The real dependency must not run")\nexport const read = () => 1',
      'src/service.ts': 'import { read } from "./dependency.ts"\nexport const doubled = () => read() * 2',
    })
    try {
      const result = await runInlineTest({
        cwd: fixture.dir,
        from: 'src/service.ts',
        source: `import { test, expect, vi } from 'vitest'
import { doubled } from './service.ts'
const { read } = vi.hoisted(() => ({ read: vi.fn(() => 7) }))
vi.mock('./dependency.ts', () => ({ read }))
test('uses the dependency mock', () => { expect(doubled()).toBe(14); expect(read).toHaveBeenCalledOnce() })`,
      })
      expect(result._tag).toBe('Passed')
    }
    finally { fixture.cleanup() }
  })

  it('loads project aliases and setup files while running only the supplied module', async () => {
    const fixture = makeFixture({
      'src/math.ts': 'export const value = 42',
      'setup.ts': 'globalThis.inlineSetup = 9',
      'vitest.config.mjs': `export default { resolve: { alias: { '@math': new URL('./src/math.ts', import.meta.url).pathname } }, test: { include: ['other/**/*.test.ts'], setupFiles: ['./setup.ts'] } }`,
      'other/unrelated.test.ts': 'throw new Error("Do not discover unrelated tests")',
    })
    try {
      const result = await runInlineTest({
        cwd: fixture.dir,
        from: 'src/math.ts',
        source: `import { test, expect } from 'vitest'
import { value } from '@math'
test('uses project context', () => { expect(value).toBe(42); expect(globalThis.inlineSetup).toBe(9) })`,
      })
      expect(result._tag).toBe('Passed')
    }
    finally { fixture.cleanup() }
  })

  it('returns failed assertions with expected and actual values and a snippet location', async () => {
    const fixture = makeFixture({ 'math.ts': 'export const add = (a: number, b: number) => a + b' })
    try {
      const result = await runInlineTest({
        cwd: fixture.dir,
        from: 'math.ts',
        source: `import { test, expect } from 'vitest'
import { add } from './math.ts'
test('wrong sum', () => expect(add(2, 3)).toBe(6))`,
      })
      expect(result._tag).toBe('Failed')
      if (result._tag !== 'Failed')
        throw new Error(JSON.stringify(result))
      expect(result.tests[0].errors[0]).toMatchObject({ expected: '6', actual: '5', line: 3 })
    }
    finally { fixture.cleanup() }
  })

  it.each([
    ['empty suite', 'export const value = 1'],
    ['syntax error', 'import { test } from "vitest"; test('],
    ['missing import', 'import "./missing.ts"'],
  ])('reports a collection error for %s', async (_, source) => {
    const fixture = makeFixture({ 'math.ts': 'export const value = 1' })
    try {
      const result = await runInlineTest({ cwd: fixture.dir, from: 'math.ts', source })
      expect(result._tag).toBe('Error')
      if (result._tag !== 'Error')
        throw new Error(JSON.stringify(result))
      expect(result.phase).toBe('collect')
      expect(result.message.length).toBeGreaterThan(0)
    }
    finally { fixture.cleanup() }
  })

  it('rejects zero completed tests when the suite only skips tests', async () => {
    const fixture = makeFixture({ 'math.ts': 'export const value = 1' })
    try {
      const result = await runInlineTest({
        cwd: fixture.dir,
        from: 'math.ts',
        source: 'import { test } from "vitest"; test.skip("skipped", () => {})',
      })
      expect(result).toMatchObject({ _tag: 'Error', phase: 'execute' })
    }
    finally { fixture.cleanup() }
  })

  it('keeps test logs separate from results and bounds their size', async () => {
    const fixture = makeFixture({ 'math.ts': 'export const value = 1' })
    try {
      const result = await runInlineTest({
        cwd: fixture.dir,
        from: 'math.ts',
        source: `import { test, expect } from 'vitest'
test('logs', () => { console.log('x'.repeat(100000)); expect(1).toBe(1) })`,
      })
      expect(result._tag).toBe('Passed')
      expect(result.logs.stdout.length).toBeLessThanOrEqual(16384)
      expect(result.logs.truncated).toBe(true)
    }
    finally { fixture.cleanup() }
  })

  it('terminates an infinite synchronous loop at the parent deadline', async () => {
    const fixture = makeFixture({ 'math.ts': 'export const value = 1' })
    try {
      const result = await runInlineTest({
        cwd: fixture.dir,
        from: 'math.ts',
        timeoutMs: 1500,
        source: 'import { test } from "vitest"; test("loop", () => { while (true) {} })',
      })
      expect(result).toMatchObject({ _tag: 'TimedOut', timeoutMs: 1500 })
      expect(result.durationMs).toBeLessThan(10000)
    }
    finally { fixture.cleanup() }
  })

  it.each([
    { source: '' },
    { source: 'x'.repeat(1024 * 1024 + 1) },
    { source: 'test()', timeoutMs: -1 },
    { source: 'test()', timeoutMs: Number.NaN },
    { source: 'test()', testTimeoutMs: 0 },
  ])('rejects invalid input before starting a worker: %#', async (input) => {
    const fixture = makeFixture({ 'math.ts': 'export const value = 1' })
    try {
      expect(await runInlineTest({ cwd: fixture.dir, from: 'math.ts', ...input }))
        .toMatchObject({ _tag: 'Error', phase: 'input' })
    }
    finally { fixture.cleanup() }
  })
})
