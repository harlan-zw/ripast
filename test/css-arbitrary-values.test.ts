import { runCssClassRename, runCssClassScan } from '@ripast/core'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { makeFixture } from './helpers.ts'

describe('arbitrary class values', () => {
  it('scans and migrates quoted closing brackets in Vue', async () => {
    const token = 'content-[\']\']'
    const fx = makeFixture({ 'Page.vue': `<template><div class="before:${token}" /></template>` }, false)
    try {
      expect(runCssClassScan({ cwd: fx.dir })).toEqual([{ token, count: 1, files: ['Page.vue'] }])
      const result = await runCssClassRename(new Map([[token, 'new-token']]), { cwd: fx.dir })
      const { descriptor, errors } = parse(result.changes[0].after)
      expect(errors).toEqual([])
      const element = descriptor.template!.ast!.children[0] as any
      expect(element.props[0].value.content).toBe('before:new-token')
    }
    finally { fx.cleanup() }
  })

  it.each([
    'content-[\']\']',
    'content-[\'[\']',
    'content-["a]:b["]',
    String.raw`content-['\']:b[']`,
    String.raw`content-[\]]`,
    'bg-[url(image[1].png)]/50',
  ])('scans the complete value and agrees with rename for %s', async (token) => {
    const fx = makeFixture({ 'classes.js': `export const cls = String.raw\`hover:${token} flex\`` }, false)
    try {
      expect(runCssClassScan({ cwd: fx.dir, pattern: [token] })).toEqual([{ token, count: 1, files: ['classes.js'] }])
      const result = await runCssClassRename(new Map([[token, 'new-token']]), { cwd: fx.dir })
      const output = await import(`data:text/javascript,${encodeURIComponent(result.changes[0].after)}`)
      expect(output.cls).toBe('hover:new-token flex')
    }
    finally { fx.cleanup() }
  })

  it.each(['content-[broken', 'content-[\'broken]', 'content-[x]]', 'content-[x]junk'])('rejects malformed values: %s', (token) => {
    const fx = makeFixture({ 'classes.js': `export const cls = ${JSON.stringify(token)}` }, false)
    try {
      expect(runCssClassScan({ cwd: fx.dir })).toEqual([])
    }
    finally { fx.cleanup() }
  })
})
