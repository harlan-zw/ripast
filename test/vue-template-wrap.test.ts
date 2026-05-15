import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { runVueTemplateUnwrap, runVueTemplateWrap } from '../packages/core/src/vue-template-wrap.ts'
import { parseTemplateSelector, unwrapTemplateElements, wrapTemplateElements } from '../packages/core/src/vue-template.ts'
import { makeFixture } from './helpers.ts'

describe('parseTemplateSelector', () => {
  it('parses tag-only', () => {
    assert.deepEqual(parseTemplateSelector('ProPageZone'), { tag: 'ProPageZone', attrs: [] })
  })

  it('parses tag with attr predicate', () => {
    assert.deepEqual(parseTemplateSelector('Foo[bar]'), { tag: 'Foo', attrs: [{ name: 'bar' }] })
  })

  it('parses tag with attr=value predicate (double quotes)', () => {
    assert.deepEqual(parseTemplateSelector('Foo[name="x"]'), { tag: 'Foo', attrs: [{ name: 'name', value: 'x' }] })
  })

  it('parses tag with attr=value predicate (single quotes)', () => {
    assert.deepEqual(parseTemplateSelector('Foo[name=\'x\']'), { tag: 'Foo', attrs: [{ name: 'name', value: 'x' }] })
  })

  it('parses tag with attr=value predicate (unquoted)', () => {
    assert.deepEqual(parseTemplateSelector('Foo[name=x]'), { tag: 'Foo', attrs: [{ name: 'name', value: 'x' }] })
  })

  it('throws on empty', () => {
    assert.throws(() => parseTemplateSelector(''))
  })

  it('throws on garbage tail', () => {
    assert.throws(() => parseTemplateSelector('Foo garbage'))
  })
})

describe('wrapTemplateElements', () => {
  const sel = parseTemplateSelector('Inner')

  it('wraps a root element with proper indent', () => {
    const src = `<template>\n  <Inner foo="bar">\n    <p>hi</p>\n  </Inner>\n</template>\n`
    const out = wrapTemplateElements(src, sel, 'Outer')
    assert.equal(out, `<template>\n  <Outer>\n    <Inner foo="bar">\n      <p>hi</p>\n    </Inner>\n  </Outer>\n</template>\n`)
  })

  it('wraps self-closing elements', () => {
    const src = `<template>\n  <Inner />\n</template>\n`
    const out = wrapTemplateElements(src, sel, 'Outer')
    assert.equal(out, `<template>\n  <Outer>\n    <Inner />\n  </Outer>\n</template>\n`)
  })

  it('supports kebab-case in source', () => {
    const src = `<template>\n  <my-inner />\n</template>\n`
    const out = wrapTemplateElements(src, parseTemplateSelector('MyInner'), 'Outer')
    assert.equal(out, `<template>\n  <Outer>\n    <my-inner />\n  </Outer>\n</template>\n`)
  })

  it('emits wrapper with inline attrs', () => {
    const src = `<template>\n  <Inner />\n</template>\n`
    const out = wrapTemplateElements(src, sel, 'Outer name="x"')
    assert.equal(out, `<template>\n  <Outer name="x">\n    <Inner />\n  </Outer>\n</template>\n`)
  })

  it('respects attr predicate selector', () => {
    const src = `<template>\n  <Inner name="a" />\n  <Inner name="b" />\n</template>\n`
    const out = wrapTemplateElements(src, parseTemplateSelector('Inner[name=a]'), 'Outer')
    assert.equal(out, `<template>\n  <Outer>\n    <Inner name="a" />\n  </Outer>\n  <Inner name="b" />\n</template>\n`)
  })

  it('returns input unchanged when no match', () => {
    const src = `<template>\n  <Other />\n</template>\n`
    assert.equal(wrapTemplateElements(src, sel, 'Outer'), src)
  })

  it('does not double-wrap (no recursion into matches)', () => {
    const src = `<template>\n  <Inner>\n    <Inner />\n  </Inner>\n</template>\n`
    const out = wrapTemplateElements(src, sel, 'Outer')
    // Only the outer Inner should be wrapped
    const occurrences = out.match(/<Outer>/g) ?? []
    assert.equal(occurrences.length, 1)
  })
})

describe('unwrapTemplateElements', () => {
  const sel = parseTemplateSelector('Outer')

  it('unwraps an element, hoisting its children', () => {
    const src = `<template>\n  <Outer>\n    <Inner foo="bar">\n      <p>hi</p>\n    </Inner>\n  </Outer>\n</template>\n`
    const out = unwrapTemplateElements(src, sel)
    assert.equal(out, `<template>\n  <Inner foo="bar">\n    <p>hi</p>\n  </Inner>\n</template>\n`)
  })

  it('removes self-closing matches and their line', () => {
    const src = `<template>\n  <Outer />\n  <Inner />\n</template>\n`
    const out = unwrapTemplateElements(src, sel)
    assert.equal(out, `<template>\n  <Inner />\n</template>\n`)
  })

  it('is the inverse of wrap on a simple element', () => {
    const original = `<template>\n  <Inner foo="bar">\n    <p>hi</p>\n  </Inner>\n</template>\n`
    const wrapped = wrapTemplateElements(original, parseTemplateSelector('Inner'), 'Outer')
    const unwrapped = unwrapTemplateElements(wrapped, parseTemplateSelector('Outer'))
    assert.equal(unwrapped, original)
  })
})

describe('runVueTemplateWrap / runVueTemplateUnwrap', () => {
  it('wraps across multiple .vue files', async () => {
    const fx = makeFixture({
      'a.vue': `<template>\n  <Inner />\n</template>\n`,
      'b.vue': `<template>\n  <Inner foo="1" />\n</template>\n`,
      'c.vue': `<template>\n  <Other />\n</template>\n`,
    }, false)
    try {
      const r = await runVueTemplateWrap('Inner', 'Outer', { cwd: fx.dir })
      assert.equal(r.changes.length, 2)
      const paths = r.changes.map(c => c.rel).sort()
      assert.deepEqual(paths, ['a.vue', 'b.vue'])
      for (const c of r.changes)
        assert.ok(c.after.includes('<Outer>'))
    }
    finally { fx.cleanup() }
  })

  it('--scope restricts to a single file', async () => {
    const fx = makeFixture({
      'a.vue': `<template>\n  <Inner />\n</template>\n`,
      'b.vue': `<template>\n  <Inner />\n</template>\n`,
    }, false)
    try {
      const r = await runVueTemplateWrap('Inner', 'Outer', { cwd: fx.dir, scope: 'a.vue' })
      assert.equal(r.changes.length, 1)
      assert.equal(r.changes[0]!.rel, 'a.vue')
    }
    finally { fx.cleanup() }
  })

  it('--scope rejects non-existent files', async () => {
    const fx = makeFixture({}, false)
    try {
      await assert.rejects(() => runVueTemplateWrap('Inner', 'Outer', { cwd: fx.dir, scope: 'missing.vue' }))
    }
    finally { fx.cleanup() }
  })

  it('rootOnly skips nested matches', async () => {
    const fx = makeFixture({
      'a.vue': `<template>\n  <div>\n    <Inner />\n  </div>\n  <Inner />\n</template>\n`,
    }, false)
    try {
      const r = await runVueTemplateWrap('Inner', 'Outer', { cwd: fx.dir, rootOnly: true })
      assert.equal(r.changes.length, 1)
      const outers = r.changes[0]!.after.match(/<Outer>/g) ?? []
      assert.equal(outers.length, 1)
    }
    finally { fx.cleanup() }
  })

  it('unwrap is a no-op when no match', async () => {
    const fx = makeFixture({
      'a.vue': `<template>\n  <Inner />\n</template>\n`,
    }, false)
    try {
      const r = await runVueTemplateUnwrap('NotThere', { cwd: fx.dir })
      assert.equal(r.changes.length, 0)
    }
    finally { fx.cleanup() }
  })
})
