import { parse } from '@vue/compiler-sfc'
import { scan } from 'ripide-api'
import { parseComponentSource, runVueTemplateUnwrap, runVueTemplateWrap } from 'ripide-vue'
import { describe, expect, it } from 'vitest'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

function templateTags(source: string): string[] {
  const { descriptor, errors } = parse(source)
  expect(errors).toEqual([])
  const tags: string[] = []
  const visit = (node: any): void => {
    if (node.tag)
      tags.push(node.tag)
    for (const child of node.children ?? []) visit(child)
  }
  visit(descriptor.template!.ast)
  return tags
}

describe('vue release regressions', () => {
  it('unwraps nested matches without corrupting their children', async () => {
    const fx = makeFixture({
      'Page.vue': '<template><Outer><Outer><p>hello</p></Outer><span>world</span></Outer></template>',
    }, false)
    try {
      const result = await runVueTemplateUnwrap('Outer', { cwd: fx.dir })
      expect(templateTags(result.changes[0].after)).toEqual(['p', 'span'])
      const { descriptor } = parse(result.changes[0].after)
      expect(descriptor.template!.content).toBe('<p>hello</p><span>world</span>')
    }
    finally { fx.cleanup() }
  })

  it('wraps and unwraps repeated root nodes with bound attributes', async () => {
    const fx = makeFixture({ 'Page.vue': '<template><Card :title="a > b" /><Card /></template>' }, false)
    try {
      const wrapped = await runVueTemplateWrap('Card', 'Frame', { cwd: fx.dir })
      expect(templateTags(wrapped.changes[0].after)).toEqual(['Frame', 'Card', 'Frame', 'Card'])
      fx.write('Page.vue', wrapped.changes[0].after)
      const unwrapped = await runVueTemplateUnwrap('Frame', { cwd: fx.dir })
      expect(templateTags(unwrapped.changes[0].after)).toEqual(['Card', 'Card'])
    }
    finally { fx.cleanup() }
  })

  it('lists quoted names in typed component events', () => {
    const shape = parseComponentSource('Input.vue', `<script setup lang="ts">defineEmits<{ 'update:modelValue': [value: string], change: [value: string] }>()</script>`)
    expect(shape.emits).toEqual(['change', 'update:modelValue'])
  })

  it('reports source positions for template references after the script block', () => {
    const fx = makeFixture({
      'Page.vue': '<script setup>\nconst count = 1\n</script>\n<template>\n  <div>{{ count }}</div>\n</template>',
    }, false)
    try {
      const hits = scan('count', { ...{ cwd: fx.dir, kinds: ['identifier-reference'] }, engine: vueServices() })
      expect(hits.map(hit => ({ line: hit.line, col: hit.col }))).toEqual([{ line: 5, col: 11 }])
    }
    finally { fx.cleanup() }
  })

  it('excludes static directive argument names from identifier references', () => {
    const fx = makeFixture({ 'Page.vue': '<template><div :title="label" :[field]="label" /></template>' }, false)
    try {
      expect(scan('title', { ...{ cwd: fx.dir, kinds: ['identifier-reference'] }, engine: vueServices() })).toEqual([])
      expect(scan('field', { ...{ cwd: fx.dir, kinds: ['identifier-reference'] }, engine: vueServices() }).map(hit => hit.col)).toEqual([33])
    }
    finally { fx.cleanup() }
  })
})
