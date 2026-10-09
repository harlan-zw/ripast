import { compileTemplate, parse } from '@vue/compiler-sfc'
import { runCssClassRename, runCssClassScan } from 'ripide-api'
import { describe, expect, it } from 'vitest'
import { makeFixture } from './helpers.ts'

const attributes = [
  ':class="active ? \'old-token\' : \'flex\'"',
  ':class=\'active ? "old-token" : "flex"\'',
  ':class="active ? &quot;old-token&quot; : &quot;flex&quot;"',
  ':class="active ? \'old&#45;token\' : \'flex\'"',
]

async function classValue(source: string, active: boolean): Promise<string> {
  const { descriptor, errors } = parse(source)
  expect(errors).toEqual([])
  const compiled = compileTemplate({ source: descriptor.template!.content, filename: 'Page.vue', id: 'dynamic-encoding' })
  expect(compiled.errors).toEqual([])
  const element = descriptor.template!.ast!.children[0] as any
  const expression = element.props.find((prop: any) => prop.arg?.content === 'class').exp.content
  const module = await import(`data:text/javascript,${encodeURIComponent(`const active = ${active}; export const cls = (${expression})`)}`)
  return module.cls
}

describe('vue dynamic class encoding', () => {
  it.each(['content-[`x`]', 'content-[' + '$' + '{x}]', 'tail\\'])('refuses unsafe raw template replacement %s', async (replacement) => {
    const before = '<template><div :class="active ? String.raw`old-token` : \'flex\'" /></template>'
    const fx = makeFixture({ 'Page.vue': before }, false)
    try {
      const result = await runCssClassRename(new Map([['old-token', replacement]]), { cwd: fx.dir })
      expect(result.changes).toEqual([])
      expect(fx.read('Page.vue')).toBe(before)
      expect(await classValue(fx.read('Page.vue'), true)).toBe('old-token')
      expect(await classValue(fx.read('Page.vue'), false)).toBe('flex')
    }
    finally { fx.cleanup() }
  })

  it.each(attributes)('preserves replacements through %s', async (attribute) => {
    const replacement = 'content-["a\'b&\\c"]'
    const before = `<template><div ${attribute} /></template>`
    const fx = makeFixture({ 'Page.vue': before }, false)
    try {
      expect(runCssClassScan({ cwd: fx.dir, pattern: ['old-token'] })).toEqual([{ token: 'old-token', count: 1, files: ['Page.vue'] }])
      const result = await runCssClassRename(new Map([['old-token', replacement]]), { cwd: fx.dir })
      expect(result.changes.map(c => c.rel)).toEqual(['Page.vue'])
      const after = result.changes[0].after
      expect(await classValue(after, true)).toBe(replacement)
      expect(await classValue(after, false)).toBe('flex')
      expect(fx.read('Page.vue')).toBe(before)
      fx.write('Page.vue', after)
      expect(runCssClassScan({ cwd: fx.dir, pattern: [replacement] })).toEqual([{ token: replacement, count: 1, files: ['Page.vue'] }])
      const roundtrip = await runCssClassRename(new Map([[replacement, 'new-token']]), { cwd: fx.dir })
      expect(await classValue(roundtrip.changes[0].after, true)).toBe('new-token')
    }
    finally { fx.cleanup() }
  })
})
