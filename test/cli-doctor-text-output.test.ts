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
])('full text doctor fix pages display without narrowing writes with apply=$apply and $selection', ({ apply, selection, path, matched, omitted, offset }) => {
  const fixture = makeFixture(Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`file${index}.ts`, source])))
  try {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', resolve('packages/cli/src/cli.ts'), 'doctor', '--checks', 'dangling-reexport', '--fix', '--profile', 'full', ...selection, ...(apply ? ['--apply'] : [])], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.ok(result.stdout.includes(apply ? `wrote ${path}` : `Index: ${path}`), result.stdout)
    for (let index = 0; index < 5; index++) {
      const file = `file${index}.ts`
      if (file !== path)
        assert.ok(!result.stdout.includes(file), result.stdout)
      assert.equal(fixture.read(file), apply ? '' : source)
    }
    assert.ok(result.stdout.includes(`total: 5, matched: ${matched}, shown: 1, omitted: ${omitted}, offset: ${offset}`), result.stdout)
  }
  finally { fixture.cleanup() }
})

it('pages non-fixable findings without hiding the complete finding count', () => {
  const source = 'export const unused = 1\n'
  const fixture = makeFixture({ 'file0.ts': source, 'file1.ts': source, 'file2.ts': source })
  try {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', resolve('packages/cli/src/cli.ts'), 'doctor', '--checks', 'orphan-file', '--fix', '--profile', 'full', '--limit', '1', '--offset', '1'], { cwd: fixture.dir, encoding: 'utf8' })
    assert.equal(result.status, 1, result.stderr)
    assert.ok(result.stdout.includes('file1.ts'), result.stdout)
    assert.ok(!result.stdout.includes('file0.ts'), result.stdout)
    assert.ok(!result.stdout.includes('file2.ts'), result.stdout)
    assert.ok(result.stdout.includes('0 fixable / 3 non-fixable findings'), result.stdout)
    assert.ok(result.stdout.includes('total: 3, matched: 3, shown: 1, omitted: 2, offset: 1'), result.stdout)
    for (let index = 0; index < 3; index++)
      assert.equal(fixture.read(`file${index}.ts`), source)
  }
  finally { fixture.cleanup() }
})
