import { describe, expect, it } from 'vitest'
import { gradeFiles, makeCase, parseEvents, summarize } from '../evals/core.ts'

describe('openCode eval measurements', () => {
  it('counts cached input separately without counting the total twice', () => {
    const result = parseEvents([
      { type: 'step_finish', part: { tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 80, write: 10 } }, cost: 0.02 } },
      { type: 'step_finish', part: { tokens: { total: 40, input: 30, output: 10, reasoning: 0, cache: { read: 0, write: 0 } }, cost: 0.01 } },
    ].map(e => JSON.stringify(e)).join('\n'))
    expect(result.usage).toEqual({ input: 130, output: 30, reasoning: 5, cacheRead: 80, cacheWrite: 10, total: 255, cost: 0.03 })
  })

  it('reports malformed events and missing usage instead of reporting zero tokens', () => {
    const result = parseEvents('broken\n{"type":"text","part":{"text":"done"}}')
    expect(result.issues).toEqual(['Invalid JSON event on line 1', 'No token usage events'])
    expect(result.usage).toBeNull()
  })

  it('rejects usage totals that disagree with the token categories', () => {
    const result = parseEvents(JSON.stringify({ type: 'step_finish', part: { tokens: { total: -1, input: 10, output: 2, reasoning: 1, cache: { read: 5, write: 0 } } } }))
    expect(result.issues).toContain('Invalid token total')
    expect(result.usage).toBeNull()
  })

  it('rejects a renamed decoy even when the requested rename is correct', () => {
    const fixture = makeCase('rename', 3)
    const changed = { ...fixture.expected, 'src/decoy.ts': 'export function computeTotal(value: number) { return value * 7 }\n' }
    expect(gradeFiles(fixture.expected, changed)).toEqual(['Changed AST: src/decoy.ts'])
  })

  it('accepts equivalent formatting and rejects omitted files', () => {
    expect(gradeFiles({ 'a.ts': 'export const x = 1' }, { 'a.ts': '\nexport const x=1;\n' })).toEqual([])
    expect(gradeFiles({ 'a.ts': 'export const x = 1' }, {})).toEqual(['Missing file: a.ts'])
  })

  it('excludes failed runs from speed and token comparisons', () => {
    const rows = [
      { arm: 'ripide' as const, passed: true, seconds: 10, tokens: 100 },
      { arm: 'agent' as const, passed: true, seconds: 20, tokens: 400 },
      { arm: 'ripide' as const, passed: false, seconds: 1, tokens: 1 },
    ]
    expect(summarize(rows)).toEqual({ ripide: { passed: 1, runs: 2, seconds: 10, tokens: 100 }, agent: { passed: 1, runs: 1, seconds: 20, tokens: 400 }, speedup: 2, tokenReduction: 0.75 })
  })
})
