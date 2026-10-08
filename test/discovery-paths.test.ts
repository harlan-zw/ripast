import assert from 'node:assert/strict'
import { join } from 'node:path'
import { buildDeclarationTree, scan } from '@ripast/core'
import { rgFilesMany } from '@ripast/core/adapter'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

it('scan preserves line breaks in source file names', () => {
  const file = 'src/line\nbreak.ts'
  const fx = makeFixture({ [file]: 'export const target = 1\n' }, false)
  try {
    assert.deepEqual(scan('target', { cwd: fx.dir }).map(hit => hit.file), [file])
    assert.deepEqual(rgFilesMany(['target'], { cwd: fx.dir }), [join(fx.dir, file)])
  }
  finally { fx.cleanup() }
})

it('declaration discovery preserves line breaks in source file names', () => {
  const file = 'src/line\nbreak.ts'
  const fx = makeFixture({ [file]: 'export const target = 1\n' }, false)
  try {
    const tree = buildDeclarationTree({ cwd: fx.dir })
    assert.deepEqual(tree.files.map(entry => entry.file), [file])
    assert.deepEqual(tree.files[0].declarations.map(entry => entry.name), ['target'])
  }
  finally { fx.cleanup() }
})
