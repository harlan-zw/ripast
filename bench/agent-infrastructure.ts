import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import process from 'node:process'
import { buildDeclarationTree, createDeclarationCache } from 'ripide-api'
import { makeBenchFixture } from './fixture.ts'

const fixture = makeBenchFixture()
const runs = 9
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]

try {
  const cwd = fixture.dir
  const cache = createDeclarationCache()
  const expected = buildDeclarationTree({ cwd })
  const coldStart = performance.now()
  const cold = buildDeclarationTree({ cwd, cache })
  const coldMs = performance.now() - coldStart
  assert.deepEqual(cold, expected)

  const uncachedMs: number[] = []
  const warmMs: number[] = []
  for (let i = 0; i < runs; i++) {
    // Alternate ordering to reduce systematic warm-up bias.
    for (const cached of i % 2 ? [true, false] : [false, true]) {
      const start = performance.now()
      const result = buildDeclarationTree({ cwd, ...(cached ? { cache } : {}) })
      const elapsed = performance.now() - start
      assert.deepEqual(result, expected)
      ;(cached ? warmMs : uncachedMs).push(elapsed)
    }
  }
  const beforeEdit = cache.stats()
  const sourcePath = join(cwd, 'src/hot.ts')
  const source = readFileSync(sourcePath, 'utf8')
  writeFileSync(sourcePath, source.replace('hotSymbol', 'newSymbol'))
  const afterEdit = buildDeclarationTree({ cwd, cache })
  assert.equal(afterEdit.files.find(file => file.file === 'src/hot.ts')!.declarations[1].name, 'newSymbol')
  assert.equal(cache.stats().misses - beforeEdit.misses, 1)

  writeFileSync(join(cwd, 'output.ts'), `export const className = 'font-semibold'\n${'// unchanged context\n'.repeat(500)}`)
  const cli = resolve('packages/cli/dist/cli.mjs')
  const output = (profile: string) => execFileSync(process.execPath, [cli, 'css-class-rename', 'font-semibold', 'font-medium', '--json', '--profile', profile], { cwd, encoding: 'utf8' })
  const full = output('full')
  const agent = output('agent')
  assert.equal(JSON.parse(full).summary.files, JSON.parse(agent).changes.length)
  const fullBytes = Buffer.byteLength(full)
  const agentBytes = Buffer.byteLength(agent)
  process.stdout.write(`${JSON.stringify({
    fixtureFiles: expected.files.length,
    runs,
    cache: { coldMs, uncachedMedianMs: median(uncachedMs), warmMedianMs: median(warmMs), stats: cache.stats() },
    output: { fullBytes, agentBytes, reductionPercent: 100 * (1 - agentBytes / fullBytes) },
    limits: 'Synthetic local inspection and output bytes. Provider token usage, cost, and cross-process compiler reuse are not measured.',
  }, null, 2)}\n`)
}
finally {
  fixture.cleanup()
}
