import assert from 'node:assert/strict'
import { renameSync } from 'node:fs'
import { describe, it } from 'vitest'
import { runCssClassRename, runCssClassScan, runMove, runRename, runRenameFile, scan, writeChanges } from '../packages/core/src/index.ts'
import { assertSolidDiagnostics, makeSolidFixture, renderSolidFixture, solidModuleValue, solidSyntax } from './solid-helpers.ts'

const options = { vue: false, verify: 'project' as const }

describe('solid TSX refactors', () => {
  it('renames components while preserving consumer aliases and control flow', async () => {
    const fx = makeSolidFixture()
    try {
      assertSolidDiagnostics(fx)
      const markup = renderSolidFixture(fx)
      assert.equal(markup, '<section class="bg-gray-500 text-white text-gray-900"><button>1</button><span>Score: 1</span></section>')
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
      assert.equal(renderSolidFixture(fx), markup)
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
      const markup = renderSolidFixture(fx)
      const result = await runRename(from, to, { cwd: fx.dir, scope: 'src/Counter.tsx', ...options })
      assert.deepEqual(result.regressions, [])
      writeChanges(result.changes)
      assert.deepEqual(solidSyntax(fx, 'src/Counter.tsx').calls, calls)
      assertSolidDiagnostics(fx)
      assert.equal(renderSolidFixture(fx), markup)
    }
    finally { fx.cleanup() }
  })

  it('scans Solid component references through an import alias', () => {
    const fx = makeSolidFixture()
    try {
      const hits = scan('ScoreCounter', { cwd: fx.dir })
      assert.deepEqual(hits.map(hit => ({ file: hit.file, line: hit.line })), [
        { file: 'src/App.tsx', line: 1 },
        { file: 'src/App.tsx', line: 4 },
      ])
    }
    finally { fx.cleanup() }
  })

  it('moves a signal component and carries its framework and props dependencies', async () => {
    const fx = makeSolidFixture()
    try {
      assertSolidDiagnostics(fx)
      const markup = renderSolidFixture(fx)
      const result = await runMove('Counter', 'src/Counter.tsx', 'src/components/Counter.tsx', { cwd: fx.dir, ...options })
      assert.deepEqual(result.regressions, [])
      writeChanges(result.changes)
      const moved = solidSyntax(fx, 'src/components/Counter.tsx')
      assert.deepEqual(moved.declarations, ['Counter'])
      const importsByName = (a: { imported: string }, b: { imported: string }) => a.imported.localeCompare(b.imported)
      assert.deepEqual(moved.imports.slice().sort(importsByName), [
        { from: 'solid-js', imported: 'createSignal', local: 'createSignal' },
        { from: 'solid-js', imported: 'For', local: 'For' },
        { from: 'solid-js', imported: 'Show', local: 'Show' },
        { from: '../Counter', imported: 'CounterProps', local: 'CounterProps' },
      ].sort(importsByName))
      assert.deepEqual(solidSyntax(fx, 'src/App.tsx').imports, [{ from: './components/Counter', imported: 'Counter', local: 'ScoreCounter' }])
      assertSolidDiagnostics(fx)
      assert.equal(renderSolidFixture(fx), markup)
    }
    finally { fx.cleanup() }
  })

  it('renames component files and preserves the consumer JSX binding', async () => {
    const fx = makeSolidFixture()
    try {
      assertSolidDiagnostics(fx)
      const markup = renderSolidFixture(fx)
      const result = await runRenameFile('src/Counter.tsx', 'src/Score.tsx', { cwd: fx.dir, ...options })
      assert.deepEqual(result.regressions, [])
      writeChanges(result.changes)
      renameSync(result.fileMove.from, result.fileMove.to)
      if (result.selfChange)
        fx.write('src/Score.tsx', result.selfChange.after)
      assert.deepEqual(solidSyntax(fx, 'src/App.tsx').imports, [{ from: './Score', imported: 'Counter', local: 'ScoreCounter' }])
      assert.deepEqual(solidSyntax(fx, 'src/App.tsx').tags, ['ScoreCounter'])
      assertSolidDiagnostics(fx)
      assert.equal(renderSolidFixture(fx), markup)
    }
    finally { fx.cleanup() }
  })

  it('renames Solid class and classList tokens while keeping conditions typed', async () => {
    const fx = makeSolidFixture()
    try {
      assertSolidDiagnostics(fx)
      assert.deepEqual(runCssClassScan({ cwd: fx.dir, pattern: ['text-gray-*'] }), [
        { token: 'text-gray-900', count: 1, files: ['src/Counter.tsx'] },
      ])
      const result = await runCssClassRename(new Map([['bg-gray-500', 'bg-neutral-500'], ['text-gray-900', 'text-neutral-900']]), { cwd: fx.dir })
      writeChanges(result.changes)
      const attributes = solidSyntax(fx, 'src/Counter.tsx').attributes
      assert.deepEqual(attributes.filter(attr => attr.name === 'class' || attr.name === 'classList'), [
        { name: 'class', values: ['bg-neutral-500 text-white'] },
        { name: 'classList', values: ['text-neutral-900'] },
      ])
      assertSolidDiagnostics(fx)
      assert.match(renderSolidFixture(fx), /class="bg-neutral-500 text-white text-neutral-900"/)
    }
    finally { fx.cleanup() }
  })

  it.each(['value', 'rest', 'others'])('renames nested destructured %s bindings and preserves local shadows', async (from) => {
    const fx = makeSolidFixture()
    try {
      fx.write('src/state.ts', `
export const { state: [value = 3, ...rest], ...others } = { state: [undefined, 8], marker: 9 }
export function read() { const value = 99; return value }
export const output = [value, rest[0], others.marker, read()]
`)
      assertSolidDiagnostics(fx)
      const result = await runRename(from, `new${from}`, { cwd: fx.dir, scope: 'src/state.ts', ...options })
      assert.deepEqual(result.regressions, [])
      writeChanges(result.changes)
      assert.deepEqual(solidModuleValue(fx, 'src/state.ts', 'output'), [3, 8, 9, 99])
      assert.deepEqual(scan(`new${from}`, { cwd: fx.dir }).map(hit => hit.line), [2, 4])
      assertSolidDiagnostics(fx)
    }
    finally { fx.cleanup() }
  })

  it('renames a local object alias without changing the input property', async () => {
    const fx = makeSolidFixture()
    try {
      fx.write('src/state.ts', `
export function read() { const { value: score = 4 } = { value: undefined }; return score }
export const output = read()
`)
      assertSolidDiagnostics(fx)
      const result = await runRename('score', 'points', { cwd: fx.dir, scope: 'src/state.ts', ...options })
      assert.deepEqual(result.regressions, [])
      writeChanges(result.changes)
      assert.equal(solidModuleValue(fx, 'src/state.ts', 'output'), 4)
      assertSolidDiagnostics(fx)
    }
    finally { fx.cleanup() }
  })

  it('rejects an object property that binds only an alias', async () => {
    const fx = makeSolidFixture()
    try {
      fx.write('src/state.ts', 'export const { value: score } = { value: 4 }')
      await assert.rejects(runRename('value', 'points', { cwd: fx.dir, scope: 'src/state.ts', ...options }), /no declaration/)
    }
    finally { fx.cleanup() }
  })

  it('rewrites bare and shorthand classList keys while preserving boolean bindings', async () => {
    const fx = makeSolidFixture()
    try {
      fx.write('src/classes.ts', `
const disabled = false
export const classList = { active: true, disabled }
`)
      fx.write('src/Classes.tsx', 'const disabled = false; export const View = () => <div classList={{ active: true, disabled }} />')
      assertSolidDiagnostics(fx)
      assert.deepEqual(runCssClassScan({ cwd: fx.dir, pattern: ['active', 'disabled'], sort: 'token' }), [
        { token: 'active', count: 2, files: ['src/Classes.tsx', 'src/classes.ts'] },
        { token: 'disabled', count: 2, files: ['src/Classes.tsx', 'src/classes.ts'] },
      ])
      const result = await runCssClassRename(new Map([['active', 'is-active'], ['disabled', 'is-disabled']]), { cwd: fx.dir })
      writeChanges(result.changes)
      assert.deepEqual(solidModuleValue(fx, 'src/classes.ts', 'classList'), { 'is-active': true, 'is-disabled': false })
      assert.deepEqual(solidSyntax(fx, 'src/Classes.tsx').attributes, [{ name: 'classList', values: ['is-active', 'is-disabled'] }])
      assertSolidDiagnostics(fx)
    }
    finally { fx.cleanup() }
  })

  it('rewrites classList keys without changing conditions or unrelated object keys', async () => {
    const fx = makeSolidFixture()
    try {
      fx.write('src/Classes.tsx', `
const marker = 'text-gray-900'
const classList = { 'text-gray-900': marker === 'text-gray-900', ['bg-gray-500']: true }
export const other = { 'text-gray-900': true }
export const View = () => <div classList={classList} data-label="bg-gray-500" />
`)
      assertSolidDiagnostics(fx)
      assert.deepEqual(runCssClassScan({ cwd: fx.dir, glob: '*Classes.tsx', sort: 'token' }), [
        { token: 'bg-gray-500', count: 1, files: ['src/Classes.tsx'] },
        { token: 'text-gray-900', count: 1, files: ['src/Classes.tsx'] },
      ])
      const result = await runCssClassRename(new Map([['bg-gray-500', 'bg-neutral-500'], ['text-gray-900', 'text-neutral-900']]), { cwd: fx.dir, glob: '*Classes.tsx' })
      writeChanges(result.changes)
      assert.deepEqual(solidSyntax(fx, 'src/Classes.tsx').strings, [
        'text-gray-900',
        'text-neutral-900',
        'text-gray-900',
        'bg-neutral-500',
        'text-gray-900',
        'bg-gray-500',
      ])
      assertSolidDiagnostics(fx)
    }
    finally { fx.cleanup() }
  })
})
