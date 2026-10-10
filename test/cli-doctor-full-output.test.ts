import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

const source = 'export { missing } from \'./missing\'\n'
it.each([
  { apply: false, selection: ['--limit', '1', '--offset', '2'], path: 'file2.ts', matched: 5, omitted: 4, offset: 2 },
  { apply: true, selection: ['--limit', '1', '--offset', '2'], path: 'file2.ts', matched: 5, omitted: 4, offset: 2 },
  { apply: false, selection: ['--limit', '1', '--file', 'file3.ts'], path: 'file3.ts', matched: 1, omitted: 0, offset: 0 },
  { apply: true, selection: ['--limit', '1', '--file', 'file3.ts'], path: 'file3.ts', matched: 1, omitted: 0, offset: 0 },
])('full doctor fix display selection preserves the complete plan with apply=$apply and $selection', ({ apply, selection, path, matched, omitted, offset }) => {
  const fixture = makeFixture(Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`file${index}.ts`, source])))
  try {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', resolve('packages/cli/src/cli.ts'), 'doctor', '--checks', 'dangling-reexport', '--fix', '--json', '--profile', 'full', '--artifact', 'plan.json', ...selection, ...(apply ? ['--apply'] : [])], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const response = JSON.parse(result.stdout)
    assert.equal(response._tag, apply ? 'Applied' : 'Preview')
    assert.deepEqual(response.data.changes.map((change: { path: string }) => change.path), [path])
    assert.deepEqual(response.data.findings.map((finding: { file: string }) => finding.file), [path])
    assert.deepEqual(response.data.fix.fixed.map((finding: { file: string }) => finding.file), [path])
    assert.equal(response.data.fix.files, 5)
    for (const page of [response.data.changePage, response.data.findingPage, response.data.fixedPage])
      assert.deepEqual(page, { total: 5, matched, shown: 1, omitted, offset, ...(offset + 1 < matched ? { nextOffset: offset + 1 } : {}) })
    const artifact = JSON.parse(fixture.read('plan.json'))
    assert.equal(artifact.fix.changes.length, 5)
    assert.equal(artifact.fix.fixed.length, 5)
    assert.equal(artifact.report.findings.length, 5)
    for (let index = 0; index < 5; index++)
      assert.equal(fixture.read(`file${index}.ts`), apply ? '' : source)
  }
  finally { fixture.cleanup() }
})
