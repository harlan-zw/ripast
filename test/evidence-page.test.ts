import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { it } from 'vitest'
import { inspectEvidence } from '../packages/cli/src/presentation/evidence.ts'

it('discovers collections and objects without dumping their nested contents', () => {
  const result = inspectEvidence({ _tag: 'Applied', changes: [{ before: 'x'.repeat(5000) }], verification: { checker: 'typescript' }, count: 1, empty: null })
  assert.deepEqual(result, { _tag: 'Ok', value: { _tag: 'Object', path: '', total: 5, matched: 5, shown: 5, omitted: 0, offset: 0, values: { _tag: 'Applied', count: 1, empty: null }, omittedValues: [], collections: [{ path: '/changes', total: 1 }], objects: ['/verification'] } })
})

it('traverses arbitrary object keys and array items using JSON Pointer escapes', () => {
  const evidence = JSON.parse('{"":{"a/b":{"~key":[{"__proto__":"safe"}]}}}')
  assert.deepEqual(inspectEvidence(evidence, '//a~1b/~0key/0/__proto__'), { _tag: 'Ok', value: { _tag: 'Value', path: '//a~1b/~0key/0/__proto__', value: 'safe' } })
  assert.deepEqual(inspectEvidence(evidence, '/'), { _tag: 'Ok', value: { _tag: 'Object', path: '/', total: 1, matched: 1, shown: 1, omitted: 0, offset: 0, values: {}, omittedValues: [], collections: [], objects: ['//a~1b'] } })
})

it('pages complete collections under the byte target without changing saved evidence', () => {
  const input = { results: Array.from({ length: 30 }, (_, index) => ({ index, text: `🦎${'x'.repeat(140)}` })) }
  const snapshot = structuredClone(input)
  const seen: number[] = []
  let offset = 0
  for (let pageIndex = 0; pageIndex < 30; pageIndex++) {
    const result = inspectEvidence(input, '/results', { offset, pageBytes: 1024 })
    assert.equal(result._tag, 'Ok')
    if (result._tag !== 'Ok' || result.value._tag !== 'Collection')
      assert.fail('Expected a collection page.')
    assert.ok(Buffer.byteLength(JSON.stringify(result.value)) <= 1024)
    seen.push(...result.value.results.map(item => (item as { index: number }).index))
    if (result.value.nextOffset === undefined)
      break
    assert.ok(result.value.nextOffset > offset)
    offset = result.value.nextOffset
  }
  assert.deepEqual(seen, Array.from({ length: 30 }, (_, index) => index))
  assert.deepEqual(input, snapshot)
})

it('keeps one oversized array item to advance and supports zero and empty pages', () => {
  const input = ['x'.repeat(5000), 'next']
  const first = inspectEvidence(input, '', { pageBytes: 1024 })
  assert.equal(first._tag, 'Ok')
  if (first._tag !== 'Ok' || first.value._tag !== 'Collection')
    assert.fail('Expected a collection page.')
  assert.deepEqual(first.value.results, [input[0]])
  assert.equal(first.value.nextOffset, 1)
  assert.deepEqual(inspectEvidence([], '')._tag, 'Ok')
  const zero = inspectEvidence(input, '', { limit: 0 })
  assert.equal(zero._tag, 'Ok')
  if (zero._tag === 'Ok' && zero.value._tag === 'Collection')
    assert.deepEqual(zero.value.results, [])
})

it.each(['relative', '/bad~escape', '/bad~2escape', '/results/01', '/results/-', '/results/4', '/results/length', '/missing', '/scalar/child', '/toString'])('returns an actionable error for invalid or missing pointer %s', (path) => {
  const result = inspectEvidence({ results: [1], scalar: false }, path)
  assert.equal(result._tag, 'Err')
  if (result._tag === 'Err')
    assert.ok(result.message.length > 0)
})

it('preserves prototype-named scalar keys when inspecting JSON objects', () => {
  const input = JSON.parse('{"__proto__":"value","constructor":12,"a/b":[],"~":{}}')
  const result = inspectEvidence(input)
  assert.equal(result._tag, 'Ok')
  if (result._tag !== 'Ok' || result.value._tag !== 'Object')
    assert.fail('Expected an object inspection.')
  assert.equal(Object.hasOwn(result.value.values, '__proto__'), true)
  assert.equal(Object.getOwnPropertyDescriptor(result.value.values, '__proto__')?.value, 'value')
  assert.deepEqual(result.value.collections, [{ path: '/a~1b', total: 0 }])
  assert.deepEqual(result.value.objects, ['/~0'])
})

it('keeps change metadata and scalar paths when source strings exceed the menu budget', () => {
  const input = { before: '🦎'.repeat(10000), after: 'x'.repeat(50000), file: 'source.ts', count: 2 }
  const result = inspectEvidence(input)
  assert.equal(result._tag, 'Ok')
  if (result._tag !== 'Ok' || result.value._tag !== 'Object')
    assert.fail('Expected an object inspection.')
  assert.deepEqual(result.value.values, { file: 'source.ts', count: 2 })
  assert.deepEqual(result.value.omittedValues, [{ path: '/before', bytes: 40000 }, { path: '/after', bytes: 50000 }])
  assert.ok(Buffer.byteLength(JSON.stringify(result.value)) <= 4096)
  const source = inspectEvidence(input, '/before')
  if (source._tag !== 'Ok' || source.value._tag !== 'Collection')
    assert.fail('Expected a text collection.')
  assert.equal(source.value.unit, 'text')
  assert.equal((source.value.results[0] as { text: string }).text, '🦎'.repeat(128))
})

it('traverses every immediate child of a large object with advancing offsets', () => {
  const input = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`item/${index}`, index]))
  const snapshot = structuredClone(input)
  const seen: string[] = []
  let offset = 0
  for (let pageIndex = 0; pageIndex < 500; pageIndex++) {
    const result = inspectEvidence(input, '', { offset, pageBytes: 1024 })
    if (result._tag !== 'Ok' || result.value._tag !== 'Object')
      assert.fail('Expected an object inspection.')
    assert.equal(result.value.total, 500)
    assert.ok(result.value.shown > 0)
    assert.ok(Buffer.byteLength(JSON.stringify(result.value)) <= 1024)
    seen.push(...Object.keys(result.value.values))
    if (result.value.nextOffset === undefined)
      break
    assert.ok(result.value.nextOffset > offset)
    offset = result.value.nextOffset
  }
  assert.deepEqual(seen, Object.keys(input))
  assert.deepEqual(input, snapshot)
})

it('applies the scalar preview threshold in UTF-8 bytes and pages mixed child kinds', () => {
  const input = { short: '🦎'.repeat(64), long: '🦎'.repeat(65), array: [1, 2], object: { nested: true } }
  const first = inspectEvidence(input, '', { limit: 1 })
  if (first._tag !== 'Ok' || first.value._tag !== 'Object')
    assert.fail('Expected an object inspection.')
  assert.deepEqual(first.value.values, { short: input.short })
  assert.equal(first.value.nextOffset, 1)
  const second = inspectEvidence(input, '', { offset: 1, limit: 1 })
  if (second._tag !== 'Ok' || second.value._tag !== 'Object')
    assert.fail('Expected an object inspection.')
  assert.deepEqual(second.value.omittedValues, [{ path: '/long', bytes: 260 }])
  assert.equal(second.value.nextOffset, 2)
  const third = inspectEvidence(input, '', { offset: 2, limit: 1 })
  if (third._tag !== 'Ok' || third.value._tag !== 'Object')
    assert.fail('Expected an object inspection.')
  assert.deepEqual(third.value.collections, [{ path: '/array', total: 2 }])
  assert.equal(third.value.nextOffset, 3)
  const fourth = inspectEvidence(input, '', { offset: 3, limit: 1 })
  if (fourth._tag !== 'Ok' || fourth.value._tag !== 'Object')
    assert.fail('Expected an object inspection.')
  assert.deepEqual(fourth.value.objects, ['/object'])
  assert.equal(fourth.value.nextOffset, undefined)
})

it('reconstructs long Unicode source strings across bounded text pages', () => {
  const text = `${'🦎\\"'.repeat(1200)}\r\nsecond line\n${'x'.repeat(5000)}\n`
  const evidence = { before: text }
  const seen: { line: number, part: number, text: string }[] = []
  let offset = 0
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const result = inspectEvidence(evidence, '/before', { offset })
    if (result._tag !== 'Ok' || result.value._tag !== 'Collection')
      assert.fail('Expected source text fragments.')
    assert.equal(result.value.unit, 'text')
    assert.ok(Buffer.byteLength(JSON.stringify(result.value)) <= 4096)
    const rows = result.value.results as { line: number, part: number, text: string }[]
    assert.ok(rows.length > 0)
    assert.ok(rows.every(row => Buffer.byteLength(row.text) <= 512 && !row.text.includes('�')))
    seen.push(...rows)
    if (result.value.nextOffset === undefined)
      break
    assert.ok(result.value.nextOffset > offset)
    offset = result.value.nextOffset
  }
  assert.equal(seen.map(row => row.text).join(''), text)
  assert.equal(evidence.before, text)
  assert.equal(seen[0].line, 1)
  assert.equal(seen[0].part, 1)
  assert.ok(seen.filter(row => row.line === 1).every((row, index) => row.part === index + 1))
  assert.deepEqual(seen.find(row => row.line === 2), { line: 2, part: 1, text: 'second line\n' })
  assert.ok(seen.filter(row => row.line === 3).every((row, index) => row.part === index + 1))
})
