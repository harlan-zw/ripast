import assert from 'node:assert/strict'
import { join } from 'node:path'
import { it } from 'vitest'
import { createDeclarationCache, createEngine } from '../packages/core/src/index.ts'
import { makeFixture } from './helpers.ts'

it('keeps context-sensitive authored declarations separate across project roots', () => {
  const source = 'export const alpha = 1\nexport const beta = 2\n'
  const fixture = makeFixture({ 'view.custom': source, 'nested/placeholder.txt': '' })
  const nested = join(fixture.dir, 'nested')
  const path = join(fixture.dir, 'view.custom')
  const engine = createEngine({ extensions: [{
    name: 'contextual',
    suffixes: ['.custom'],
    parse: ({ path, source, cwd }) => {
      const offset = cwd === fixture.dir ? 0 : source.indexOf('\n') + 1
      const script = cwd === fixture.dir ? source.slice(0, source.indexOf('\n') + 1) : source.slice(offset)
      return { _tag: 'Script', source: script, start: offset, filename: `${path}.ts` }
    },
  }] })
  try {
    const cache = createDeclarationCache()
    const first = cache.inspect(path, source, fixture.dir, engine.services)
    assert.equal(first?.declarations[0]?.name, 'alpha')
    const second = cache.inspect(path, source, nested, engine.services)
    const fresh = createDeclarationCache().inspect(path, source, nested, engine.services)
    assert.deepEqual(second, fresh)
    assert.equal(second?.declarations[0]?.name, 'beta')
    assert.equal(second?.file, '../view.custom')
    assert.deepEqual(cache.inspect(path, source, nested, engine.services), fresh)
    assert.equal(cache.stats().hits, 1)
  }
  finally { fixture.cleanup() }
})
