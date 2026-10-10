import assert from 'node:assert/strict'
import { existsSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { scan } from 'ripide-api'
import { afterEach, it, vi } from 'vitest'
import { makeFixture } from './helpers.ts'

afterEach(() => vi.unstubAllEnvs())

it.each([undefined, '0'])('scan never loads a project compiler without external-code opt-in (%s)', (value) => {
  vi.stubEnv('RIPIDE_RUN_EXTERNAL_CODE', value)
  const fx = makeFixture({
    'Card.tsrx': 'export function target() @{ <div /> }',
    'node_modules/ripide-tsrx/package.json': JSON.stringify({ name: 'ripide-tsrx', exports: { './compiler': './compiler.cjs' } }),
    'node_modules/ripide-tsrx/compiler.cjs': `require('node:fs').writeFileSync(require('node:path').join(__dirname, '../../executed'), 'yes'); throw new Error('compiler executed')`,
  })
  try {
    let error: unknown
    try {
      scan('target', { cwd: fx.dir })
    }
    catch (cause) { error = cause }
    assert.equal(existsSync(join(fx.dir, 'executed')), false)
    assert.match(String(error), /RIPIDE_RUN_EXTERNAL_CODE=1/)
  }
  finally { fx.cleanup() }
})

function compilerFixture() {
  return makeFixture({
    'Card.tsrx': 'export function Card() @{ <div>{target()}</div> }',
    'node_modules/ripide-tsrx/package.json': JSON.stringify({ name: 'ripide-tsrx', exports: { './compiler': './compiler.cjs' } }),
    'node_modules/ripide-tsrx/compiler.cjs': `module.exports = require(${JSON.stringify(resolve('packages/tsrx/src/compiler.ts'))})`,
  })
}

it('opted-in scans preserve authored positions through the real Octane compiler', () => {
  vi.stubEnv('RIPIDE_RUN_EXTERNAL_CODE', '1')
  const fx = compilerFixture()
  symlinkSync(resolve('node_modules/octane'), join(fx.dir, 'node_modules/octane'), 'junction')
  try {
    assert.deepEqual(scan('target', { cwd: fx.dir }).map(hit => [hit.file, hit.line, hit.col, hit.kind]), [
      ['Card.tsrx', 1, 33, 'identifier-reference'],
    ])
  }
  finally { fx.cleanup() }
})

it('opted-in scans explain a missing project-local Octane compiler', () => {
  vi.stubEnv('RIPIDE_RUN_EXTERNAL_CODE', '1')
  const fx = compilerFixture()
  try {
    assert.throws(() => scan('target', { cwd: fx.dir }), /requires ripide-tsrx and a project-local Octane compiler/)
  }
  finally { fx.cleanup() }
})

it('scan loads the project compiler after external-code opt-in', () => {
  vi.stubEnv('RIPIDE_RUN_EXTERNAL_CODE', '1')
  const fx = makeFixture({
    'Card.tsrx': 'export function target() @{ <div /> }',
    'node_modules/ripide-tsrx/package.json': JSON.stringify({ name: 'ripide-tsrx', exports: { './compiler': './compiler.cjs' } }),
    'node_modules/ripide-tsrx/compiler.cjs': `require('node:fs').writeFileSync(require('node:path').join(__dirname, '../../executed'), 'yes'); throw new Error('compiler executed')`,
  })
  try {
    assert.throws(() => scan('target', { cwd: fx.dir }), /requires ripide-tsrx/)
    assert.equal(fx.read('executed'), 'yes')
  }
  finally { fx.cleanup() }
})

it('scan can select ordinary TypeScript without loading a TSRX compiler', () => {
  vi.stubEnv('RIPIDE_RUN_EXTERNAL_CODE', undefined)
  const fx = makeFixture({
    'helper.ts': 'export const target = 1',
    'Card.tsrx': 'export function target() @{ <div /> }',
  })
  try {
    assert.deepEqual(scan('target', { cwd: fx.dir, glob: '*.ts' }).map(hit => [hit.file, hit.kind]), [['helper.ts', 'identifier-binding']])
  }
  finally { fx.cleanup() }
})
