import { afterEach, describe, expect, it } from 'vitest'
import { runCssClassRename, runCssClassScan, runMove, runRename, runReplace, scan, writeChanges } from '../packages/core/src/index.ts'
import { vueServices } from './engine-fixture.ts'
import { makeReactFixture, reactDiagnostics, renderReactFixture } from './react-helpers.ts'

const fixtures: ReturnType<typeof makeReactFixture>[] = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})
function fixture(files: Record<string, string>) {
  const value = makeReactFixture(files)
  fixtures.push(value)
  return value
}

describe('react JSX refactors', () => {
  it.each(['tsx', 'jsx'])('renames %s component tags and preserves aliases and shadowed bindings', async (extension) => {
    const fx = fixture({
      [`src/Button.${extension}`]: 'export function Button() { return <button>primary</button> }',
      [`src/Direct.${extension}`]: `import { Button } from './Button'\nexport function Direct() { return <Button></Button> }`,
      [`src/View.${extension}`]: `import { Button as Action } from './Button'
import { Direct } from './Direct'
function Shadow() {
  const Button = () => <span>local</span>
  return <Button />
}
export function View() { return <><Action /><Direct /><Shadow /></> }`,
    })
    expect(reactDiagnostics(fx)).toEqual([])
    const before = renderReactFixture(fx, `src/View.${extension}`)
    expect(before).toBe('<button>primary</button><button>primary</button><span>local</span>')
    const result = await runRename('Button', 'PrimaryButton', { ...{ cwd: fx.dir, scope: `src/Button.${extension}`, verify: 'project' }, engine: vueServices() })
    expect(result.regressions).toEqual([])
    writeChanges(result.changes)
    expect(reactDiagnostics(fx)).toEqual([])
    expect(renderReactFixture(fx, `src/View.${extension}`)).toBe(before)
    expect(scan('PrimaryButton', { ...{ cwd: fx.dir }, engine: vueServices() }).map(hit => hit.file).sort()).toEqual([
      `src/Button.${extension}`,
      `src/Direct.${extension}`,
      `src/Direct.${extension}`,
      `src/Direct.${extension}`,
      `src/View.${extension}`,
    ])
  })

  it('moves a TSX component with hook and type dependencies into a nested directory', async () => {
    const fx = fixture({
      'src/types.ts': 'export interface ButtonProps { label: string }',
      'src/Button.tsx': `import { useState } from 'react'
import type { ButtonProps } from './types'
export function Button({ label }: ButtonProps) {
  const [count] = useState(2)
  return <button>{label}: {count}</button>
}
export function Footer() { return <Button label="footer" /> }`,
      'src/View.tsx': `import { Button as Action, Footer } from './Button'
export function View() { return <><Action label="main" /><Footer /></> }`,
      'src/components/Button.tsx': '',
    })
    expect(reactDiagnostics(fx)).toEqual([])
    const result = await runMove('Button', 'src/Button.tsx', 'src/components/Button.tsx', { ...{ cwd: fx.dir, verify: 'project' }, engine: vueServices() })
    expect(result.regressions).toEqual([])
    writeChanges(result.changes)
    expect(reactDiagnostics(fx)).toEqual([])
    expect(renderReactFixture(fx, 'src/View.tsx')).toBe('<button>main: 2</button><button>footer: 2</button>')
  })

  it('replaces JSX component references without rewriting a wrapper into recursion', async () => {
    const fx = fixture({
      'src/Button.tsx': 'export function Button() { return <button>primary</button> }',
      'src/PrimaryButton.tsx': `import { Button } from './Button'
export function PrimaryButton() { return <section><Button /></section> }`,
      'src/View.tsx': `import { Button } from './Button'
export function View() { return <><Button /><Button /></> }`,
    })
    expect(reactDiagnostics(fx)).toEqual([])
    const result = await runReplace('Button', 'PrimaryButton', { ...{ cwd: fx.dir, targetScope: 'src/PrimaryButton.tsx', verify: 'project' }, engine: vueServices() })
    expect(result.regressions).toEqual([])
    writeChanges(result.changes)
    expect(reactDiagnostics(fx)).toEqual([])
    expect(renderReactFixture(fx, 'src/View.tsx')).toBe('<section><button>primary</button></section><section><button>primary</button></section>')
  })

  it('moves a component that renders an exported sibling', async () => {
    const fx = fixture({
      'src/Button.tsx': `const title = 'unrelated local'
export function Label() { return <strong>label</strong> }
export function Button() { return <button title="action"><Label /></button> }`,
      'src/View.tsx': `import { Button } from './Button'
export function View() { return <Button /> }`,
      'src/components/Button.tsx': '',
    })
    expect(reactDiagnostics(fx)).toEqual([])
    const result = await runMove('Button', 'src/Button.tsx', 'src/components/Button.tsx', { ...{ cwd: fx.dir, verify: 'project' }, engine: vueServices() })
    expect(result.regressions).toEqual([])
    writeChanges(result.changes)
    expect(reactDiagnostics(fx)).toEqual([])
    expect(renderReactFixture(fx, 'src/View.tsx')).toBe('<button title="action"><strong>label</strong></button>')
  })

  it('moves a member JSX tag without treating its property as a local dependency', async () => {
    const fx = fixture({
      'src/Button.tsx': `const Label = 'unrelated local'
export const Icons = { Label: () => <strong>icon</strong> }
export function Button() { return <Icons.Label /> }`,
      'src/View.tsx': `import { Button } from './Button'
export function View() { return <Button /> }`,
      'src/components/Button.tsx': '',
    })
    expect(reactDiagnostics(fx)).toEqual([])
    const result = await runMove('Button', 'src/Button.tsx', 'src/components/Button.tsx', { ...{ cwd: fx.dir, verify: 'project' }, engine: vueServices() })
    expect(result.regressions).toEqual([])
    writeChanges(result.changes)
    expect(reactDiagnostics(fx)).toEqual([])
    expect(renderReactFixture(fx, 'src/View.tsx')).toBe('<strong>icon</strong>')
  })

  it('preserves a local export alias when moving its component', async () => {
    const fx = fixture({
      'src/Button.tsx': `export function Button() { return <button>alias</button> }
export { Button as Action }`,
      'src/View.tsx': `import { Action } from './Button'
export function View() { return <Action /> }`,
      'src/components/Button.tsx': '',
    })
    expect(reactDiagnostics(fx)).toEqual([])
    const result = await runMove('Button', 'src/Button.tsx', 'src/components/Button.tsx', { ...{ cwd: fx.dir, verify: 'project' }, engine: vueServices() })
    expect(result.regressions).toEqual([])
    writeChanges(result.changes)
    expect(reactDiagnostics(fx)).toEqual([])
    expect(renderReactFixture(fx, 'src/View.tsx')).toBe('<button>alias</button>')
  })

  it.each(['tsx', 'jsx'])('scans and renames %s className literals and conditional classes', async (extension) => {
    const fx = fixture({
      [`src/View.${extension}`]: `const active = true
export function View() {
  return <><div className="bg-red-500 hover:bg-red-500">bg-red-500</div><span className={active ? 'bg-red-500' : 'bg-blue-500'} /></>
}`,
    })
    expect(runCssClassScan({ ...{ cwd: fx.dir, pattern: ['bg-red-500'] }, engine: vueServices() })).toEqual([
      { token: 'bg-red-500', count: 3, files: [`src/View.${extension}`] },
    ])
    writeChanges((await runCssClassRename(new Map([['bg-red-500', 'bg-green-500']]), { ...{ cwd: fx.dir }, engine: vueServices() })).changes)
    expect(reactDiagnostics(fx)).toEqual([])
    expect(renderReactFixture(fx, `src/View.${extension}`)).toBe('<div class="bg-green-500 hover:bg-green-500">bg-red-500</div><span class="bg-green-500"></span>')
    expect(runCssClassScan({ ...{ cwd: fx.dir, pattern: ['bg-red-500'] }, engine: vueServices() })).toEqual([])
  })
})
