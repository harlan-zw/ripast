/* eslint-disable no-template-curly-in-string -- These fixtures exercise template source, including its interpolation syntax. */
import { parse } from '@vue/compiler-sfc'
import { runCssClassRename, runCssClassScan } from 'ripide-api'
import { describe, expect, it } from 'vitest'
import { makeFixture } from './helpers.ts'

describe('class expression contexts', () => {
  it.each(['||', '??'])('preserves class object keys on the left of %s', async (operator) => {
    const fx = makeFixture({ 'Page.vue': `<template><div :class="[{ flex: mode === 'block' } ${operator} 'items-center']" /></template>` }, false)
    try {
      expect(runCssClassScan({ cwd: fx.dir, sort: 'token' }).map(h => h.token)).toEqual(['flex', 'items-center'])
      const result = await runCssClassRename(new Map([['flex', 'grid'], ['block', 'hidden']]), { cwd: fx.dir })
      const expression = (parse(result.changes[0].after).descriptor.template!.ast!.children[0] as any).props[0].exp.content
      const output = await import(`data:text/javascript,${encodeURIComponent(`const mode = 'block'; export const cls = (${expression})`)}`)
      expect(output.cls).toEqual([{ grid: true }])
    }
    finally { fx.cleanup() }
  })

  it('reads named class object variables without changing condition values', async () => {
    const fx = makeFixture({ 'classes.js': `const active = 'block'; export const cls = { flex: active === 'block' }` }, false)
    try {
      expect(runCssClassScan({ cwd: fx.dir }).map(h => h.token)).toEqual(['flex'])
      const result = await runCssClassRename(new Map([['flex', 'grid'], ['block', 'hidden']]), { cwd: fx.dir })
      const output = await import(`data:text/javascript,${encodeURIComponent(result.changes[0].after)}`)
      expect(output.cls).toEqual({ grid: true })
    }
    finally { fx.cleanup() }
  })

  it.each([
    { source: 'const suffix = "ible"; export const cls = `flex${suffix} block`', tokens: ['block'] },
    { source: 'const prefix = "in"; export const cls = `${prefix}flex block`', tokens: ['block'] },
    { source: 'export const cls = `p-${"flex"} block`', tokens: ['block', 'p-flex'] },
  ])('renames complete template classes while preserving partial tokens in $source', async ({ source, tokens }) => {
    const fx = makeFixture({ 'classes.js': source }, false)
    try {
      expect(runCssClassScan({ cwd: fx.dir }).map(h => h.token)).toEqual(tokens)
      const result = await runCssClassRename(new Map([['flex', 'grid'], ['block', 'hidden']]), { cwd: fx.dir })
      const before = await import(`data:text/javascript,${encodeURIComponent(source)}`)
      const after = await import(`data:text/javascript,${encodeURIComponent(result.changes[0].after)}`)
      expect(after.cls).toBe(before.cls.replace('block', 'hidden'))
    }
    finally { fx.cleanup() }
  })

  it('matches complete classes assembled from static template interpolations', async () => {
    const fx = makeFixture({ 'classes.js': 'export const cls = `flex${"ible"}`' }, false)
    try {
      expect(runCssClassScan({ cwd: fx.dir }).map(h => h.token)).toEqual(['flexible'])
      const result = await runCssClassRename(new Map([['flexible', 'grid']]), { cwd: fx.dir })
      const output = await import(`data:text/javascript,${encodeURIComponent(result.changes[0].after)}`)
      expect(output.cls).toBe('grid')
    }
    finally { fx.cleanup() }
  })

  it('preserves escaped bracket boundaries and adjacent important comments in CSS', async () => {
    const token = String.raw`content-[a\];b]`
    const fx = makeFixture({ 'app.css': `.example { @apply ${token} flex !important/* keep */; }` }, false)
    try {
      expect(runCssClassScan({ cwd: fx.dir, sort: 'token' }).map(h => h.token)).toEqual([token, 'flex'])
      const result = await runCssClassRename(new Map([[token, 'content-[safe]'], ['flex', 'grid'], ['important', 'hidden']]), { cwd: fx.dir })
      fx.write('app.css', result.changes[0].after)
      expect(runCssClassScan({ cwd: fx.dir, sort: 'token' }).map(h => h.token)).toEqual(['content-[safe]', 'grid'])
      expect(result.changes[0].after).toContain('!important/* keep */')
    }
    finally { fx.cleanup() }
  })

  it.each(['!important', ' !important', ' ! important', '!/* flag */important', '!IMPORTANT', ' !ImPoRtAnT'])('preserves attached or separated CSS important flag %s', async (flag) => {
    const fx = makeFixture({ 'app.css': `.example { @apply flex${flag}; }` }, false)
    try {
      expect(runCssClassScan({ cwd: fx.dir })).toEqual([{ token: 'flex', count: 1, files: ['app.css'] }])
      const result = await runCssClassRename(new Map([['flex', 'grid'], ['important', 'hidden']]), { cwd: fx.dir })
      fx.write('app.css', result.changes[0].after)
      expect(runCssClassScan({ cwd: fx.dir })).toEqual([{ token: 'grid', count: 1, files: ['app.css'] }])
      expect(result.changes[0].after).toContain(`@apply grid${flag};`)
    }
    finally { fx.cleanup() }
  })
})
