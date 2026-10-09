import assert from 'node:assert/strict'
import { writeChanges } from '@ripast/core'
import { runVueTemplateUnwrap, runVueTemplateWrap } from '@ripast/vue'
import { parse } from '@vue/compiler-sfc'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

it.each(['Outer/', 'Outer />', '<Outer>', 'img', 'Outer><Injected'])('wrap rejects an invalid parent: %s', async (wrapper) => {
  const fx = makeFixture({ 'view.vue': '<template><Inner /></template>' }, false)
  try {
    await assert.rejects(runVueTemplateWrap('Inner', wrapper, { cwd: fx.dir }))
    assert.equal(fx.read('view.vue'), '<template><Inner /></template>')
  }
  finally { fx.cleanup() }
})

it('wrap trims surrounding wrapper whitespace before generating tags', async () => {
  const fx = makeFixture({ 'view.vue': '<template><Inner /></template>' }, false)
  try {
    const result = await runVueTemplateWrap('Inner', ' Outer title="ok" ', { cwd: fx.dir })
    const parsed = parse(result.changes[0].after)
    assert.deepEqual(parsed.errors, [])
    assert.equal((parsed.descriptor.template!.ast!.children[0] as any).tag, 'Outer')
  }
  finally { fx.cleanup() }
})

it('unwrap preserves inline text whitespace', async () => {
  const before = '<template><Outer>  hello</Outer></template>'
  const fx = makeFixture({ 'view.vue': before }, false)
  try {
    const original = parse(before).descriptor.template!.ast!.children[0] as any
    const result = await runVueTemplateUnwrap('Outer', { cwd: fx.dir })
    const parsed = parse(result.changes[0].after)
    assert.deepEqual(parsed.errors, [])
    assert.equal((parsed.descriptor.template!.ast!.children[0] as any).content, original.children[0].content)
  }
  finally { fx.cleanup() }
})

it('wrap and unwrap preserve CRLF source lines', async () => {
  const before = '<template>\r\n  <Inner />\r\n</template>\r\n'
  const fx = makeFixture({ 'view.vue': before }, false)
  try {
    const wrapped = await runVueTemplateWrap('Inner', 'Outer', { cwd: fx.dir })
    assert.equal(wrapped.changes[0].after.replace(/\r\n/g, '').includes('\n'), false)
    writeChanges(wrapped.changes)
    const unwrapped = await runVueTemplateUnwrap('Outer', { cwd: fx.dir })
    assert.equal(unwrapped.changes[0].after, before)
  }
  finally { fx.cleanup() }
})
