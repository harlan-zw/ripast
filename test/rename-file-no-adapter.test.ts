import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, it, vi } from 'vitest'
import { makeFixture } from './helpers.ts'

// Simulate `npx ripide` with no ripide-vue installed: no framework
// adapter resolves. A pure-TS rename-file must still work.
vi.mock('../packages/core/src/adapter.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../packages/core/src/adapter.ts')>()
  return { ...actual, loadAdapter: async () => null }
})

const { runMove, runRename, runRenameFile } = await import('../packages/core/src/index.ts')
const { parseSourceFile } = await import('ripide-api/adapter')
const { writeChanges } = await import('../packages/core/src/util.ts')

const TSCONFIG = JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true },
  include: ['**/*.ts'],
}, null, 2)

function makeFx(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'ripide-rf-noadapter-'))
  const write = (rel: string, content: string) => {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  write('tsconfig.json', TSCONFIG)
  for (const [r, c] of Object.entries(files)) write(r, c)
  return {
    dir,
    read: (r: string) => readFileSync(join(dir, r), 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('rename-file without a framework adapter', () => {
  it.each(['deck/tsconfig.json', 'deck/.nuxt/tsconfig.app.json'])('rewrites consumers from the selected %s', async (tsconfig) => {
    const prefix = tsconfig.includes('.nuxt') ? '../' : ''
    const fx = makeFixture({
      [tsconfig]: JSON.stringify({
        compilerOptions: { allowJs: true, noEmit: true, module: 'ESNext', moduleResolution: 'bundler' },
        include: [`${prefix}*.ts`, `${prefix}../data/*.mjs`],
      }),
      'data/aggregate.mjs': 'export const amount = 1\n',
      'deck/consumer.ts': 'import { amount } from \'../data/aggregate.mjs\'\nexport const total = amount + 1\n',
    }, false)
    try {
      const result = await runRenameFile('data/aggregate.mjs', 'legacy/data/aggregate.mjs', { cwd: fx.dir, tsconfig })
      const consumer = result.changes.find(change => change.rel === 'deck/consumer.ts')
      assert.ok(consumer, 'the selected project consumer must be rewritten')
      const program = parseSourceFile('consumer.ts', consumer.after).program
      const imported = program.body.find((statement: any) => statement.type === 'ImportDeclaration')
      assert.equal(imported?.source.value, '../legacy/data/aggregate.mjs')
      assert.deepEqual(result.regressions, [])
      assert.ok(!result.changes.some(change => change.rel.includes('.nuxt/')), 'generated configs must stay unchanged')
    }
    finally { fx.cleanup() }
  })

  it.each(['rename', 'move'])('finds the selected project consumers during a symbol %s', async (operation) => {
    const tsconfig = 'deck/.nuxt/tsconfig.app.json'
    const fx = makeFixture({
      [tsconfig]: JSON.stringify({
        compilerOptions: { allowJs: true, noEmit: true, module: 'ESNext', moduleResolution: 'bundler' },
        include: ['../*.ts', '../../data/*.mjs'],
      }),
      'data/aggregate.mjs': 'export const amount = 1\n',
      'deck/consumer.ts': 'import { amount } from \'../data/aggregate.mjs\'\nexport const total = amount + 1\n',
    }, false)
    try {
      const options = { cwd: fx.dir, tsconfig, vue: false }
      const result = operation === 'rename'
        ? await runRename('amount', 'totalAmount', options)
        : await runMove('amount', 'data/aggregate.mjs', 'data/target.mjs', options)
      const consumer = result.changes.find(change => change.rel === 'deck/consumer.ts')
      assert.ok(consumer, 'the selected project consumer must be rewritten')
      const program = parseSourceFile('consumer.ts', consumer.after).program
      const imported = program.body.find((statement: any) => statement.type === 'ImportDeclaration')
      if (operation === 'rename')
        assert.equal(imported?.specifiers[0].imported.name, 'totalAmount')
      else
        assert.equal(imported?.source.value, '../data/target.mjs')
      assert.deepEqual(result.regressions, [])
    }
    finally { fx.cleanup() }
  })

  it('renames a .ts file and rewrites consumer imports', async () => {
    const fx = makeFx({
      'src/a.ts': `export const foo = 1\n`,
      'src/b.ts': `import { foo } from './a.ts'\nexport const bar = foo + 1\n`,
    })
    try {
      const r = await runRenameFile('src/a.ts', 'src/aa.ts', { cwd: fx.dir, verifyMode: 'none' })
      writeChanges(r.changes)
      renameSync(r.fileMove.from, r.fileMove.to)
      assert.match(fx.read('src/b.ts'), /from '\.\/aa(?:\.ts)?'/, 'consumer import rewritten')
    }
    finally { fx.cleanup() }
  })

  it('refuses to rename a .vue file without the Vue adapter', async () => {
    const fx = makeFx({ 'src/A.vue': `<template><div /></template>\n` })
    try {
      await assert.rejects(
        runRenameFile('src/A.vue', 'src/B.vue', { cwd: fx.dir, verifyMode: 'none' }),
        /requires the Vue adapter/,
      )
    }
    finally { fx.cleanup() }
  })
})
