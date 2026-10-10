import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { runMove, writeChanges } from '../packages/core/src/index.ts'
import { startTsServer } from '../packages/core/src/ts-server.ts'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'
import { makeReactFixture, reactDiagnostics, renderReactFixture } from './react-helpers.ts'

it.each([
  ['destination export alias shares its declaration', 'import { value as copied } from \'./target.ts\'\nexport function helper() { return copied }', 'const copied = 42; export { copied as value }', '42'],
  ['default expression shares its declaration', 'import copied from \'./target.ts\'\nexport function helper() { return copied }', 'const copied = 42; export default copied', '42'],
  ['nested sibling shadow', 'export const value = 42\nexport function helper() { function nested(value: number) { return value }; return value + nested(1) }', '', '43'],
  ['named destination alias', 'import { value as copied } from \'./target.ts\'\nexport function helper() { return copied }', 'export const value = 42', '42'],
  ['anonymous default destination', 'import copied from \'./target.ts\'\nexport function helper() { return copied }', 'export default 42', '42'],
  ['namespace destination', 'import * as copied from \'./target.ts\'\nexport function helper() { return copied.value }', 'export const value = 42', '42'],
  ['shadowed imported parameter', 'import { value } from \'./dependency.ts\'\nexport function helper(value = 42) { return value }', 'export const value = 99', '42'],
  ['default sibling', 'export default function value() { return 42 }\nexport function helper() { return value() }', '', '42'],
  ['nested import shadow and outer use', 'import { value } from \'./dependency.ts\'\nexport function helper() { function nested(value: number) { return value }; return value + nested(1) }', '', '43'],
])('move preserves %s at runtime', async (_, source, target, expected) => {
  const fx = makeFixture({
    'source.ts': `${source}\n`,
    'target.ts': `${target}\n`,
    'dependency.ts': 'export const value = 42\n',
  })
  try {
    const baseline = await startTsServer(fx.dir)
    try {
      const diagnostics = await baseline.diagnostics([`${fx.dir}/source.ts`, `${fx.dir}/target.ts`])
      assert.deepEqual([...diagnostics.values()].flat(), [], 'fixture must compile before the move')
    }
    finally { baseline.dispose() }
    const result = await runMove('helper', 'source.ts', 'target.ts', { ...{ cwd: fx.dir, verifyMode: 'touched' }, engine: vueServices() })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    const server = await startTsServer(fx.dir)
    try {
      const diagnostics = await server.diagnostics([`${fx.dir}/source.ts`, `${fx.dir}/target.ts`])
      assert.deepEqual([...diagnostics.values()].flat(), [])
    }
    finally { server.dispose() }
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `const target = await import(${JSON.stringify(pathToFileURL(`${fx.dir}/target.ts`).href)}); console.log(target.helper())`], { encoding: 'utf8' })
    assert.equal(output.trim(), expected)
  }
  finally { fx.cleanup() }
})

it('move rejects a captured non-exported sibling despite a nested shadow', async () => {
  const fx = makeFixture({
    'source.ts': 'const value = 42\nexport function helper() { function nested(value: number) { return value }; return value + nested(1) }\n',
    'target.ts': '',
  })
  try {
    await assert.rejects(runMove('helper', 'source.ts', 'target.ts', { ...{ cwd: fx.dir, verifyMode: 'none' as const }, engine: vueServices() }), /non-exported symbol/)
    assert.equal(fx.read('target.ts'), '')
  }
  finally { fx.cleanup() }
})

it.each([
  ['named sibling', 'export function Label() { return <strong>outer</strong> }', '<Label />', ''],
  ['default sibling', 'export default function Label() { return <strong>outer</strong> }', '<Label />', ''],
  ['destination alias', 'import { Label as Copied } from \'./target\'', '<Copied />', 'export function Label() { return <strong>outer</strong> }'],
])('move preserves JSX %s beside nested component shadows', async (_, dependency, expression, target) => {
  const fx = makeReactFixture({
    'src/source.tsx': `${dependency}
export function Button() {
  function Shadow() { const Label = () => <span>local</span>; return <Label /> }
  return <>{${expression}}<Shadow /></>
}`,
    'src/target.tsx': target,
    'src/View.tsx': 'import { Button } from \'./source\'\nexport function View() { return <Button /> }',
  })
  try {
    assert.deepEqual(reactDiagnostics(fx), [])
    const markup = renderReactFixture(fx, 'src/View.tsx')
    assert.equal(markup, '<strong>outer</strong><span>local</span>')
    const result = await runMove('Button', 'src/source.tsx', 'src/target.tsx', { ...{ cwd: fx.dir, verifyMode: 'project' }, engine: vueServices() })
    assert.deepEqual(result.regressions, [])
    writeChanges(result.changes)
    assert.deepEqual(reactDiagnostics(fx), [])
    assert.equal(renderReactFixture(fx, 'src/View.tsx'), markup)
  }
  finally { fx.cleanup() }
})
