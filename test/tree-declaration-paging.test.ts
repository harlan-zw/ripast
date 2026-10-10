import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

const cli = resolve('packages/cli/src/cli.ts')
function tree(cwd: string, args: string[]) {
  return execFileSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, 'tree', ...args], { cwd, encoding: 'utf8' })
}

it('reports continuation when full text uses a byte target', () => {
  const source = Array.from({ length: 30 }, (_, index) => `export const value${index} = ${index}\n`).join('')
  const fixture = makeFixture(Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`file${index}.ts`, source])))
  try {
    const output = tree(fixture.dir, ['--profile', 'full', '--page-bytes', '1024'])
    assert.match(output, /total: 6, matched: 6, shown: 1, omitted: 5, offset: 0, nextOffset: 1/)
  }
  finally { fixture.cleanup() }
})

it('traverses every declaration in one large file without repeats or stalled pages', () => {
  const names = Array.from({ length: 200 }, (_, index) => `value${index}`)
  const fixture = makeFixture({ 'large.ts': names.map((name, index) => `export const ${name} = ${index}\n`).join('') })
  try {
    const visited: string[] = []
    let offset = 0
    for (let pageIndex = 0; pageIndex < 200; pageIndex++) {
      const output = tree(fixture.dir, ['--declarations', '--file', 'large.ts', '--json', '--offset', String(offset)])
      assert.ok(Buffer.byteLength(output) <= 4096)
      const page = JSON.parse(output).data
      assert.equal(page.total, 200)
      assert.equal(page.matched, 200)
      assert.ok(page.results.length > 0)
      assert.ok(page.results.every((declaration: { file: string }) => declaration.file === 'large.ts'))
      visited.push(...page.results.map((declaration: { name: string }) => declaration.name))
      if (page.nextOffset === undefined || page.nextOffset === null)
        break
      assert.ok(page.nextOffset > offset)
      offset = page.nextOffset
    }
    assert.deepEqual(visited, names)
  }
  finally { fixture.cleanup() }
})

it('filters declarations before paging and keeps complete grouped artifacts', () => {
  const fixture = makeFixture({ 'source.ts': 'const hidden = 1\nexport const first = hidden\nexport const second = first\n' })
  try {
    const output = tree(fixture.dir, ['--declarations', '--exports', 'exported', '--limit', '1', '--offset', '1', '--json', '--artifact', 'tree.json'])
    assert.deepEqual(JSON.parse(output).data.results.map((declaration: { name: string }) => declaration.name), ['second'])
    const artifact = JSON.parse(fixture.read('tree.json'))
    assert.deepEqual(artifact.files[0].declarations.map((declaration: { name: string }) => declaration.name), ['first', 'second'])
    const full = tree(fixture.dir, ['--declarations', '--exports', 'exported', '--json', '--profile', 'full'])
    assert.deepEqual(JSON.parse(full).data.results.map((declaration: { name: string }) => declaration.name), ['first', 'second'])
    const text = tree(fixture.dir, ['--declarations', '--exports', 'local', '--profile', 'agent'])
    assert.match(text, /source\.ts:1:7.*hidden/)
    assert.doesNotMatch(text, /first|second/)
  }
  finally { fixture.cleanup() }
})
