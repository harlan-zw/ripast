import { buildDoctorFixes, runDoctor } from '@ripast/core'
import { describe, expect, it } from 'vitest'
import { makeFixture } from './helpers.ts'

describe('doctor: stale-reexport', () => {
  it('flags named re-exports for names no longer in target', async () => {
    const fx = makeFixture({
      'a.ts': 'export const Foo = 1',
      'index.ts': 'export { Foo, Bar } from \'./a\'',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-reexport'] })
    fx.cleanup()
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].check).toBe('stale-reexport')
    expect(report.findings[0].detail?.name).toBe('Bar')
  })

  it('follows `export *` chains for transitive lookup', async () => {
    const fx = makeFixture({
      'leaf.ts': 'export const Real = 1',
      'mid.ts': 'export * from \'./leaf\'',
      'index.ts': 'export { Real, Phantom } from \'./mid\'',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-reexport'] })
    fx.cleanup()
    const names = report.findings.map(f => f.detail?.name)
    expect(names).toEqual(['Phantom'])
  })
})

describe('doctor: stale-import', () => {
  it('flags named imports for names no longer in target', async () => {
    const fx = makeFixture({
      'a.ts': 'export const Foo = 1',
      'b.ts': 'import { Foo, Bar } from \'./a\'\nconsole.log(Foo, Bar)',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-import'] })
    fx.cleanup()
    const names = report.findings.map(f => f.detail?.name)
    expect(names).toEqual(['Bar'])
  })

  it('passes through `export *` re-exports', async () => {
    const fx = makeFixture({
      'leaf.ts': 'export const Real = 1',
      'index.ts': 'export * from \'./leaf\'',
      'consumer.ts': 'import { Real } from \'./index\'\nconsole.log(Real)',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-import'] })
    fx.cleanup()
    expect(report.findings).toHaveLength(0)
  })
})

describe('doctor: circular-dep', () => {
  it('detects a two-file cycle', async () => {
    const fx = makeFixture({
      'a.ts': 'import { b } from \'./b\'\nexport const a = b',
      'b.ts': 'import { a } from \'./a\'\nexport const b = a',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['circular-dep'] })
    fx.cleanup()
    expect(report.findings.length).toBeGreaterThanOrEqual(2)
    expect(report.findings[0].check).toBe('circular-dep')
  })

  it('does not flag acyclic graphs', async () => {
    const fx = makeFixture({
      'a.ts': 'export const a = 1',
      'b.ts': 'import { a } from \'./a\'\nexport const b = a',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['circular-dep'] })
    fx.cleanup()
    expect(report.findings).toHaveLength(0)
  })
})

describe('doctor: orphan-test', () => {
  it('flags test files with no sibling source', async () => {
    const fx = makeFixture({
      'src/foo.ts': 'export const foo = 1',
      'src/foo.test.ts': 'import { foo } from \'./foo\'',
      'src/ghost.test.ts': 'import { ghost } from \'./ghost\'',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['orphan-test'] })
    fx.cleanup()
    expect(report.findings.map(f => f.file)).toEqual(['src/ghost.test.ts'])
  })
})

describe('doctor: inconsistent-import-path', () => {
  it('flags minority specifier styles for the same target', async () => {
    const fx = makeFixture({
      'pkg/target.ts': 'export const X = 1',
      'a.ts': 'import { X } from \'./pkg/target\'',
      'b.ts': 'import { X } from \'./pkg/target\'',
      'c.ts': 'import { X } from \'./pkg/target.ts\'',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['inconsistent-import-path'] })
    fx.cleanup()
    const minorityFiles = report.findings.map(f => f.file)
    expect(minorityFiles).toEqual(['c.ts'])
  })

  it('does not flag when all files agree', async () => {
    const fx = makeFixture({
      'pkg/target.ts': 'export const X = 1',
      'a.ts': 'import { X } from \'./pkg/target\'',
      'b.ts': 'import { X } from \'./pkg/target\'',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['inconsistent-import-path'] })
    fx.cleanup()
    expect(report.findings).toHaveLength(0)
  })
})

describe('doctor: ignore comments', () => {
  it('suppresses all findings on a file with ripast-doctor-ignore-file', async () => {
    const fx = makeFixture({
      'a.ts': 'export const Foo = 1',
      'b.ts': '// ripast-doctor-ignore-file\nimport { Foo, Bar } from \'./a\'\nconsole.log(Foo, Bar)',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-import'] })
    fx.cleanup()
    expect(report.findings).toHaveLength(0)
  })

  it('suppresses only listed checks', async () => {
    const fx = makeFixture({
      'a.ts': 'export const Foo = 1',
      'b.ts': '// ripast-doctor-ignore-file: duplicate-export\nimport { Foo, Bar } from \'./a\'\nconsole.log(Foo, Bar)',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-import'] })
    fx.cleanup()
    expect(report.findings).toHaveLength(1)
  })
})

describe('doctor: --fix', () => {
  it('rewrites inconsistent import paths to the canonical specifier', async () => {
    const fx = makeFixture({
      'pkg/target.ts': 'export const X = 1',
      'a.ts': 'import { X } from \'./pkg/target\'',
      'b.ts': 'import { X } from \'./pkg/target\'',
      'c.ts': 'import { X } from \'./pkg/target.ts\'',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['inconsistent-import-path'] })
    const fix = buildDoctorFixes(report, fx.dir)
    expect(fix.changes).toHaveLength(1)
    expect(fix.changes[0].rel).toBe('c.ts')
    expect(fix.changes[0].after).toContain('\'./pkg/target\'')
    expect(fix.changes[0].after).not.toContain('./pkg/target.ts')
    fx.cleanup()
  })

  it('deletes dangling re-export lines', async () => {
    const fx = makeFixture({
      'a.ts': 'export const A = 1',
      'index.ts': 'export * from \'./a\'\nexport * from \'./missing\'\nexport const Local = 1',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['dangling-reexport'] })
    const fix = buildDoctorFixes(report, fx.dir)
    fx.cleanup()
    expect(fix.changes).toHaveLength(1)
    expect(fix.changes[0].after).not.toContain('./missing')
    expect(fix.changes[0].after).toContain('./a')
    expect(fix.changes[0].after).toContain('Local')
  })

  it('marks non-fixable findings as skipped', async () => {
    const fx = makeFixture({
      'a.ts': 'export const Foo = 1',
      'b.ts': 'import { Bar } from \'./a\'\nconsole.log(Bar)',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-import'] })
    const fix = buildDoctorFixes(report, fx.dir)
    fx.cleanup()
    expect(fix.changes).toHaveLength(0)
    expect(fix.skipped).toHaveLength(1)
  })
})

describe('doctor: cross-realm-import (vue adapter)', () => {
  it('flags app-realm files importing from server-realm', async () => {
    const fx = makeFixture({
      'nuxt.config.ts': 'export default defineNuxtConfig({})',
      'package.json': '{"dependencies":{"nuxt":"^3"}}',
      'app/composables/useFoo.ts': 'import { db } from \'../../server/utils/db\'\nexport const useFoo = () => db()',
      'server/utils/db.ts': 'export const db = () => 1',
    })
    const report = await runDoctor({ cwd: fx.dir })
    fx.cleanup()
    const cross = report.findings.filter(f => f.check === 'cross-realm-import')
    expect(cross.length).toBeGreaterThanOrEqual(1)
    expect(cross[0].detail?.fromRealm).toBe('app')
    expect(cross[0].detail?.toRealm).toBe('server')
  })

  it('does not flag type-only imports across realms', async () => {
    const fx = makeFixture({
      'nuxt.config.ts': 'export default defineNuxtConfig({})',
      'package.json': '{"dependencies":{"nuxt":"^3"}}',
      'app/composables/useFoo.ts': 'import type { Db } from \'../../server/utils/db\'\nexport const useFoo = (): Db => 1 as any',
      'server/utils/db.ts': 'export type Db = number',
    })
    const report = await runDoctor({ cwd: fx.dir })
    fx.cleanup()
    expect(report.findings.filter(f => f.check === 'cross-realm-import')).toHaveLength(0)
  })
})

describe('doctor: stale-nuxt-config-ref (vue adapter)', () => {
  it('flags extends entries pointing to non-existent paths', async () => {
    const fx = makeFixture({
      'nuxt.config.ts': 'export default defineNuxtConfig({ extends: [\'./layers/missing\', \'./layers/real\'] })',
      'package.json': '{"dependencies":{"nuxt":"^3"}}',
      'layers/real/nuxt.config.ts': 'export default defineNuxtConfig({})',
    })
    const report = await runDoctor({ cwd: fx.dir })
    fx.cleanup()
    const refs = report.findings.filter(f => f.check === 'stale-nuxt-config-ref')
    expect(refs).toHaveLength(1)
    expect(refs[0].detail?.value).toBe('./layers/missing')
  })
})

describe('doctor: --changed filter', () => {
  it('reports only findings on files in changedFiles', async () => {
    const fx = makeFixture({
      'a.ts': 'export const Foo = 1',
      'b.ts': 'import { Foo, Missing } from \'./a\'\nconsole.log(Foo, Missing)',
      'c.ts': 'import { Foo, AlsoMissing } from \'./a\'\nconsole.log(Foo, AlsoMissing)',
    })
    const full = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-import'] })
    expect(full.findings).toHaveLength(2)
    const filtered = await runDoctor({
      cwd: fx.dir,
      noAdapters: true,
      checks: ['stale-import'],
      changedFiles: ['b.ts'],
    })
    fx.cleanup()
    expect(filtered.findings).toHaveLength(1)
    expect(filtered.findings[0].file).toBe('b.ts')
  })
})

describe('doctor: --fix for stale-import', () => {
  it('removes a single stale specifier from a multi-name import', async () => {
    const fx = makeFixture({
      'a.ts': 'export const Foo = 1',
      'b.ts': 'import { Foo, Bar } from \'./a\'\nconsole.log(Foo)',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-import'] })
    const fix = buildDoctorFixes(report, fx.dir)
    fx.cleanup()
    expect(fix.changes).toHaveLength(1)
    expect(fix.changes[0].after).toContain('import { Foo } from \'./a\'')
    expect(fix.changes[0].after).not.toContain('Bar')
  })

  it('skips when removed local name is still referenced in the file', async () => {
    const fx = makeFixture({
      'a.ts': 'export const Foo = 1',
      'b.ts': 'import { Foo, Bar } from \'./a\'\nconsole.log(Foo, Bar)',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-import'] })
    const fix = buildDoctorFixes(report, fx.dir)
    fx.cleanup()
    expect(fix.changes).toHaveLength(0)
    expect(fix.skipped).toHaveLength(1)
    expect(fix.skipped[0].detail?.fixSkippedReason).toContain('still referenced')
  })

  it('deletes the whole import declaration when removing the only specifier', async () => {
    const fx = makeFixture({
      'a.ts': 'export const Foo = 1',
      'b.ts': 'import { Bar } from \'./a\'\nexport const x = 1',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-import'] })
    const fix = buildDoctorFixes(report, fx.dir)
    fx.cleanup()
    expect(fix.changes).toHaveLength(1)
    expect(fix.changes[0].after).not.toContain('Bar')
    expect(fix.changes[0].after).not.toContain('./a')
    expect(fix.changes[0].after).toContain('export const x')
  })
})

describe('doctor: ignore-next-line directive', () => {
  it('suppresses a stale-import on the line immediately below', async () => {
    const fx = makeFixture({
      'a.ts': 'export const Foo = 1',
      'b.ts': '// ripast-doctor-ignore-next-line\nimport { Foo, Bar } from \'./a\'\nconsole.log(Foo, Bar)',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-import'] })
    fx.cleanup()
    expect(report.findings).toHaveLength(0)
  })

  it('only suppresses listed checks when given names', async () => {
    const fx = makeFixture({
      'a.ts': 'export const Foo = 1',
      'b.ts': '// ripast-doctor-ignore-next-line: duplicate-export\nimport { Foo, Bar } from \'./a\'\nconsole.log(Foo, Bar)',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-import'] })
    fx.cleanup()
    expect(report.findings).toHaveLength(1)
  })

  it('does not suppress findings on lines beyond the targeted one', async () => {
    const fx = makeFixture({
      'a.ts': 'export const Foo = 1',
      'b.ts': '// ripast-doctor-ignore-next-line\nconst noise = 1\nimport { Bar } from \'./a\'\nconsole.log(noise, Bar)',
    })
    const report = await runDoctor({ cwd: fx.dir, noAdapters: true, checks: ['stale-import'] })
    fx.cleanup()
    expect(report.findings).toHaveLength(1)
  })
})
