import assert from 'node:assert/strict'
import { it } from 'vitest'
import { formatAgentDoctorReport, formatAgentHits, formatAgentInventory, outputPath, selectOutput } from '../packages/cli/src/presentation/index.ts'

it('agent inventory includes ordinary names and discloses omissions', () => {
  const components = Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, name: `Card${i}`, file: `/project/Card${i}.vue`, rel: `Card${i}.vue`, aliases: [], source: 'filesystem' as const, scope: 'global' as const, shadowed: false, kind: 'sfc' as const, registeredName: null }))
  const text = formatAgentInventory({ components, duplicates: [], shadowed: [] }, { limit: 2, offset: 1 })
  assert.match(text, /Card1/)
  assert.match(text, /Card2/)
  assert.doesNotMatch(text, /Card0|Card3/)
  assert.match(text, /omitted: 3/)
})
it('agent doctor samples each check before filling remaining capacity', () => {
  const report = { filesScanned: 100, findings: [...Array.from({ length: 59 }, (_, i) => ({ check: 'orphan-file', file: `a${i}.ts`, message: 'Unreachable file' })), { check: 'dangling-reexport', file: 'z.ts', message: 'Missing target' }] }
  const text = formatAgentDoctorReport(report, { limit: 2 })
  assert.match(text, /dangling-reexport z.ts: Missing target/)
  assert.match(text, /orphan-file/)
  assert.match(text, /omitted: 58/)
})
it('agent scan bounds displayed results and retains complete totals', () => {
  const hits = Array.from({ length: 6 }, (_, i) => ({ file: `file${i}.ts`, line: 1, col: 1, kind: 'identifier-binding', snippet: 'const value = 1' }))
  const text = formatAgentHits(hits, { limit: 2 })
  assert.match(text, /6 hits/)
  assert.match(text, /omitted: 4/)
  assert.doesNotMatch(text, /file5/)
})
it('selection returns a focused page without altering its input', () => {
  const input = [{ file: 'a.ts', code: 1 }, { file: 'b.ts', code: 2 }]
  assert.deepEqual(selectOutput(input, { file: 'b.ts', limit: 1 }, d => d.file), { total: 2, matched: 1, shown: 1, omitted: 0, offset: 0, results: [{ file: 'b.ts', code: 2 }] })
  assert.equal(input.length, 2)
  assert.equal(outputPath('/project/a.ts', '/project'), 'a.ts')
  assert.equal(outputPath('/external/a.ts', '/project'), '/external/a.ts')
})
