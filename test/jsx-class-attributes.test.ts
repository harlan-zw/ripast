import type { Fixture } from './helpers.ts'
import { parse } from '@vue/compiler-sfc'
import { describe, expect, it } from 'vitest'
import { runCssClassRename, runCssClassScan, writeChanges } from '../packages/core/src/index.ts'
import { makeReactFixture, reactDiagnostics, renderReactFixture } from './react-helpers.ts'
import { assertSolidDiagnostics, makeSolidFixture, renderSolidFixture } from './solid-helpers.ts'

const frameworks = [
  {
    name: 'React',
    attribute: 'className',
    file: 'src/View.tsx',
    make: () => makeReactFixture({}),
    source: (attribute: string) => `export function View() { return <div className=${attribute} /> }`,
    check: (fx: Fixture) => expect(reactDiagnostics(fx)).toEqual([]),
    render: (fx: Fixture) => renderReactFixture(fx, 'src/View.tsx'),
  },
  {
    name: 'Solid',
    attribute: 'class',
    file: 'src/App.tsx',
    make: makeSolidFixture,
    source: (attribute: string) => `export function App() { return <div class=${attribute} /> }`,
    check: assertSolidDiagnostics,
    render: renderSolidFixture,
  },
]

function renderedClass(markup: string): string {
  const element = parse(`<template>${markup}</template>`).descriptor.template!.ast!.children.find((node: any) => node.type === 1) as any
  return element.props.find((prop: any) => prop.name === 'class').value.content
}

const literalCases = [
  { name: 'decimal entity', attribute: '"&#102;lex"', before: 'flex', after: 'grid' },
  { name: 'hexadecimal entity', attribute: '"&#x66;lex"', before: 'flex', after: 'grid' },
  { name: 'named entity', attribute: '"content-[&eacute;]"', before: 'content-[é]', after: 'content-[ø]' },
  { name: 'apostrophe entities', attribute: '"content-[&apos;a&apos;]"', before: 'content-[\'a\']', after: 'content-[\'b\']' },
  { name: 'numeric control characters without HTML remapping', attribute: '"content-[&#128;]"', before: 'content-[\u0080]', after: 'content-[changed]' },
  { name: 'supplementary code points', attribute: '"content-[&#x1f600;]"', before: 'content-[😀]', after: 'content-[😃]' },
  { name: 'one entity decoding pass', attribute: '"content-[&quot;&amp;quot;&quot;]"', before: 'content-["&quot;"]', after: 'content-["&amp;"]' },
  { name: 'double quotes, ampersands, and backslashes', attribute: String.raw`"content-[&quot;a&amp;b\c&quot;]"`, before: String.raw`content-["a&b\c"]`, after: String.raw`content-["x&y\z"]` },
  { name: 'single quotes', attribute: `'flex'`, before: 'flex', after: `content-['x&y']` },
]

describe.each(frameworks)('$name JSX class attributes', (framework) => {
  it.each(literalCases)('scans and renames $name using rendered values', async ({ attribute, before, after }) => {
    const fx = framework.make()
    try {
      fx.write(framework.file, framework.source(attribute))
      framework.check(fx)
      expect(renderedClass(framework.render(fx))).toBe(before)
      expect(runCssClassScan({ cwd: fx.dir, glob: framework.file })).toEqual([{ token: before, count: 1, files: [framework.file] }])
      const result = await runCssClassRename(new Map([[before, after]]), { cwd: fx.dir, glob: framework.file })
      expect(result.changes).toHaveLength(1)
      writeChanges(result.changes)
      framework.check(fx)
      expect(renderedClass(framework.render(fx))).toBe(after)
      expect(runCssClassScan({ cwd: fx.dir, glob: framework.file })).toEqual([{ token: after, count: 1, files: [framework.file] }])
    }
    finally { fx.cleanup() }
  })

  it.each(['&NotEqualTilde;', '&AMP;', '&amp', '&#102', '&#x;'])('preserves undecoded JSX entity %s when another class changes', async (entity) => {
    const fx = framework.make()
    const preserved = `content-["${entity}"]`
    try {
      fx.write(framework.file, framework.source(`"content-[&quot;${entity}&quot;] flex"`))
      framework.check(fx)
      expect(renderedClass(framework.render(fx))).toBe(`${preserved} flex`)
      expect(runCssClassScan({ cwd: fx.dir, glob: framework.file, sort: 'token' }).map(hit => hit.token)).toEqual([preserved, 'flex'])
      writeChanges((await runCssClassRename(new Map([['flex', 'grid']]), { cwd: fx.dir, glob: framework.file })).changes)
      framework.check(fx)
      expect(renderedClass(framework.render(fx))).toBe(`${preserved} grid`)
    }
    finally { fx.cleanup() }
  })

  it('keeps JavaScript string semantics inside JSX expressions', async () => {
    const fx = framework.make()
    const before = String.raw`content-["&quot;\a"]`
    const after = String.raw`content-["&amp;\b"]`
    try {
      fx.write(framework.file, framework.source(`{${JSON.stringify(before)}}`))
      framework.check(fx)
      expect(renderedClass(framework.render(fx))).toBe(before)
      expect(runCssClassScan({ cwd: fx.dir, glob: framework.file }).map(hit => hit.token)).toEqual([before])
      writeChanges((await runCssClassRename(new Map([[before, after]]), { cwd: fx.dir, glob: framework.file })).changes)
      framework.check(fx)
      expect(renderedClass(framework.render(fx))).toBe(after)
    }
    finally { fx.cleanup() }
  })
})
