import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { runDelete, runMove, runRename, runRenameFile } from 'ripide-api'
import ts from 'typescript'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

function fixture() {
  return makeFixture({
    'nuxt.config.ts': 'export default {}',
    '.ignore': '.nuxt\nnode_modules\n',
    'app/utils/format.ts': 'export const format = (value: number) => value + 1',
    'server/utils/format.ts': 'export const format = (value: number) => value * 10',
    'app/consumer.ts': 'export const result = format(7)',
    'server/api/consumer.ts': 'export const result = format(7)',
    '.nuxt/imports.d.ts': `export { format } from '../app/utils/format'`,
    '.nuxt/types/imports.d.ts': `declare global { const format: typeof import('../../app/utils/format').format } export {}`,
    '.nuxt/types/nitro-imports.d.ts': `declare global { const format: typeof import('../../server/utils/format').format } export { format } from '../../server/utils/format'`,
  })
}

function evaluate(source: string, globals: Record<string, unknown> = {}, imported: Record<string, unknown> = {}): Record<string, unknown> {
  const exports = {}
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports, ...globals, require: () => imported })
  return exports
}

function layerFixture(include = '../layers/*/shared/**/*', exclude: string[] = []) {
  const fx = fixture()
  fx.write('shared/utils/format.ts', 'export const format = (value: number) => value * 100')
  fx.write('layers/admin/nuxt.config.ts', 'export default {}')
  fx.write('layers/admin/shared/consumer.ts', 'export const result = format(7)')
  fx.write('.nuxt/types/shared-imports.d.ts', `declare global { const format: typeof import('../../shared/utils/format').format } export {}`)
  fx.write('.nuxt/tsconfig.shared.json', JSON.stringify({ include: ['../shared/**/*', include], exclude }))
  return fx
}

it.each(['../layers/*/shared/**/*', '../layers/admin/shared', '../layers/*/shared/*.ts'])('keeps shared layer consumers bound to their runtime: %s', async (include) => {
  const fx = layerFixture(include)
  try {
    const app = await runRename('format', 'pretty', { cwd: fx.dir, scope: 'app/utils/format.ts', verifyMode: 'none' as const })
    assert.equal(app.changes.find(change => change.rel === 'layers/admin/shared/consumer.ts'), undefined)
    const shared = await runRename('format', 'pretty', { cwd: fx.dir, scope: 'shared/utils/format.ts', verifyMode: 'none' as const })
    const provider = evaluate(shared.changes.find(change => change.rel === 'shared/utils/format.ts')!.after)
    assert.equal(evaluate(shared.changes.find(change => change.rel === 'layers/admin/shared/consumer.ts')!.after, provider).result, 700)
  }
  finally { fx.cleanup() }
})

it('refuses deletion of a shared provider used by a wildcard layer', async () => {
  const fx = layerFixture()
  try {
    await assert.rejects(runDelete('format', 'shared/utils/format.ts', { cwd: fx.dir, verifyMode: 'none' as const }), /auto-imports.*layers\/admin\/shared\/consumer.ts/)
  }
  finally { fx.cleanup() }
})

it('imports a moved shared provider in its wildcard layer consumer', async () => {
  const fx = layerFixture()
  try {
    const result = await runMove('format', 'shared/utils/format.ts', 'lib/format.ts', { cwd: fx.dir, verifyMode: 'none' as const })
    const provider = evaluate(result.changes.find(change => change.rel === 'lib/format.ts')!.after)
    assert.equal(evaluate(result.changes.find(change => change.rel === 'layers/admin/shared/consumer.ts')!.after, {}, provider).result, 700)
    assert.equal(result.changes.find(change => change.rel === 'app/consumer.ts'), undefined)
  }
  finally { fx.cleanup() }
})

it.each(['../layers/admin/shared', '../layers/*/shared/**/*', '../layers/admin/shared/consumer.ts'])('honors generated runtime exclusions: %s', async (exclude) => {
  const fx = layerFixture('../layers/admin/shared/**/*', [exclude])
  try {
    const result = await runRename('format', 'pretty', { cwd: fx.dir, scope: 'app/utils/format.ts', verifyMode: 'none' as const })
    const provider = evaluate(result.changes.find(change => change.rel === 'app/utils/format.ts')!.after)
    assert.equal(evaluate(result.changes.find(change => change.rel === 'layers/admin/shared/consumer.ts')!.after, provider).result, 8)
  }
  finally { fx.cleanup() }
})

it('uses plain server directories from generated runtime includes', async () => {
  const fx = fixture()
  try {
    fx.write('modules/admin/server/consumer.ts', 'export const result = format(7)')
    fx.write('.nuxt/tsconfig.server.json', JSON.stringify({ include: ['../server/**/*', '../modules/admin/server'] }))
    const result = await runRename('format', 'pretty', { cwd: fx.dir, scope: 'server/utils/format.ts', verifyMode: 'none' as const })
    const provider = evaluate(result.changes.find(change => change.rel === 'server/utils/format.ts')!.after)
    assert.equal(evaluate(result.changes.find(change => change.rel === 'modules/admin/server/consumer.ts')!.after, provider).result, 70)
  }
  finally { fx.cleanup() }
})

it.each(['app', 'server'])('renames only the active %s auto-import provider', async (realm) => {
  const fx = fixture()
  try {
    const other = realm === 'app' ? 'server' : 'app'
    const result = await runRename('format', 'pretty', { cwd: fx.dir, scope: `${realm}/utils/format.ts`, verifyMode: 'none' as const })
    const provider = evaluate(result.changes.find(change => change.rel === `${realm}/utils/format.ts`)!.after)
    const consumer = realm === 'server' ? 'server/api/consumer.ts' : 'app/consumer.ts'
    assert.equal(evaluate(result.changes.find(change => change.rel === consumer)!.after, provider).result, realm === 'server' ? 70 : 8)
    const otherConsumer = other === 'server' ? 'server/api/consumer.ts' : 'app/consumer.ts'
    assert.equal(result.changes.find(change => change.rel === otherConsumer), undefined)
    assert.equal(evaluate(fx.read(otherConsumer), evaluate(fx.read(`${other}/utils/format.ts`))).result, other === 'server' ? 70 : 8)
    assert.equal(result.changes.some(change => change.rel.startsWith('.nuxt/')), false)
  }
  finally { fx.cleanup() }
})

it('refuses deletion of an active Nitro auto-import', async () => {
  const fx = fixture()
  try {
    await assert.rejects(runDelete('format', 'server/utils/format.ts', { cwd: fx.dir, verifyMode: 'none' as const }), /auto-imports.*server\/api\/consumer.ts/)
  }
  finally { fx.cleanup() }
})

it('imports a moved Nitro provider only in server consumers', async () => {
  const fx = fixture()
  try {
    const result = await runMove('format', 'server/utils/format.ts', 'lib/format.ts', { cwd: fx.dir, verifyMode: 'none' as const })
    const provider = evaluate(result.changes.find(change => change.rel === 'lib/format.ts')!.after)
    assert.equal(evaluate(result.changes.find(change => change.rel === 'server/api/consumer.ts')!.after, {}, provider).result, 70)
    assert.equal(result.changes.find(change => change.rel === 'app/consumer.ts'), undefined)
  }
  finally { fx.cleanup() }
})

it('uses root metadata for a registered layer with no generated directory', async () => {
  const fx = fixture()
  try {
    fx.write('nuxt.config.ts', `export default { extends: ['./optional-layers/admin'] }`)
    fx.write('optional-layers/admin/nuxt.config.ts', 'export default {}')
    fx.write('optional-layers/admin/server/api/consumer.ts', 'export const result = format(3)')
    fx.write('.nuxt/tsconfig.server.json', JSON.stringify({ include: ['../server/**/*', '../optional-layers/admin/server/**/*'] }))
    const result = await runRename('format', 'pretty', { cwd: fx.dir, scope: 'server/utils/format.ts', verifyMode: 'none' as const })
    const provider = evaluate(result.changes.find(change => change.rel === 'server/utils/format.ts')!.after)
    assert.equal(evaluate(result.changes.find(change => change.rel === 'optional-layers/admin/server/api/consumer.ts')!.after, provider).result, 30)
  }
  finally { fx.cleanup() }
})

it.each(['format', 'format as local'])('renames explicit #imports bindings while preserving local names: %s', async (binding) => {
  const fx = fixture()
  try {
    const local = binding.includes(' as ') ? 'local' : 'format'
    fx.write('app/explicit.ts', `import { ${binding} } from '#imports'; export const result = ${local}(7)`)
    const result = await runRename('format', 'pretty', { cwd: fx.dir, scope: 'app/utils/format.ts', verifyMode: 'none' as const })
    const provider = evaluate(result.changes.find(change => change.rel === 'app/utils/format.ts')!.after)
    assert.equal(evaluate(result.changes.find(change => change.rel === 'app/explicit.ts')!.after, {}, provider).result, 8)
  }
  finally { fx.cleanup() }
})

it.each(['move', 'rename-file'])('verifies a %s to a new directory through a Nuxt alias', async (operation) => {
  const fx = fixture()
  try {
    fx.write('.nuxt/tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '~~/*': ['../*'], '#server/*': ['../server/*'] } } }))
    const result = operation === 'move'
      ? await runMove('format', 'server/utils/format.ts', 'lib/format.ts', { cwd: fx.dir })
      : await runRenameFile('server/utils/format.ts', 'lib/format.ts', { cwd: fx.dir })
    assert.deepEqual(result.regressions, [])
    const provider = evaluate(operation === 'move' ? result.changes.find(change => change.rel === 'lib/format.ts')!.after : fx.read('server/utils/format.ts'))
    assert.equal(evaluate(result.changes.find(change => change.rel === 'server/api/consumer.ts')!.after, {}, provider).result, 70)
  }
  finally { fx.cleanup() }
})

it('keeps unrelated app #imports consumers out of server rename warnings', async () => {
  const fx = fixture()
  try {
    fx.write('app/explicit.ts', `import { format as appFormat } from '#imports'; export const result = appFormat(7)`)
    const result = await runRename('format', 'pretty', { cwd: fx.dir, scope: 'server/utils/format.ts', verifyMode: 'none' as const })
    assert.deepEqual(result.warnings, [])
    assert.equal(evaluate(fx.read('app/explicit.ts'), {}, evaluate(fx.read('app/utils/format.ts'))).result, 8)
  }
  finally { fx.cleanup() }
})

it('keeps missing dependencies visible while verifying a moved Nitro provider', async () => {
  const fx = fixture()
  try {
    fx.write('server/utils/format.ts', `import { missing } from 'missing-package'; export const format = (n: number) => missing(n)`)
    fx.write('.nuxt/tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '~~/*': ['../*'], '#server/*': ['../server/*'] } } }))
    const result = await runMove('format', 'server/utils/format.ts', 'lib/format.ts', { cwd: fx.dir })
    assert.ok(result.regressions.some(regression => regression.code === 2307 && regression.file.endsWith('/lib/format.ts') && regression.message.includes('missing-package')))
  }
  finally { fx.cleanup() }
})

it.each(['format', 'format as local', '\'format\''])('preserves #imports re-export names: %s', async (binding) => {
  const fx = fixture()
  try {
    fx.write('app/barrel.ts', `export { ${binding} } from '#imports'`)
    const result = await runRename('format', 'pretty', { cwd: fx.dir, scope: 'app/utils/format.ts', verifyMode: 'none' as const })
    const provider = evaluate(result.changes.find(change => change.rel === 'app/utils/format.ts')!.after)
    const barrel = evaluate(result.changes.find(change => change.rel === 'app/barrel.ts')!.after, {}, provider)
    const exported = binding.includes(' as ') ? 'local' : 'format'
    assert.equal((barrel[exported] as (n: number) => number)(7), 8)
  }
  finally { fx.cleanup() }
})

it('preserves unaliased #imports locals when TypeScript resolves the generated barrel', async () => {
  const fx = fixture()
  try {
    const config = JSON.parse(fx.read('tsconfig.json'))
    config.compilerOptions.paths = { '#imports': ['./.nuxt/imports.d.ts'] }
    fx.write('tsconfig.json', JSON.stringify(config))
    fx.write('app/explicit.ts', `import { format } from '#imports'; export const result = format(7)`)
    const result = await runRename('format', 'pretty', { cwd: fx.dir, scope: 'app/utils/format.ts', verifyMode: 'none' as const })
    const provider = evaluate(result.changes.find(change => change.rel === 'app/utils/format.ts')!.after)
    assert.equal(evaluate(result.changes.find(change => change.rel === 'app/explicit.ts')!.after, {}, provider).result, 8)
  }
  finally { fx.cleanup() }
})

it('uses app preparation over a registered layer own generated metadata', async () => {
  const fx = fixture()
  try {
    fx.write('nuxt.config.ts', `export default { extends: ['./optional-layers/admin'] }`)
    fx.write('optional-layers/admin/nuxt.config.ts', 'export default {}')
    fx.write('optional-layers/admin/.nuxt/imports.d.ts', 'export {}')
    fx.write('optional-layers/admin/server/api/consumer.ts', 'export const result = format(3)')
    fx.write('.nuxt/tsconfig.server.json', JSON.stringify({ include: ['../server/**/*', '../optional-layers/admin/server/**/*'] }))
    const result = await runRename('format', 'pretty', { cwd: fx.dir, scope: 'server/utils/format.ts', verifyMode: 'none' as const })
    const provider = evaluate(result.changes.find(change => change.rel === 'server/utils/format.ts')!.after)
    assert.equal(evaluate(result.changes.find(change => change.rel === 'optional-layers/admin/server/api/consumer.ts')!.after, provider).result, 30)
  }
  finally { fx.cleanup() }
})
