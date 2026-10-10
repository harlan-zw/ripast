import assert from 'node:assert/strict'
import { join } from 'node:path'
import { buildDeclarationTree, buildScanGraph, scan } from 'ripide-api'
import { findFilesMany } from 'ripide-api/adapter'
import { it } from 'vitest'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

it('scan preserves line breaks in source file names', () => {
  const file = 'src/line\nbreak.ts'
  const fx = makeFixture({ [file]: 'export const target = 1\n' }, false)
  try {
    assert.deepEqual(scan('target', { ...{ cwd: fx.dir }, engine: vueServices() }).map(hit => hit.file), [file])
    assert.deepEqual(findFilesMany(['target'], { cwd: fx.dir }), [join(fx.dir, file)])
  }
  finally { fx.cleanup() }
})

it('scan finds decoded identifiers and string literals', () => {
  const fx = makeFixture({
    'escaped.ts': 'export const t\\u0061rget = "t\\x61rget"\n',
    'view.vue': '<template>{{ t\\u0061rget }}</template>\n',
  }, false)
  try {
    assert.deepEqual(scan('target', { ...{ cwd: fx.dir }, engine: vueServices() }).map(hit => [hit.file, hit.kind]).sort(), [
      ['escaped.ts', 'identifier-binding'],
      ['escaped.ts', 'string-literal'],
      ['view.vue', 'identifier-reference'],
    ])
    assert.deepEqual(buildScanGraph('target', { ...{ cwd: fx.dir }, engine: vueServices() }).nodes.map(node => node.file), ['escaped.ts', 'view.vue'])
  }
  finally { fx.cleanup() }
})

it('declaration discovery preserves line breaks in source file names', () => {
  const file = 'src/line\nbreak.ts'
  const fx = makeFixture({ [file]: 'export const target = 1\n' }, false)
  try {
    const tree = buildDeclarationTree({ ...{ cwd: fx.dir }, engine: vueServices() })
    assert.deepEqual(tree.files.map(entry => entry.file), [file])
    assert.deepEqual(tree.files[0].declarations.map(entry => entry.name), ['target'])
  }
  finally { fx.cleanup() }
})
