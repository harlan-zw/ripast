import assert from 'node:assert/strict'
import { renameSync } from 'node:fs'
import { describe, it } from 'vitest'
import { runCssClassRename, runMove, runRename, runRenameFile, scan, writeChanges } from '../packages/core/src/index.ts'
import { assertSolidDiagnostics, makeSolidFixture, solidSyntax } from './solid-helpers.ts'

const options = { vue: false, verify: 'project' as const }

describe('solid TSX refactors', () => {
  it('renames components while preserving consumer aliases and control flow', async () => {
    const fx = makeSolidFixture()
    try {
      assertSolidDiagnostics(fx)
      const result = await runRename('Counter', 'Score', { cwd: fx.dir, ...options })
      assert.deepEqual(result.regressions, [])
      writeChanges(result.changes)
      const counter = solidSyntax(fx, 'src/Counter.tsx')
      const app = solidSyntax(fx, 'src/App.tsx')
      assert.deepEqual(counter.declarations, ['CounterProps', 'Score'])
      assert.deepEqual(counter.tags, ['section', 'button', 'Show', 'span', 'For', 'span'])
      assert.deepEqual(app.imports, [{ from: './Counter', imported: 'Score', local: 'ScoreCounter' }])
      assert.deepEqual(app.tags, ['ScoreCounter'])
      assertSolidDiagnostics(fx)
    }
    finally { fx.cleanup() }
  })

  it.each([
    ['count', 'score', ['createSignal', 'score', 'setCount', 'score', 'score', 'score']],
    ['setCount', 'setScore', ['createSignal', 'count', 'setScore', 'count', 'count', 'count']],
  ])('renames the signal binding %s inside event handlers and JSX', async (from, to, calls) => {
    const fx = makeSolidFixture()
    try {
      assertSolidDiagnostics(fx)
      const result = await runRename(from, to, { cwd: fx.dir, scope: 'src/Counter.tsx', ...options })
      assert.deepEqual(result.regressions, [])
      writeChanges(result.changes)
      assert.deepEqual(solidSyntax(fx, 'src/Counter.tsx').calls, calls)
      assertSolidDiagnostics(fx)
    }
    finally { fx.cleanup() }
  })

  it('scans Solid component references through an import alias', () => {
    const fx = makeSolidFixture()
    try {
      const hits = scan('Counter', { cwd: fx.dir })
      assert.deepEqual([...new Set(hits.map(hit => hit.file))].sort(), ['src/App.tsx', 'src/Counter.tsx'])
    }
    finally { fx.cleanup() }
  })

  it('moves a signal component and carries its framework and props dependencies', async () => {
    const fx = makeSolidFixture()
    try {
      assertSolidDiagnostics(fx)
      const result = await runMove('Counter', 'src/Counter.tsx', 'src/components/Counter.tsx', { cwd: fx.dir, ...options })
      assert.deepEqual(result.regressions, [])
      writeChanges(result.changes)
      const moved = solidSyntax(fx, 'src/components/Counter.tsx')
      assert.deepEqual(moved.declarations, ['Counter'])
      assert.deepEqual(moved.imports, [
        { from: 'solid-js', imported: 'createSignal', local: 'createSignal' },
        { from: 'solid-js', imported: 'For', local: 'For' },
        { from: 'solid-js', imported: 'Show', local: 'Show' },
        { from: '../Counter.tsx', imported: 'CounterProps', local: 'CounterProps' },
      ])
      assert.deepEqual(solidSyntax(fx, 'src/App.tsx').imports, [{ from: './components/Counter', imported: 'Counter', local: 'ScoreCounter' }])
      assertSolidDiagnostics(fx)
    }
    finally { fx.cleanup() }
  })

  it('renames component files and preserves the consumer JSX binding', async () => {
    const fx = makeSolidFixture()
    try {
      assertSolidDiagnostics(fx)
      const result = await runRenameFile('src/Counter.tsx', 'src/Score.tsx', { cwd: fx.dir, ...options })
      assert.deepEqual(result.regressions, [])
      writeChanges(result.changes)
      renameSync(result.fileMove.from, result.fileMove.to)
      if (result.selfChange)
        fx.write('src/Score.tsx', result.selfChange.after)
      assert.deepEqual(solidSyntax(fx, 'src/App.tsx').imports, [{ from: './Score', imported: 'Counter', local: 'ScoreCounter' }])
      assert.deepEqual(solidSyntax(fx, 'src/App.tsx').tags, ['ScoreCounter'])
      assertSolidDiagnostics(fx)
    }
    finally { fx.cleanup() }
  })

  it('renames Solid class and classList tokens while keeping conditions typed', async () => {
    const fx = makeSolidFixture()
    try {
      assertSolidDiagnostics(fx)
      const result = await runCssClassRename(new Map([['bg-gray-500', 'bg-neutral-500'], ['text-gray-900', 'text-neutral-900']]), { cwd: fx.dir })
      writeChanges(result.changes)
      const attributes = solidSyntax(fx, 'src/Counter.tsx').attributes
      assert.deepEqual(attributes.filter(attr => attr.name === 'class' || attr.name === 'classList'), [
        { name: 'class', values: ['bg-neutral-500 text-white'] },
        { name: 'classList', values: ['text-neutral-900'] },
      ])
      assertSolidDiagnostics(fx)
    }
    finally { fx.cleanup() }
  })
})
