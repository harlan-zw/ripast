import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { rewriteClassString, runCssClassRename, runCssClassScan } from './engine-sdk.ts'
import { makeFixture } from './helpers.ts'

const rename = new Map([['old-token', 'new-token']])
const variants = [
  '[&[data-label=\']\']]:',
  '[&[data-label=\'[\']]:hover:',
  '[&[data-label="]"]]:',
  String.raw`[&[data-label='\']:[']]:`,
  String.raw`[&\]]:`,
]

describe('quoted arbitrary class variants', () => {
  it.each(variants)('scans and migrates JavaScript classes with %s', async (prefix) => {
    const before = `\uFEFF// 日本語 😀\r\nexport const cls = ${JSON.stringify(`${prefix}!old-token old-token`)}\r\n`
    const fx = makeFixture({ 'classes.js': before }, false)
    try {
      expect(runCssClassScan({ cwd: fx.dir })).toEqual([{ token: 'old-token', count: 2, files: ['classes.js'] }])
      const result = await runCssClassRename(rename, { cwd: fx.dir })
      const after = result.changes[0].after
      const output = await import(`data:text/javascript,${encodeURIComponent(after)}`)
      expect(output.cls).toBe(`${prefix}!new-token new-token`)
      expect(rewriteClassString(output.cls, rename)).toBe(output.cls)
      expect(after.startsWith('\uFEFF// 日本語 😀\r\n')).toBe(true)
      expect(after.endsWith('\r\n')).toBe(true)
      expect(readFileSync(join(fx.dir, 'classes.js'), 'utf8')).toBe(before)
    }
    finally { fx.cleanup() }
  })

  it.each(variants)('preserves Vue syntax and encoded input with %s', async (prefix) => {
    const before = `\uFEFF<template>\r\n<!-- 日本語 😀 -->\r\n<div class="${prefix.replaceAll('"', '&quot;')}old-token old-token" />\r\n</template>\r\n`
    const fx = makeFixture({ 'Page.vue': before }, false)
    try {
      expect(runCssClassScan({ cwd: fx.dir })).toEqual([{ token: 'old-token', count: 2, files: ['Page.vue'] }])
      const result = await runCssClassRename(rename, { cwd: fx.dir })
      const after = result.changes[0].after
      const { descriptor, errors } = parse(after)
      expect(errors).toEqual([])
      const element = descriptor.template!.ast!.children.find((node: any) => node.type === 1) as any
      expect(element.props[0].value.content).toBe(`${prefix}new-token new-token`)
      expect(after.slice(0, after.indexOf('<div'))).toBe(before.slice(0, before.indexOf('<div')))
      expect(after.slice(after.indexOf(' />'))).toBe(before.slice(before.indexOf(' />')))
      expect(readFileSync(join(fx.dir, 'Page.vue'), 'utf8')).toBe(before)
    }
    finally { fx.cleanup() }
  })
})
