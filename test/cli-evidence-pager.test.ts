import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

const cli = resolve('packages/cli/src/cli.ts')
function run(cwd: string, args: string[], input?: string) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], { cwd, encoding: 'utf8', input })
}

it('uses stdin JSON and emits bounded machine responses without requiring --json', () => {
  const result = run(process.cwd(), ['page', '--input', '-', '--fields', 'id'], JSON.stringify(Array.from({ length: 70 }, (_, id) => ({ id, body: 'x'.repeat(10000) }))))
  assert.equal(result.status, 0, result.stderr)
  assert.ok(Buffer.byteLength(result.stdout) <= 4096)
  const page = JSON.parse(result.stdout)
  assert.equal(page._tag, 'Result')
  assert.equal(page.data.view.shown, 40)
  assert.equal(page.data.view.nextOffset, 40)
  assert.deepEqual(page.data.view.results[0], { id: 0 })
  const invalid = run(process.cwd(), ['page', '--input', '-'], 'bad-json')
  assert.equal(invalid.status, 1)
  assert.equal(JSON.parse(invalid.stdout)._tag, 'Error')
})

it('pages a real tree artifact through an NDJSON session without another scan', () => {
  const fixture = makeFixture({ 'large.ts': Array.from({ length: 200 }, (_, index) => `export const value${index} = ${index}\n`).join('') })
  try {
    const initial = run(fixture.dir, ['tree', '--json', '--artifact', 'tree.json'])
    assert.equal(initial.status, 0, initial.stderr)
    const result = run(fixture.dir, ['page', '--input', 'tree.json', '--session', '--limit', '2'], [
      '{"_tag":"Select","path":"/files/0/declarations"}',
      '{"_tag":"Next"}',
      '{"_tag":"Previous"}',
      '{"_tag":"Close"}',
      '',
    ].join('\n'))
    assert.equal(result.status, 0, result.stderr)
    const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(responses.length, 5)
    assert.ok(responses.every(response => response._tag === 'Result'))
    assert.deepEqual(responses[0].data.view.collections, [{ path: '/files', total: 1 }])
    assert.deepEqual(responses.slice(1, 4).map(response => response.data.view.results.map((row: { name: string }) => row.name)), [
      ['value0', 'value1'],
      ['value2', 'value3'],
      ['value0', 'value1'],
    ])
    assert.equal(responses[4].data._tag, 'Closed')
    assert.ok(result.stdout.trim().split('\n').every(line => Buffer.byteLength(`${line}\n`) <= 4096))
  }
  finally { fixture.cleanup() }
})

it('mutation evidence preserves source and exposes large before/after paths', () => {
  const fixture = makeFixture({ 'source.ts': `export const classes = "${'old-token '.repeat(1000)}"\n` })
  try {
    const mutation = run(fixture.dir, ['css-class-rename', 'old-token', 'new-token', '--apply', '--json', '--artifact', 'mutation.json'])
    assert.equal(mutation.status, 0, mutation.stderr)
    assert.equal(JSON.parse(mutation.stdout)._tag, 'Applied')
    const applied = fixture.read('source.ts')
    const result = run(fixture.dir, ['page', '--input', 'mutation.json', '--path', '/changes/0'])
    assert.equal(result.status, 0, result.stderr)
    const view = JSON.parse(result.stdout).data.view
    assert.deepEqual(view.omittedValues.map((value: { path: string }) => value.path), ['/changes/0/before', '/changes/0/after'])
    assert.equal(fixture.read('source.ts'), applied)
    assert.match(JSON.parse(fixture.read('mutation.json')).changes[0].before, /old-token/)
    assert.match(applied, /new-token/)
  }
  finally { fixture.cleanup() }
})

it('request errors preserve navigation and conflicting stdin use refuses cleanly', () => {
  const fixture = makeFixture({ 'evidence.json': '[0,1,2,3]' })
  try {
    const result = run(fixture.dir, ['page', '--input', 'evidence.json', '--session', '--limit', '2'], 'bad-json\n{"_tag":"Next"}\n{"_tag":"Close"}\n')
    assert.equal(result.status, 0, result.stderr)
    const responses = result.stdout.trim().split('\n').map(line => JSON.parse(line))
    assert.equal(responses[1]._tag, 'Error')
    assert.deepEqual(responses[2].data.view.results, [2, 3])
    const invalid = run(fixture.dir, ['page', '--input', '-', '--session'], '[]')
    assert.equal(invalid.status, 1)
    assert.equal(JSON.parse(invalid.stdout)._tag, 'Error')
  }
  finally { fixture.cleanup() }
})

it.each([
  { content: 'bad-json', path: '' },
  { content: '{}', path: '/missing' },
])('session startup failures exit nonzero: $path $content', ({ content, path }) => {
  const fixture = makeFixture({ 'evidence.json': content })
  try {
    const result = run(fixture.dir, ['page', '--input', 'evidence.json', '--session', ...(path ? ['--path', path] : [])], '{"_tag":"Close"}\n')
    assert.equal(result.status, 1)
    assert.equal(JSON.parse(result.stdout)._tag, 'Error')
  }
  finally { fixture.cleanup() }
})

it('accepts an explicit empty JSON Pointer for the root', () => {
  const result = run(process.cwd(), ['page', '--input', '-', '--path', ''], '[1,2]')
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout).data.view.results, [1, 2])
})
