import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', resolve('packages/cli/src/cli.ts'), ...args, '--profile', 'full'], { cwd, encoding: 'utf8' })
}

it.each(['toString', 'constructor', '__proto__'])('discovery refuses inherited result field %s', (field) => {
  const fixture = makeFixture({ 'source.ts': 'export const value = 1\n' })
  try {
    const result = run(fixture.dir, ['scan', 'value', '--json', '--fields', field])
    assert.equal(result.status, 1)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload._tag, 'Error')
    assert.match(result.stdout, new RegExp(`Unknown result field: ${field}`))
  }
  finally { fixture.cleanup() }
})

it('full JSON filters diagnostics by relative file while keeping absolute diagnostic paths', () => {
  const source = 'export const value = 1\nexport const taken = 2\n'
  const fixture = makeFixture({ 'source.ts': source })
  try {
    const result = run(fixture.dir, ['rename', 'value', 'taken', '--no-vue', '--apply', '--json', '--file', 'source.ts'])
    assert.equal(result.status, 1, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload._tag, 'Refused')
    assert.ok(payload.data.regressions.length > 0)
    assert.ok(payload.data.regressions.every((diagnostic: { file: string }) => diagnostic.file === resolve(fixture.dir, 'source.ts')))
    assert.equal(fixture.read('source.ts'), source)
  }
  finally { fixture.cleanup() }
})

it.each([
  { args: ['scan', 'value'], total: 4 },
  { args: ['tree'], total: 4 },
  { args: ['doctor', '--checks', 'dangling-reexport'], total: 4 },
])('full text reports omissions for $args', ({ args, total }) => {
  const source = args[0] === 'doctor' ? 'export { missing } from \'./missing\'\n' : 'export const value = 1\n'
  const fixture = makeFixture(Object.fromEntries(Array.from({ length: total }, (_, index) => [`file${index}.ts`, source])))
  try {
    const result = run(fixture.dir, [...args, '--limit', '1', '--offset', '1'])
    assert.equal(result.status, args[0] === 'doctor' ? 1 : 0, result.stderr)
    assert.match(result.stdout, /total: 4, matched: 4, shown: 1, omitted: 3, offset: 1/)
    assert.match(result.stdout, /project total: 4/)
    assert.match(result.stdout, /file1\.ts/)
    assert.doesNotMatch(result.stdout, /file0\.ts|file2\.ts|file3\.ts/)
  }
  finally { fixture.cleanup() }
})

it('full text keeps the project finding count when the requested page is empty', () => {
  const fixture = makeFixture({ 'file.ts': 'export { missing } from \'./missing\'\n' })
  try {
    const result = run(fixture.dir, ['doctor', '--checks', 'dangling-reexport', '--limit', '0'])
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /project total: 1/)
    assert.match(result.stdout, /shown: 0, omitted: 1/)
    assert.match(result.stdout, /No findings on this page\./)
    assert.doesNotMatch(result.stdout, /doctor: no findings across/)
  }
  finally { fixture.cleanup() }
})
