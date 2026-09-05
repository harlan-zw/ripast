import assert from 'node:assert/strict'
import { join } from 'node:path'
import { it } from 'vitest'
import { startTsServer } from '../packages/core/src/ts-server.ts'
import { findRegressionsWithServer } from '../packages/core/src/verify.ts'
import { makeFixture } from './helpers.ts'

it('findRegressionsWithServer reports errors introduced by in-memory changes only', async () => {
  const fx = makeFixture({
    'a.ts': 'export function add(n: number): number { return n + 1 }\n',
    'b.ts': 'import { add } from \'./a.ts\'\nexport const r: number = add(2)\n',
  })
  const server = await startTsServer(fx.dir)
  try {
    const a = join(fx.dir, 'a.ts')
    const b = join(fx.dir, 'b.ts')
    const breaking = [{
      path: a,
      rel: 'a.ts',
      before: fx.read('a.ts'),
      after: 'export function add(n: number): string { return String(n) }\n',
    }]
    const regressions = await findRegressionsWithServer(server, breaking, [a, b])
    assert.equal(regressions.length, 1, `expected one regression, got ${JSON.stringify(regressions)}`)
    assert.equal(regressions[0]!.file, b)
    assert.equal(regressions[0]!.code, 2322)
    assert.equal(fx.read('a.ts'), breaking[0]!.before, 'disk untouched')
  }
  finally {
    server.dispose()
    fx.cleanup()
  }
})

it('findRegressionsWithServer keeps the pushed overlay across repeated pulls', async () => {
  const fx = makeFixture({
    'a.ts': 'export function add(n: number): number { return n + 1 }\n',
    'b.ts': 'import { add } from \'./a.ts\'\nexport const r: number = add(2)\n',
  })
  const server = await startTsServer(fx.dir)
  try {
    const a = join(fx.dir, 'a.ts')
    const b = join(fx.dir, 'b.ts')
    const breaking = [{ path: a, rel: 'a.ts', before: fx.read('a.ts'), after: 'export function add(n: number): string { return String(n) }\n' }]
    await findRegressionsWithServer(server, breaking, [a, b])
    const again = await server.diagnostics([b])
    assert.equal(again.get(b)?.length, 1, 'a second pull must still see the overlay, not the on-disk text')
  }
  finally {
    server.dispose()
    fx.cleanup()
  }
})

it('rename follows named re-export barrels instead of aliasing the export', async () => {
  const fx = makeFixture({
    'a.ts': 'export function target(): number { return 1 }\n',
    'index.ts': 'export { target } from \'./a.ts\'\n',
    'b.ts': 'import { target } from \'./index.ts\'\nexport const v = target()\n',
  })
  const server = await startTsServer(fx.dir)
  try {
    const edits = await server.rename(join(fx.dir, 'a.ts'), 'export function '.length, 'renamed')
    const texts = [...edits.values()].flat().map(e => e.newText)
    assert.equal(edits.size, 3, 'declaration, barrel, and consumer all change')
    assert.ok(texts.every(t => t === 'renamed'), `no alias edits expected, got ${JSON.stringify(texts)}`)
  }
  finally {
    server.dispose()
    fx.cleanup()
  }
})
