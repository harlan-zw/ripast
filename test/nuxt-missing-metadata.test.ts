import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { runRename, writeChanges } from 'ripide-api'
import { it } from 'vitest'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

function fixture(directory: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ripide-nuxt-metadata-'))
  cpSync(new URL('./fixtures/nuxt/', import.meta.url), dir, { recursive: true })
  rmSync(join(dir, '.nuxt/imports.d.ts'))
  rmSync(join(dir, '.nuxt/types/imports.d.ts'), { force: true })
  mkdirSync(join(dir, directory), { recursive: true })
  if (directory.startsWith('apps/site/'))
    writeFileSync(join(dir, 'apps/site/nuxt.config.ts'), 'export default {}')
  mkdirSync(join(dir, 'app/pages'), { recursive: true })
  rmSync(join(dir, 'pages'), { recursive: true })
  const provider = join(directory, 'format.ts')
  const before = 'export function format(value: number) { return "#" + value }'
  const page = '<script setup lang="ts">const label = format(1)</script><template>{{ format(2) }}</template>'
  writeFileSync(join(dir, provider), before)
  writeFileSync(join(dir, 'app/pages/index.vue'), page)
  return { dir, provider, before, page }
}

it.each([
  ['app/utils', undefined],
  ['app/utils', false],
  ['app/composables', undefined],
  ['app/composables', false],
  ['apps/site/app/utils', undefined],
  ['apps/site/app/composables', false],
] as const)('refuses a Nuxt %s provider rename without metadata with verify %s', async (directory, verify) => {
  const fx = fixture(directory)
  try {
    await assert.rejects(runRename('format', 'pretty', { ...{ cwd: fx.dir, scope: fx.provider, verify }, engine: vueServices() }), /cannot resolve auto-import metadata/)
    assert.equal(readFileSync(join(fx.dir, fx.provider), 'utf8'), fx.before)
    assert.equal(readFileSync(join(fx.dir, 'app/pages/index.vue'), 'utf8'), fx.page)
    assert.equal(existsSync(join(fx.dir, '.nuxt/imports.d.ts')), false)
    assert.equal(existsSync(join(fx.dir, '.nuxt/types/imports.d.ts')), false)
  }
  finally { rmSync(fx.dir, { recursive: true, force: true }) }
})

it.each([
  ['app/utils', false],
  ['app/utils', true],
  ['app/composables', false],
  ['app/composables', true],
] as const)('cLI refuses apply for a Nuxt %s provider without metadata with noVerify=%s', (directory, noVerify) => {
  const fx = fixture(directory)
  try {
    const result = spawnSync(process.execPath, [
      '--experimental-strip-types',
      '--no-warnings',
      resolve('packages/cli/src/cli.ts'),
      'rename',
      'format',
      'pretty',
      '--scope',
      fx.provider,
      '--json',
      '--apply',
      ...(noVerify ? ['--no-verify'] : []),
    ], { cwd: fx.dir, encoding: 'utf8' })
    assert.notEqual(result.status, 0, result.stdout)
    assert.match(result.stderr, /cannot resolve auto-import metadata/)
    assert.equal(readFileSync(join(fx.dir, fx.provider), 'utf8'), fx.before)
    assert.equal(readFileSync(join(fx.dir, 'app/pages/index.vue'), 'utf8'), fx.page)
    assert.equal(existsSync(join(fx.dir, '.nuxt/imports.d.ts')), false)
    assert.equal(existsSync(join(fx.dir, '.nuxt/types/imports.d.ts')), false)
  }
  finally { rmSync(fx.dir, { recursive: true, force: true }) }
})

it.each([false, true])('permits explicit imports without Nuxt metadata when Nuxt=%s and the declaration is unrelated', async (nuxt) => {
  const path = nuxt ? 'lib/format.ts' : 'app/utils/format.ts'
  const consumer = nuxt ? './lib/format.ts' : './app/utils/format.ts'
  const fx = makeFixture({
    'package.json': '{"type":"module"}',
    [path]: 'export function format(value: number) { return "#" + value }',
    'consumer.ts': `import { format } from '${consumer}'; console.log(format(1))`,
    ...(nuxt ? { 'nuxt.config.ts': 'export default {}' } : {}),
  })
  try {
    const result = await runRename('format', 'pretty', { ...{ cwd: fx.dir, scope: path, verify: false }, engine: vueServices() })
    writeChanges(result.changes)
    const execution = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'consumer.ts'], { cwd: fx.dir, encoding: 'utf8' })
    assert.equal(execution.status, 0, execution.stderr)
    assert.equal(execution.stdout.trim(), '#1')
  }
  finally { fx.cleanup() }
})
