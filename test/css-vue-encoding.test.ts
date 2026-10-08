import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { runCssClassRename, runCssClassScan } from '@ripast/core'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { makeFixture } from './helpers.ts'

function classValue(source: string): string {
  const { descriptor, errors } = parse(source)
  expect(errors).toEqual([])
  const element = descriptor.template!.ast!.children[0] as any
  return element.props.find((prop: any) => prop.name === 'class').value.content
}

describe.each(['"', '\''])('vue class attribute encoding with %s quotes', (quote) => {
  it.each(['content-["hi"]', 'content-[\'a&b\']', 'content-["&quot;<x>"]'])('preserves %s through SDK migration and roundtrip', async (replacement) => {
    const before = `<template><div class=${quote}flex old-token hover:old-token${quote} /></template>`
    const fx = makeFixture({ 'Page.vue': before }, false)
    try {
      const result = await runCssClassRename(new Map([['old-token', replacement]]), { cwd: fx.dir })
      const after = result.changes[0].after
      expect(classValue(after)).toBe(`flex ${replacement} hover:${replacement}`)
      expect(fx.read('Page.vue')).toBe(before)
      fx.write('Page.vue', after)
      expect(runCssClassScan({ cwd: fx.dir, pattern: [replacement] })).toEqual([{ token: replacement, count: 2, files: ['Page.vue'] }])
      expect((await runCssClassRename(new Map([['old-token', replacement]]), { cwd: fx.dir })).changes).toEqual([])
      const roundtrip = await runCssClassRename(new Map([[replacement, 'new-token']]), { cwd: fx.dir })
      expect(classValue(roundtrip.changes[0].after)).toBe('flex new-token hover:new-token')
    }
    finally { fx.cleanup() }
  })

  it.each(['content-["hi"]', 'content-[\'a&b\']', 'content-["&quot;<x>"]'])('preserves %s through CLI apply', (replacement) => {
    const fx = makeFixture({ 'Page.vue': `<template><div class=${quote}flex old-token hover:old-token${quote} /></template>` }, false)
    try {
      const result = spawnSync(process.execPath, [
        '--experimental-strip-types',
        '--no-warnings',
        resolve('packages/cli/src/cli.ts'),
        'css-class-rename',
        'old-token',
        replacement,
        '--apply',
        '--json',
      ], { cwd: fx.dir, encoding: 'utf8' })
      expect(result.error).toBeUndefined()
      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout).changes.map((change: { path: string }) => change.path)).toEqual(['Page.vue'])
      expect(classValue(fx.read('Page.vue'))).toBe(`flex ${replacement} hover:${replacement}`)
    }
    finally { fx.cleanup() }
  })
})
