import { parse } from '@vue/compiler-sfc'
import { rewriteClassString, runCssClassRename, runCssClassScan } from 'ripide-api'
import { describe, expect, it } from 'vitest'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

const rename = new Map([['old-token', 'new-token']])

function templateProps(source: string): any[] {
  const { descriptor, errors } = parse(source)
  expect(errors).toEqual([])
  const props: any[] = []
  const visit = (node: any): void => {
    props.push(...node.props ?? [])
    for (const child of node.children ?? []) visit(child)
  }
  visit(descriptor.template!.ast)
  return props
}

describe('class migration release regressions', () => {
  it('preserves quoted brackets without swallowing subsequent class tokens', () => {
    expect(rewriteClassString('content-[\'[\'] old-token', rename)).toBe('content-[\'[\'] new-token')
  })

  it('visits classes after nested templates and preserves unrelated attributes', async () => {
    const fx = makeFixture({
      'Page.vue': `<template><div data-class="old-token"><template v-if="ok"><span /></template><p class="old-token" /><p v-bind:class="active ? 'old-token' : ''" /></div></template>`,
    }, false)
    try {
      expect(runCssClassScan({ ...{ cwd: fx.dir }, engine: vueServices() })).toEqual([{ token: 'old-token', count: 2, files: ['Page.vue'] }])
      const result = await runCssClassRename(rename, { ...{ cwd: fx.dir }, engine: vueServices() })
      const props = templateProps(result.changes[0].after)
      expect(props.find(p => p.name === 'data-class').value.content).toBe('old-token')
      expect(props.find(p => p.name === 'class').value.content).toBe('new-token')
      expect(props.find(p => p.name === 'bind').exp.content).toBe('active ? \'new-token\' : \'\'')
    }
    finally { fx.cleanup() }
  })

  it('does not rename class-looking text inside comments or other attributes', async () => {
    const fx = makeFixture({
      'Page.vue': `<template><!-- <div class="old-token" /> --><p data-class="old-token" title='class="old-token"' /></template>`,
    }, false)
    try {
      expect(runCssClassScan({ ...{ cwd: fx.dir }, engine: vueServices() })).toEqual([])
      expect((await runCssClassRename(rename, { ...{ cwd: fx.dir }, engine: vueServices() })).changes).toEqual([])
    }
    finally { fx.cleanup() }
  })

  it('keeps escaped script string values valid after class replacement', async () => {
    const fx = makeFixture({
      'classes.ts': String.raw`export const cls = 'old-token content-[\'hello\']'`,
    }, false)
    try {
      const result = await runCssClassRename(rename, { ...{ cwd: fx.dir }, engine: vueServices() })
      const output = await import(`data:text/javascript,${encodeURIComponent(result.changes[0].after)}`)
      expect(output.cls).toBe('new-token content-[\'hello\']')
    }
    finally { fx.cleanup() }
  })

  it('does not treat style markup inside script strings as a style block', async () => {
    const fx = makeFixture({
      'Page.vue': `<script setup>const example = '<style>.example { @apply old-token; }</style>'</script><template><div /></template>`,
    }, false)
    try {
      expect(runCssClassScan({ ...{ cwd: fx.dir }, engine: vueServices() })).toEqual([])
      expect((await runCssClassRename(rename, { ...{ cwd: fx.dir }, engine: vueServices() })).changes).toEqual([])
    }
    finally { fx.cleanup() }
  })

  it('migrates arbitrary values containing quotes as complete class tokens', async () => {
    const fx = makeFixture({ 'Page.vue': `<template><div class="before:content-['hello']" /></template>` }, false)
    try {
      expect(runCssClassScan({ ...{ cwd: fx.dir }, engine: vueServices() })).toEqual([{ token: 'content-[\'hello\']', count: 1, files: ['Page.vue'] }])
      const result = await runCssClassRename(new Map([['content-[\'hello\']', 'content-[\'goodbye\']']]), { ...{ cwd: fx.dir }, engine: vueServices() })
      expect(templateProps(result.changes[0].after)[0].value.content).toBe('before:content-[\'goodbye\']')
    }
    finally { fx.cleanup() }
  })
})
