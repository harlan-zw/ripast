import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { Readable } from 'node:stream'
import { it } from 'vitest'
import { parsePageRequest, runEvidencePager } from '../packages/cli/src/evidence-pager.ts'

it('fits object menus and text pages using the complete emitted envelope', async () => {
  for (const input of [Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field${index}`, 'x'.repeat(70)])), 'x'.repeat(10000)]) {
    const responses: any[] = []
    const render = (value: any) => {
      if (typeof input === 'string')
        assert.equal(value.view.unit, 'text')
      return JSON.stringify({ command: 'page', padding: 'x'.repeat(300), data: value })
    }
    await runEvidencePager({ input: 'evidence.json', path: '', offset: 0, limit: 100, pageBytes: 2048, session: false }, {
      stdin: Readable.from([]),
      read: () => JSON.stringify(input),
      emit: value => responses.push(value),
      render,
    })
    assert.ok(responses[0].view.shown > 0)
    assert.ok(Buffer.byteLength(render(responses[0])) <= 2048)
    assert.ok(responses[0].view.nextOffset > 0)
  }
})

it('reads once and navigates immutable evidence without repeats or lost history', async () => {
  let text = JSON.stringify({ rows: [0, 1, 2, 3, 4] })
  let reads = 0
  const responses: { value: any, error?: boolean }[] = []
  await runEvidencePager({ input: 'evidence.json', path: '/rows', offset: 0, limit: 2, pageBytes: 4096, session: true }, {
    stdin: Readable.from([
      '{"_tag":"Next"}\n{"_tag":"Select","path":"/missing"}\n{"_tag":"Previous"}\n',
      'bad-json\n{"_tag":"Next"}\n{"_tag":"Select","path":"/rows","offset":4}\n{"_tag":"Next"}\n{"_tag":"Close"}\n{"_tag":"Previous"}\n',
    ]),
    read: () => {
      reads++
      return text
    },
    emit: (value, error) => {
      responses.push({ value, error })
      text = '{"rows":[99]}'
    },
    render: JSON.stringify,
  })
  assert.equal(reads, 1)
  const pages = responses.filter(response => response.value.view).map(response => response.value.view.results)
  assert.deepEqual(pages, [[0, 1], [2, 3], [0, 1], [2, 3], [4]])
  assert.equal(responses.filter(response => response.error).length, 3)
  assert.equal(responses.at(-1)?.value._tag, 'Closed')
  assert.equal(new Set(responses.map(response => response.value.source.sha256)).size, 1)
})

it('reads a single JSON document from stdin and narrows large object rows', async () => {
  const responses: any[] = []
  await runEvidencePager({ input: '-', path: '', offset: 0, limit: 40, pageBytes: 1024, session: false, fields: ['id'] }, {
    stdin: Readable.from([JSON.stringify(Array.from({ length: 20 }, (_, id) => ({ id, source: 'x'.repeat(10000) })))]),
    read: () => { throw new Error('Must use stdin') },
    emit: value => responses.push(value),
    render: JSON.stringify,
  })
  assert.deepEqual(responses[0].view.results, Array.from({ length: 20 }, (_, id) => ({ id })))
})

it('rejects malformed navigation and conflicting stdin use', async () => {
  for (const input of ['null', '[]', '{"_tag":"Run"}', '{"_tag":"Select","path":"","offset":-1}', 'x'.repeat(4097)])
    assert.equal(parsePageRequest(input)._tag, 'Err')
  await assert.rejects(runEvidencePager({ input: '-', path: '', offset: 0, limit: 40, pageBytes: 4096, session: true }, {
    stdin: Readable.from([]),
    read: () => '',
    emit: () => {},
    render: JSON.stringify,
  }), /stdin/i)
})
