import assert from 'node:assert/strict'
/* eslint-disable no-new-func -- Evaluate only the fixed fixture expressions to verify preserved runtime behavior. */
import { parse as parseSfc } from '@vue/compiler-sfc'
import { rewriteClassString, runCssClassRename, runCssClassScan } from 'ripide-api'
import { describe, it } from 'vitest'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

describe('css class edge cases', () => {
  it('ignores @apply text inside CSS comments and strings', async () => {
    const source = `/* @apply flex; */\n.example { content: "@apply flex;"; }\n`
    const fx = makeFixture({ 'app.css': source }, false)
    try {
      assert.deepEqual(runCssClassScan({ ...{ cwd: fx.dir }, engine: vueServices() }), [])
      assert.deepEqual((await runCssClassRename(new Map([['flex', 'grid']]), { ...{ cwd: fx.dir }, engine: vueServices() })).changes, [])
    }
    finally { fx.cleanup() }
  })

  it('scans and rewrites multiline @apply while preserving comments', async () => {
    const source = `.example { @apply\n  flex /* flex */\n  items-center; }`
    const fx = makeFixture({ 'app.css': source }, false)
    try {
      assert.deepEqual(runCssClassScan({ ...{ cwd: fx.dir, sort: 'token' }, engine: vueServices() }).map(h => [h.token, h.count]), [['flex', 1], ['items-center', 1]])
      const result = await runCssClassRename(new Map([['flex', 'grid'], ['items-center', 'items-start']]), { ...{ cwd: fx.dir }, engine: vueServices() })
      fx.write('app.css', result.changes[0].after)
      assert.deepEqual(runCssClassScan({ ...{ cwd: fx.dir, sort: 'token' }, engine: vueServices() }).map(h => [h.token, h.count]), [['grid', 1], ['items-start', 1]])
      assert.match(result.changes[0].after, /\/\* flex \*\//)
    }
    finally { fx.cleanup() }
  })

  it('scans and renames unquoted Vue class object keys without changing conditions', async () => {
    const fx = makeFixture({ 'app.vue': `<template><div :class="{ flex: mode === 'block', 'items-center': active }" /></template>` }, false)
    try {
      assert.deepEqual(runCssClassScan({ ...{ cwd: fx.dir, sort: 'token' }, engine: vueServices() }).map(h => h.token), ['flex', 'items-center'])
      const result = await runCssClassRename(new Map([['flex', 'inline-flex'], ['block', 'grid']]), { ...{ cwd: fx.dir }, engine: vueServices() })
      const ast = parseSfc(result.changes[0].after).descriptor.template!.ast!
      const expression = (ast.children[0] as any).props[0].exp.content
      const evaluate = new Function('mode', 'active', `return (${expression})`)
      assert.deepEqual(evaluate('block', true), { 'inline-flex': true, 'items-center': true })
      assert.deepEqual(evaluate('grid', false), { 'inline-flex': false, 'items-center': false })
    }
    finally { fx.cleanup() }
  })

  it('supports trailing important markers and arbitrary properties', async () => {
    const fx = makeFixture({ 'app.vue': `<template><div class="flex! hover:flex! [color:red]" /></template>` }, false)
    try {
      assert.deepEqual(runCssClassScan({ ...{ cwd: fx.dir, sort: 'token' }, engine: vueServices() }).map(h => [h.token, h.count]), [['[color:red]', 1], ['flex', 2]])
      assert.equal(rewriteClassString('flex! hover:flex! [color:red]', new Map([['flex', 'grid'], ['[color:red]', '[color:blue]']])), 'grid! hover:grid! [color:blue]')
    }
    finally { fx.cleanup() }
  })

  it('renames Vue shorthand class keys while preserving their variables', async () => {
    const fx = makeFixture({ 'app.vue': `<template><div :class="{ flex }" /></template>` }, false)
    try {
      assert.deepEqual(runCssClassScan({ ...{ cwd: fx.dir }, engine: vueServices() }).map(h => h.token), ['flex'])
      const result = await runCssClassRename(new Map([['flex', 'inline-flex']]), { ...{ cwd: fx.dir }, engine: vueServices() })
      const ast = parseSfc(result.changes[0].after).descriptor.template!.ast!
      const expression = (ast.children[0] as any).props[0].exp.content
      assert.deepEqual(new Function('flex', `return (${expression})`)(true), { 'inline-flex': true })
    }
    finally { fx.cleanup() }
  })

  it('renames concatenated class values without changing conditional tests', async () => {
    const fx = makeFixture({ 'app.vue': `<template><div :class="'flex' + (mode === 'block' ? ' items-center' : '')" /></template>` }, false)
    try {
      assert.deepEqual(runCssClassScan({ ...{ cwd: fx.dir, sort: 'token' }, engine: vueServices() }).map(h => h.token), ['flex', 'items-center'])
      const result = await runCssClassRename(new Map([['flex', 'grid'], ['block', 'inline-block']]), { ...{ cwd: fx.dir }, engine: vueServices() })
      const ast = parseSfc(result.changes[0].after).descriptor.template!.ast!
      const expression = (ast.children[0] as any).props[0].exp.content
      assert.equal(new Function('mode', `return (${expression})`)('block'), 'grid items-center')
    }
    finally { fx.cleanup() }
  })

  it('matches complete classes across concatenated literal boundaries', async () => {
    const fx = makeFixture({ 'app.vue': `<template><div :class="'flex' + 'ible'" /></template>` }, false)
    try {
      assert.deepEqual(runCssClassScan({ ...{ cwd: fx.dir }, engine: vueServices() }).map(h => h.token), ['flexible'])
      assert.deepEqual((await runCssClassRename(new Map([['flex', 'grid']]), { ...{ cwd: fx.dir }, engine: vueServices() })).changes, [])
      const result = await runCssClassRename(new Map([['flexible', 'grid']]), { ...{ cwd: fx.dir }, engine: vueServices() })
      const ast = parseSfc(result.changes[0].after).descriptor.template!.ast!
      const expression = (ast.children[0] as any).props[0].exp.content
      assert.equal(new Function(`return (${expression})`)(), 'grid')
    }
    finally { fx.cleanup() }
  })

  it('reads class helpers used inside unrelated comparison expressions', () => {
    const fx = makeFixture({ 'app.ts': `const matches = cn('flex') === 'flex'` }, false)
    try {
      assert.deepEqual(runCssClassScan({ ...{ cwd: fx.dir }, engine: vueServices() }).map(h => [h.token, h.count]), [['flex', 1]])
    }
    finally { fx.cleanup() }
  })

  it('reads class variants inside cva configuration', () => {
    const fx = makeFixture({ 'app.ts': `const button = cva('flex', { variants: { size: { sm: 'text-sm', lg: 'text-lg' } }, defaultVariants: { size: 'sm' }, compoundVariants: [{ size: 'lg', class: 'p-4' }] })` }, false)
    try {
      assert.deepEqual(runCssClassScan({ ...{ cwd: fx.dir, sort: 'token' }, engine: vueServices() }).map(h => h.token), ['flex', 'p-4', 'text-lg', 'text-sm'])
    }
    finally { fx.cleanup() }
  })

  it('preserves CSS important flags as syntax', async () => {
    const fx = makeFixture({ 'app.css': `.example { @apply flex !important; }` }, false)
    try {
      assert.deepEqual(runCssClassScan({ ...{ cwd: fx.dir }, engine: vueServices() }).map(h => h.token), ['flex'])
      const result = await runCssClassRename(new Map([['flex', 'grid'], ['important', 'large']]), { ...{ cwd: fx.dir }, engine: vueServices() })
      assert.match(result.changes[0].after, /@apply grid !important;/)
    }
    finally { fx.cleanup() }
  })

  it('ignores SCSS line comments and ends indented Sass directives at newlines', async () => {
    const fx = makeFixture({
      'app.scss': `// @apply flex;\n.example { @apply flex; }`,
      'app.sass': `.example\n  @apply flex\n  display: block\n.other\n  @apply items-center\n`,
    }, false)
    try {
      assert.deepEqual(runCssClassScan({ ...{ cwd: fx.dir, sort: 'token' }, engine: vueServices() }).map(h => [h.token, h.count]), [['flex', 2], ['items-center', 1]])
      const result = await runCssClassRename(new Map([['flex', 'grid'], ['block', 'inline-block']]), { ...{ cwd: fx.dir }, engine: vueServices() })
      const scss = result.changes.find(change => change.rel === 'app.scss')!
      const sass = result.changes.find(change => change.rel === 'app.sass')!
      assert.match(scss.after, /^\/\/ @apply flex;/)
      assert.match(sass.after, /display: block/)
    }
    finally { fx.cleanup() }
  })
})
