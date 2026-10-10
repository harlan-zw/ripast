import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { buildCheckChecklist, runCheck } from '../packages/cli/src/check.ts'
import { makeFixture } from './helpers.ts'

function project() {
  const fixture = makeFixture({
    'math.ts': 'export function absolute(value: number) { return value }',
    'consumer.ts': 'import { absolute as positive } from \'./math.js\'\nexport function format(value: number) { return "value:" + positive(value) }',
  })
  const git = (args: string[]) => execFileSync('git', args, { cwd: fixture.dir, encoding: 'utf8', stdio: 'pipe' })
  git(['init', '--quiet'])
  git(['add', '.'])
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'initial'])
  fixture.write('math.ts', 'export function absolute(value: number) { return value < 0 ? -value : value }')
  return fixture
}

describe('change checks', () => {
  it('automatically imports a named default function', async () => {
    const fixture = makeFixture({ 'math.ts': 'export default function absolute(value: number) { return Math.abs(value) }' })
    try {
      const run = await runCheck({ cwd: fixture.dir, symbol: 'absolute', source: 'test(\'default\', () => expect(absolute(-2)).toBe(2))' })
      expect(run._tag === 'Run' && run.result._tag).toBe('Passed')
    }
    finally { fixture.cleanup() }
  })
  it('reports real caller and callee execution while keeping integration review pending', async () => {
    const fixture = project()
    try {
      const run = await runCheck({ cwd: fixture.dir, base: 'HEAD', symbol: 'format', source: 'test(\'real caller\', () => expect(format(-2)).toBe(\'value:2\'))' })
      if (run._tag !== 'Run')
        throw new Error('Expected execution')
      expect(run.result._tag).toBe('Passed')
      expect(run.checklist?.items.find(item => item.kind === 'integration')).toMatchObject({ status: 'pending', execution: { caller: true, callee: true } })
    }
    finally { fixture.cleanup() }
  })
  it('does not credit a mocked callee with real execution', async () => {
    const fixture = project()
    try {
      const run = await runCheck({ cwd: fixture.dir, base: 'HEAD', symbol: 'format', source: 'vi.mock(\'./math.js\', () => ({ absolute: () => 9 }))\ntest(\'mock caller\', () => expect(format(-2)).toBe(\'value:9\'))' })
      if (run._tag !== 'Run')
        throw new Error('Expected execution')
      expect(run.result._tag, JSON.stringify(run.result)).toBe('Passed')
      expect(run.checklist?.items.find(item => item.kind === 'unit')?.status).toBe('pending')
      expect(run.checklist?.items.find(item => item.kind === 'integration')).toMatchObject({ status: 'pending', execution: { caller: true, callee: false } })
    }
    finally { fixture.cleanup() }
  })
  it('does not attribute a sibling function on the same line to the changed function', async () => {
    const fixture = project()
    try {
      fixture.write('math.ts', 'export function absolute(value: number) { return Math.abs(value) }; export function unused(value: number) { return value + 1 }')
      const run = await runCheck({ cwd: fixture.dir, base: 'HEAD', symbol: 'absolute', source: 'test(\'absolute\', () => expect(absolute(-2)).toBe(2))' })
      if (run._tag !== 'Run')
        throw new Error('Expected execution')
      expect(run.result._tag).toBe('Passed')
      expect(run.checklist?.items.find(item => item.symbol === 'unused')?.status).toBe('pending')
    }
    finally { fixture.cleanup() }
  })
  it('combines branch evidence across checks for unchanged code', async () => {
    const fixture = project()
    try {
      await runCheck({ cwd: fixture.dir, base: 'HEAD', symbol: 'absolute', source: 'test(\'negative\', () => expect(absolute(-3)).toBe(3))' })
      const run = await runCheck({ cwd: fixture.dir, base: 'HEAD', symbol: 'absolute', source: 'test(\'positive\', () => expect(absolute(3)).toBe(3))' })
      if (run._tag !== 'Run')
        throw new Error('Expected execution')
      expect(run.checklist?.items.find(item => item.kind === 'unit')?.uncoveredBranches).toBe(0)
    }
    finally { fixture.cleanup() }
  })
  it('finds changed exports and aliased callers without marking contracts complete', () => {
    const fixture = project()
    try {
      const checklist = buildCheckChecklist({ cwd: fixture.dir })
      expect(checklist.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'unit', file: 'math.ts', symbol: 'absolute', status: 'pending' }),
        expect.objectContaining({ kind: 'integration', file: 'consumer.ts', symbol: 'format', target: expect.objectContaining({ file: 'math.ts', symbol: 'absolute', line: 1 }), status: 'pending' }),
      ]))
    }
    finally { fixture.cleanup() }
  })
  it('resolves a unique export, records coverage, and invalidates evidence after edits', async () => {
    const fixture = project()
    try {
      const run = await runCheck({ cwd: fixture.dir, base: 'HEAD', symbol: 'absolute', source: 'test(\'negative\', () => expect(absolute(-3)).toBe(3))' })
      expect(run._tag).toBe('Run')
      if (run._tag !== 'Run')
        throw new Error('Expected execution')
      expect(run.result._tag, JSON.stringify(run.result)).toBe('Passed')
      expect(run.checklist?.items.find(item => item.kind === 'unit')).toMatchObject({ status: 'executed', uncoveredBranches: 1 })
      expect(run.checklist?.items.find(item => item.kind === 'integration')?.status).toBe('pending')
      fixture.write('consumer.ts', 'import { absolute } from \'./math.ts\'\nexport function format(value: number) { return String(absolute(value)) }')
      expect(buildCheckChecklist({ cwd: fixture.dir }).items.find(item => item.file === 'math.ts' && item.kind === 'unit')?.status).toBe('stale')
      expect(readdirSync(fixture.dir).filter(file => file.includes('inline') || file.includes('coverage'))).toEqual([])
    }
    finally { fixture.cleanup() }
  })
  it('keeps signature changes and removed exports pending', () => {
    const fixture = project()
    try {
      fixture.write('math.ts', 'export function absolute(value: string) { return Number(value) }')
      expect(buildCheckChecklist({ cwd: fixture.dir }).items).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'api', status: 'pending' }),
      ]))
      fixture.write('math.ts', 'export const replacement = 1')
      expect(buildCheckChecklist({ cwd: fixture.dir }).items).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'api', symbol: 'absolute', status: 'pending' }),
      ]))
    }
    finally { fixture.cleanup() }
  })
  it('requires --from for ambiguous exports', async () => {
    const fixture = project()
    try {
      fixture.write('duplicate.ts', 'export function absolute(value: number) { return Math.abs(value) }')
      await expect(runCheck({ cwd: fixture.dir, symbol: 'absolute', source: 'test()' })).rejects.toThrow('Pass --from')
      const report = await runCheck({ cwd: fixture.dir, from: 'duplicate.ts', symbol: 'absolute', source: 'test(\'positive\', () => expect(absolute(-1)).toBe(1))' })
      expect(report._tag === 'Run' && report.result._tag).toBe('Passed')
    }
    finally { fixture.cleanup() }
  })
  it('runs the CLI with compact JSON and a nonzero assertion failure exit code', () => {
    const fixture = project()
    try {
      const cli = resolve('packages/cli/src/cli.ts')
      const options = { cwd: fixture.dir, encoding: 'utf8' as const, input: 'test(\'negative\', () => expect(absolute(-2)).toBe(2))', stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] }
      const stdout = execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, 'check', 'absolute', '--json', '--base', 'HEAD'], options)
      expect(JSON.parse(stdout)).toMatchObject({ _tag: 'Result', command: 'check', data: { result: { _tag: 'Passed', counts: { passed: 1 }, tests: [] } } })
      expect(() => execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, 'check', 'absolute', '--json'], { ...options, input: 'test(\'wrong\', () => expect(absolute(-2)).toBe(9))' })).toThrow()
    }
    finally { fixture.cleanup() }
  })
})
