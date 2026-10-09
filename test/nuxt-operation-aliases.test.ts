import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { runMove } from 'ripide-api'
import ts from 'typescript'
import { it } from 'vitest'

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'ripide-nuxt-operation-'))
  const write = (path: string, source: string) => {
    mkdirSync(join(cwd, path, '..'), { recursive: true })
    writeFileSync(join(cwd, path), source)
  }
  write('package.json', JSON.stringify({ dependencies: { nuxt: '4.5.2' } }))
  write('nuxt.config.ts', 'export default {}')
  write('tsconfig.json', JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', noEmit: true }, include: ['**/*.ts'] }))
  write('.ignore', '.nuxt\nnode_modules\n')
  write('.nuxt/imports.d.ts', `declare global { const format: typeof import('#providers/format')['format'] } export {}`)
  write('app/utils/format.ts', 'export const format = (value: number) => value + 1')
  write('app/active/format.ts', 'export const format = (value: number) => value * 10')
  write('app/pages/consumer.ts', 'export const result = format(7)')
  write('lib/format.ts', '')
  const configure = (provider: string, destination: string) => write('.nuxt/tsconfig.json', JSON.stringify({
    compilerOptions: { baseUrl: '..', paths: { '#providers/*': [`${provider}/*`], '#destination/*': [`${destination}/*`] } },
  }))
  configure('app/utils', 'lib')
  return { cwd, write, configure }
}

function evaluate(source: string, require: (specifier: string) => unknown, globals: Record<string, unknown> = {}): Record<string, unknown> {
  const exports = {}
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, require, ...globals })
  return exports
}

it('refreshes generated provider aliases between move operations', async () => {
  const fx = fixture()
  try {
    const first = await runMove('format', 'app/utils/format.ts', 'lib/format.ts', { cwd: fx.cwd, verify: false })
    const destination = evaluate(first.changes.find(change => change.rel === 'lib/format.ts')!.after, () => assert.fail('unexpected import'))
    assert.equal(evaluate(first.changes.find(change => change.rel === 'app/pages/consumer.ts')!.after, () => destination).result, 8)

    fx.configure('app/active', 'lib')
    const second = await runMove('format', 'app/utils/format.ts', 'lib/format.ts', { cwd: fx.cwd, verify: false })
    assert.equal(second.changes.find(change => change.rel === 'app/pages/consumer.ts'), undefined)
    const active = evaluate(readFileSync(join(fx.cwd, 'app/active/format.ts'), 'utf8'), () => assert.fail('unexpected import'))
    assert.equal(evaluate(readFileSync(join(fx.cwd, 'app/pages/consumer.ts'), 'utf8'), () => assert.fail('unexpected import'), active).result, 70)
  }
  finally { rmSync(fx.cwd, { recursive: true, force: true }) }
})

it('refreshes consumer import aliases between move operations', async () => {
  const fx = fixture()
  try {
    for (const destination of ['lib', 'other']) {
      fx.configure('app/utils', destination)
      const result = await runMove('format', 'app/utils/format.ts', 'lib/format.ts', { cwd: fx.cwd, verify: false })
      const provider = evaluate(result.changes.find(change => change.rel === 'lib/format.ts')!.after, () => assert.fail('unexpected import'))
      const consumer = result.changes.find(change => change.rel === 'app/pages/consumer.ts')!
      const value = evaluate(consumer.after, (specifier) => {
        const target = specifier.startsWith('#destination/')
          ? resolve(fx.cwd, destination, specifier.slice('#destination/'.length))
          : resolve(fx.cwd, 'app/pages', specifier)
        assert.equal(target, resolve(fx.cwd, 'lib/format'))
        return provider
      })
      assert.equal(value.result, 8)
    }
  }
  finally { rmSync(fx.cwd, { recursive: true, force: true }) }
})
