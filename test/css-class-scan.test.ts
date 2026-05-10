import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { formatAgentFileScanHits, formatFileScanHits, runCssClassFileScan, runCssClassScan } from '../packages/core/src/css-class-scan.ts'
import { makeFixture } from './helpers.ts'

describe('runCssClassScan', () => {
  it('counts bare tokens from string literals', async () => {
    const fx = makeFixture({
      'src/a.ts': `export const cls = 'bg-gray-500 text-white bg-gray-500'\n`,
    }, false)
    try {
      const hits = runCssClassScan({ cwd: fx.dir })
      const bg = hits.find(h => h.token === 'bg-gray-500')
      assert.ok(bg, 'bg-gray-500 present')
      assert.equal(bg!.count, 2)
      assert.deepEqual(bg!.files, ['src/a.ts'])
    }
    finally { fx.cleanup() }
  })

  it('strips variants and counts bare form', async () => {
    const fx = makeFixture({
      'src/a.ts': `export const cls = 'bg-gray-500 hover:bg-gray-500 dark:md:bg-gray-500'\n`,
    }, false)
    try {
      const hits = runCssClassScan({ cwd: fx.dir })
      const bg = hits.find(h => h.token === 'bg-gray-500')
      assert.equal(bg!.count, 3)
    }
    finally { fx.cleanup() }
  })

  it('strips important (!) prefix', async () => {
    const fx = makeFixture({
      'src/a.ts': `export const cls = 'bg-gray-500 hover:!bg-gray-500'\n`,
    }, false)
    try {
      const hits = runCssClassScan({ cwd: fx.dir })
      const bg = hits.find(h => h.token === 'bg-gray-500')
      assert.equal(bg!.count, 2)
    }
    finally { fx.cleanup() }
  })

  it('aggregates across files', async () => {
    const fx = makeFixture({
      'src/a.ts': `export const cls = 'bg-gray-500'\n`,
      'src/b.ts': `export const className = 'bg-gray-500 text-white'\n`,
    }, false)
    try {
      const hits = runCssClassScan({ cwd: fx.dir })
      const bg = hits.find(h => h.token === 'bg-gray-500')
      assert.equal(bg!.count, 2)
      assert.deepEqual(bg!.files, ['src/a.ts', 'src/b.ts'])
    }
    finally { fx.cleanup() }
  })

  it('filters with --pattern glob on bare token', async () => {
    const fx = makeFixture({
      'src/a.ts': `export const cls = 'bg-gray-500 text-white border-gray-200'\n`,
    }, false)
    try {
      const hits = runCssClassScan({ cwd: fx.dir, pattern: ['bg-*'] })
      assert.equal(hits.length, 1)
      assert.equal(hits[0].token, 'bg-gray-500')
    }
    finally { fx.cleanup() }
  })

  it('picks up Vue template class attrs', async () => {
    const fx = makeFixture({
      'src/c.vue': `<template><div class="bg-gray-500 hover:text-white">x</div></template>\n`,
    }, false)
    try {
      const hits = runCssClassScan({ cwd: fx.dir })
      assert.ok(hits.find(h => h.token === 'bg-gray-500'))
      assert.ok(hits.find(h => h.token === 'text-white'))
    }
    finally { fx.cleanup() }
  })

  it('picks up @apply in .css files', async () => {
    const fx = makeFixture({
      'src/x.css': `.btn { @apply bg-gray-500 hover:text-white; }\n`,
    }, false)
    try {
      const hits = runCssClassScan({ cwd: fx.dir })
      assert.ok(hits.find(h => h.token === 'bg-gray-500'))
      assert.ok(hits.find(h => h.token === 'text-white'))
    }
    finally { fx.cleanup() }
  })

  it('sorts by count desc then token asc', async () => {
    const fx = makeFixture({
      'src/a.ts': `export const cls = 'flex flex flex items-center'\n`,
    }, false)
    try {
      const hits = runCssClassScan({ cwd: fx.dir })
      assert.equal(hits[0].token, 'flex')
      assert.equal(hits[0].count, 3)
      assert.equal(hits[1].token, 'items-center')
    }
    finally { fx.cleanup() }
  })

  it('can sort by least used first', async () => {
    const fx = makeFixture({
      'src/a.ts': `export const cls = 'flex flex flex block block items-center'\n`,
    }, false)
    try {
      const hits = runCssClassScan({ cwd: fx.dir, sort: 'count-asc' })
      assert.deepEqual(hits.map(h => `${h.token}:${h.count}`), [
        'items-center:1',
        'block:2',
        'flex:3',
      ])
    }
    finally { fx.cleanup() }
  })

  it('can sort by token', async () => {
    const fx = makeFixture({
      'src/a.ts': `export const cls = 'flex block items-center'\n`,
    }, false)
    try {
      const hits = runCssClassScan({ cwd: fx.dir, sort: 'token' })
      assert.deepEqual(hits.map(h => h.token), ['block', 'flex', 'items-center'])
    }
    finally { fx.cleanup() }
  })

  it('can group by file and sort by unique token count', async () => {
    const fx = makeFixture({
      'src/a.ts': `export const cls = 'flex flex items-center text-sm'\n`,
      'src/b.ts': `export const cls = 'flex'\n`,
      'src/c.ts': `export const msg = 'not classes here'\n`,
    }, false)
    try {
      const hits = runCssClassFileScan({ cwd: fx.dir })
      assert.deepEqual(hits.map(h => `${h.file}:${h.unique}:${h.count}`), [
        'src/a.ts:3:4',
        'src/b.ts:1:1',
      ])
      assert.deepEqual(hits[0].tokens, ['flex', 'items-center', 'text-sm'])
    }
    finally { fx.cleanup() }
  })

  it('can group by file and sort by least unique first', async () => {
    const fx = makeFixture({
      'src/a.ts': `export const cls = 'flex items-center text-sm'\n`,
      'src/b.ts': `export const cls = 'flex'\n`,
    }, false)
    try {
      const hits = runCssClassFileScan({ cwd: fx.dir, sort: 'unique-asc' })
      assert.deepEqual(hits.map(h => h.file), ['src/b.ts', 'src/a.ts'])
    }
    finally { fx.cleanup() }
  })

  it('formats file grouped scan output', async () => {
    const hits = [
      { file: 'src/a.ts', unique: 3, count: 4, tokens: ['flex', 'items-center', 'text-sm'] },
      { file: 'src/b.ts', unique: 1, count: 1, tokens: ['flex'] },
    ]
    assert.match(formatFileScanHits(hits, false), /src\/a\.ts\s+3 unique\s+4 total/)
    assert.match(formatAgentFileScanHits(hits, 1), /^class-files files=2 top=1 format=file=unique\/total\nsrc\/a\.ts=3\/4\n\+1 more$/)
  })

  it('does not emit numbers or other non-class tokens', async () => {
    const fx = makeFixture({
      'src/a.ts': `export const x = 42\nexport const s = 'hello world 123'\nexport const cls = 'bg-gray-500'\n`,
    }, false)
    try {
      const hits = runCssClassScan({ cwd: fx.dir })
      assert.ok(!hits.some(h => h.token === '42'))
      assert.ok(!hits.some(h => h.token === '123'))
      assert.ok(!hits.some(h => h.token === 'hello'))
      assert.ok(!hits.some(h => h.token === 'world'))
      assert.ok(hits.find(h => h.token === 'bg-gray-500'))
    }
    finally { fx.cleanup() }
  })

  it('reads class helper arguments but not unrelated strings', async () => {
    const fx = makeFixture({
      'src/a.ts': `export const text = 'the Google default'\nexport const cls = cn('flex', active && 'text-sm', { 'items-center': active })\n`,
    }, false)
    try {
      const hits = runCssClassScan({ cwd: fx.dir })
      assert.ok(hits.find(h => h.token === 'flex'))
      assert.ok(hits.find(h => h.token === 'text-sm'))
      assert.ok(hits.find(h => h.token === 'items-center'))
      assert.ok(!hits.some(h => h.token === 'the'))
      assert.ok(!hits.some(h => h.token === 'Google'))
      assert.ok(!hits.some(h => h.token === 'default'))
    }
    finally { fx.cleanup() }
  })

  it('ignores non-source files matched by broad globs', async () => {
    const fx = makeFixture({
      'app/a.ts': `export const cls = 'flex'\n`,
      'app/data.json': `{ "label": "the Google default" }\n`,
      'layers/readme.md': `the Google default\n`,
    }, false)
    try {
      const hits = runCssClassScan({ cwd: fx.dir, glob: ['app/**', 'layers/**'] })
      assert.ok(hits.find(h => h.token === 'flex'))
      assert.ok(!hits.some(h => h.token === 'the'))
      assert.ok(!hits.some(h => h.token === 'Google'))
      assert.ok(!hits.some(h => h.token === 'default'))
    }
    finally { fx.cleanup() }
  })

  it('accepts arbitrary-value tokens', async () => {
    const fx = makeFixture({
      'src/a.ts': `export const cls = 'bg-[#ff0000] text-[14px]'\n`,
    }, false)
    try {
      const hits = runCssClassScan({ cwd: fx.dir })
      assert.ok(hits.find(h => h.token === 'bg-[#ff0000]'))
      assert.ok(hits.find(h => h.token === 'text-[14px]'))
    }
    finally { fx.cleanup() }
  })

  it('empty repo returns empty list', async () => {
    const fx = makeFixture({
      'src/a.ts': `export const x = 1\n`,
    }, false)
    try {
      const hits = runCssClassScan({ cwd: fx.dir })
      assert.equal(hits.length, 0)
    }
    finally { fx.cleanup() }
  })
})
