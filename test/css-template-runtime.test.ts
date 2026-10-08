import { runCssClassRename, runCssClassScan } from '@ripast/core'
import { compileTemplate, parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { makeFixture } from './helpers.ts'

const replacement = 'content-["a\\b`' + '$' + '{x}&"]'

describe('class template runtime values', () => {
  it.each(['classes.js', 'classes.ts', 'Page.vue'])('preserves raw templates and refuses raw syntax replacement in %s', async (file) => {
    const script = String.raw`export const cls = String.raw\`old-token content-[\x]\``.replaceAll('\\`', '`')
    const before = file.endsWith('.vue') ? `<script>${script}</script><template><div /></template>` : script
    const fx = makeFixture({ [file]: before }, false)
    try {
      const result = await runCssClassRename(new Map([['old-token', String.raw`content-[\path]`]]), { cwd: fx.dir })
      const after = result.changes[0].after
      const outputScript = file.endsWith('.vue') ? parse(after).descriptor.script!.content : after
      const output = await import(`data:text/javascript,${encodeURIComponent(outputScript)}`)
      expect(output.cls).toBe(String.raw`content-[\path] content-[\x]`)
      expect((await runCssClassRename(new Map([['old-token', 'content-[`x`]']]), { cwd: fx.dir })).changes).toEqual([])
      expect(fx.read(file)).toBe(before)
    }
    finally { fx.cleanup() }
  })

  it.each(['classes.js', 'classes.ts', 'Page.vue'])('preserves delimiters and interpolation in %s', async (file) => {
    // eslint-disable-next-line no-template-curly-in-string
    const script = 'const middle = "flex"; export const cls = `old-token ${middle} old-token`'
    const before = file.endsWith('.vue') ? `<script>${script}</script><template><div /></template>` : script
    const fx = makeFixture({ [file]: before }, false)
    try {
      const result = await runCssClassRename(new Map([['old-token', replacement]]), { cwd: fx.dir })
      const after = result.changes[0].after
      const outputScript = file.endsWith('.vue') ? parse(after).descriptor.script!.content : after
      const output = await import(`data:text/javascript,${encodeURIComponent(outputScript)}`)
      expect(output.cls).toBe(`${replacement} flex ${replacement}`)
      expect(fx.read(file)).toBe(before)
      fx.write(file, after)
      expect(runCssClassScan({ cwd: fx.dir, pattern: [replacement] })).toEqual([{ token: replacement, count: 2, files: [file] }])
    }
    finally { fx.cleanup() }
  })

  it('preserves dynamic Vue templates through compilation and execution', async () => {
    // eslint-disable-next-line no-template-curly-in-string
    const fx = makeFixture({ 'Page.vue': '<template><div :class="`old-token ${middle} old-token`" /></template>' }, false)
    try {
      const result = await runCssClassRename(new Map([['old-token', replacement]]), { cwd: fx.dir })
      const { descriptor, errors } = parse(result.changes[0].after)
      expect(errors).toEqual([])
      expect(compileTemplate({ source: descriptor.template!.content, filename: 'Page.vue', id: 'templates' }).errors).toEqual([])
      const element = descriptor.template!.ast!.children[0] as any
      const expression = element.props[0].exp.content
      const output = await import(`data:text/javascript,${encodeURIComponent(`const middle = 'flex'; export const cls = (${expression})`)}`)
      expect(output.cls).toBe(`${replacement} flex ${replacement}`)
    }
    finally { fx.cleanup() }
  })
})
