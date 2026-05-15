import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { it } from 'vitest'
import { isInsideAutoImportScope } from '../packages/core/src/nuxt.ts'
import { applyTextEdits, mergeFileChanges, parseSourceFile, writeChanges } from '../packages/core/src/util.ts'
import { makeFixture } from './helpers.ts'

it('writeChanges leaves no partial state when a write fails mid-batch', () => {
  const fx = makeFixture({
    'a.ts': 'original-a\n',
    'b.ts': 'original-b\n',
  }, false)
  try {
    const changes = [
      { path: join(fx.dir, 'a.ts'), rel: 'a.ts', before: 'original-a\n', after: 'new-a\n' },
      { path: join(fx.dir, 'missing-dir/b.ts'), rel: 'missing-dir/b.ts', before: '', after: 'new-b\n' },
    ]
    assert.throws(() => writeChanges(changes))
    assert.equal(readFileSync(join(fx.dir, 'a.ts'), 'utf8'), 'original-a\n', 'a.ts unchanged after failure')
    assert.ok(!existsSync(join(fx.dir, 'missing-dir')), 'target dir was never created')
    const leftover = readdirSync(fx.dir).filter((f: string) => f.includes('ripast-tmp'))
    assert.equal(leftover.length, 0, `no tmp files leaked: ${leftover.join(', ')}`)
  }
  finally { fx.cleanup() }
})

it('writeChanges applies all changes successfully when every target is writable', () => {
  const fx = makeFixture({
    'a.ts': 'original-a\n',
    'b.ts': 'original-b\n',
  }, false)
  try {
    writeChanges([
      { path: join(fx.dir, 'a.ts'), rel: 'a.ts', before: 'original-a\n', after: 'new-a\n' },
      { path: join(fx.dir, 'b.ts'), rel: 'b.ts', before: 'original-b\n', after: 'new-b\n' },
    ])
    assert.equal(fx.read('a.ts'), 'new-a\n')
    assert.equal(fx.read('b.ts'), 'new-b\n')
    const leftover = readdirSync(fx.dir).filter((f: string) => f.includes('ripast-tmp'))
    assert.equal(leftover.length, 0, 'no tmp files left after success')
  }
  finally { fx.cleanup() }
})

it('mergeFileChanges keeps original before text and replaces latest after text', () => {
  const target = [
    { path: '/tmp/a.ts', rel: 'a.ts', before: 'original a', after: 'first a' },
  ]
  mergeFileChanges(target, [
    { path: '/tmp/a.ts', rel: 'a.ts', before: 'ignored before', after: 'second a' },
    { path: '/tmp/b.ts', rel: 'b.ts', before: 'original b', after: 'first b' },
  ])
  assert.deepEqual(target, [
    { path: '/tmp/a.ts', rel: 'a.ts', before: 'original a', after: 'second a' },
    { path: '/tmp/b.ts', rel: 'b.ts', before: 'original b', after: 'first b' },
  ])
})

it('parseSourceFile parses in-memory Vue script blocks with source positions', () => {
  const source = [
    '<template><div>{{ msg }}</div></template>',
    '<script setup lang="ts">',
    'const msg = "hello"',
    '</script>',
    '',
  ].join('\n')
  const file = parseSourceFile('/tmp/Comp.vue', source, '/tmp')
  assert.equal(file.rel, 'Comp.vue')
  assert.equal(file.scriptSource, '\nconst msg = "hello"\n')
  assert.equal(source.slice(file.scriptStart, file.scriptEnd), file.scriptSource)
  assert.ok(file.program)
  assert.equal(file.isSfc, true)
})

it('isInsideAutoImportScope accepts slash and backslash paths', () => {
  const scopes = new Set(['/repo/composables', 'C:\\repo\\utils'])
  assert.equal(isInsideAutoImportScope('/repo/composables/useThing.ts', scopes), true)
  assert.equal(isInsideAutoImportScope('C:\\repo\\utils\\format.ts', scopes), true)
  assert.equal(isInsideAutoImportScope('/repo/components/Button.vue', scopes), false)
})

it('applyTextEdits applies sorted replacements and skips overlapping edits', () => {
  assert.equal(
    applyTextEdits('abcdef', [
      { start: 4, end: 6, replacement: 'EF' },
      { start: 1, end: 3, replacement: 'BC' },
      { start: 2, end: 5, replacement: 'ignored' },
    ]),
    'aBCdEF',
  )
})
