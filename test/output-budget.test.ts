import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { it } from 'vitest'
import { createTextOutput, renderBoundedOutput, selectOutput } from '../packages/cli/src/presentation/index.ts'

it('adapts pages to rendered bytes and traverses every result exactly once', () => {
  const items = Array.from({ length: 19 }, (_, index) => ({ index, text: '🦎'.repeat(200) }))
  const received: unknown[] = []
  let offset = 0
  while (offset < items.length) {
    const page = selectOutput(items, { limit: 40, offset, pageBytes: 4096 })
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096)
    assert.ok(page.shown > 0 && page.shown < 19)
    received.push(...page.results)
    offset = page.nextOffset ?? items.length
  }
  assert.deepEqual(received, items)
})

it('keeps one oversized item for progress and measures the selected representation', () => {
  const items = [{ name: 'first', text: 'x'.repeat(10000) }, { name: 'second', text: 'x'.repeat(10000) }]
  const page = selectOutput(items, { pageBytes: 1024 })
  assert.equal(page.shown, 1)
  assert.equal(page.nextOffset, 1)
  const narrow = selectOutput(items, { pageBytes: 1024, render: page => JSON.stringify({ ...page, results: page.results.map(item => ({ name: item.name })) }) })
  assert.equal(narrow.shown, 2)
  assert.equal(narrow.nextOffset, undefined)
  assert.equal(selectOutput(items, { limit: 0, pageBytes: 1024 }).shown, 0)
  assert.throws(() => selectOutput(items, { pageBytes: 0 }), /page/i)
})

it('bounds arbitrary JSON without cutting JSON or changing the outcome', () => {
  const input = { _tag: 'Refused', data: { results: ['x'.repeat(4000)] } }
  const result = renderBoundedOutput(input, {
    maxBytes: 1024,
    render: JSON.stringify,
    omitted: bytes => JSON.stringify({ _tag: input._tag, data: { omittedBytes: bytes } }),
  })
  assert.equal(JSON.parse(result)._tag, 'Refused')
  assert.ok(JSON.parse(result).data.omittedBytes > 4000)
  assert.ok(Buffer.byteLength(result) <= 1024)
  assert.equal(input.data.results[0].length, 4000)
})

it('passes complete results through unchanged and rejects an oversized fallback', () => {
  assert.equal(renderBoundedOutput([1, 2], { maxBytes: 1024, render: JSON.stringify, omitted: () => 'omitted' }), '[1,2]')
  assert.throws(() => renderBoundedOutput('x'.repeat(4000), { maxBytes: 1024, render: value => value, omitted: () => 'y'.repeat(2000) }), /fallback/i)
})

it('bounds cumulative text, keeps complete UTF-8 lines, and reports recovery', () => {
  let text = ''
  const output = createTextOutput({ maxBytes: 1024, write: chunk => text += chunk })
  output.write('Applied\n')
  for (let index = 0; index < 100; index++) output.write(`${index}: 🦎 ${'x'.repeat(40)}\n`)
  output.end()
  assert.ok(Buffer.byteLength(text) <= 1024)
  assert.match(text, /^Applied\n/)
  assert.doesNotMatch(text, /�/)
  assert.match(text, /omitted/)
  assert.match(text, /--max-bytes/)
})

it.each([0, 512, -1, 1024.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid output budget %s before writing', (maxBytes) => {
  const written: string[] = []
  assert.throws(() => createTextOutput({ maxBytes, write: chunk => written.push(chunk) }), /1024/)
  assert.deepEqual(written, [])
})
