import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { runRename, writeChanges } from 'ripide-api'
import { it } from 'vitest'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

const cases = [
  { name: 'literal srcDir', config: 'export default defineNuxtConfig({ srcDir: \'src\' })', provider: 'src/utils/format.ts' },
  { name: 'nested configured imports', context: 'apps/site/', config: 'export default { imports: { dirs: [\'custom\'] } }', provider: 'apps/site/custom/format.ts' },
  { name: 'Nuxt app configured imports', config: 'export default { imports: { dirs: [\'custom\'] } }', provider: 'app/custom/format.ts' },
  { name: 'shared utils', config: 'export default {}', provider: 'shared/utils/format.ts' },
  { name: 'literal shared directory', config: 'export default { dir: { shared: \'common\' } }', provider: 'common/utils/format.ts' },
  { name: 'configured imports within srcDir', config: 'export default { srcDir: \'src\', imports: { dirs: [\'custom\'] } }', provider: 'src/custom/format.ts' },
  { name: 'empty app with legacy pages', legacy: true, config: 'export default { imports: { dirs: [\'custom\'] } }', provider: 'custom/format.ts' },
] as const

function fixture(input: typeof cases[number]) {
  const context = 'context' in input ? input.context : ''
  const files = {
    'package.json': '{"type":"module"}',
    'nuxt.config.ts': 'export default {}',
    '.ignore': '.nuxt\nnode_modules\n',
    [`${context}nuxt.config.ts`]: input.config,
    [input.provider]: 'export function format(value: number) { return "#" + value }',
    [`${context}${context || 'legacy' in input ? '' : 'app/'}pages/index.vue`]: '<script setup lang="ts">const label = format(1)</script><template>{{ format(2) }}</template>',
    [`${context}consumer.ts`]: 'export const value = format(3)',
  }
  const fx = makeFixture(files)
  if ('legacy' in input)
    mkdirSync(join(fx.dir, 'app'))
  return { fx, files }
}

it.each([false, true])('keeps unrelated literal directories outside Nuxt provider scopes, Nuxt=%s', async (nuxt) => {
  const fx = makeFixture({
    'package.json': '{"type":"module"}',
    ...(nuxt ? { 'nuxt.config.ts': 'export default { other: { dirs: [\'lib\'] } }' } : {}),
    'lib/format.ts': 'export function format(value: number) { return "#" + value }',
    'consumer.ts': 'import { format } from "./lib/format.ts"; console.log(format(1))',
  })
  try {
    const result = await runRename('format', 'pretty', { ...{ cwd: fx.dir, scope: 'lib/format.ts' }, engine: vueServices() })
    writeChanges(result.changes)
    const execution = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'consumer.ts'], { cwd: fx.dir, encoding: 'utf8' })
    assert.equal(execution.status, 0, execution.stderr)
    assert.equal(execution.stdout.trim(), '#1')
  }
  finally { fx.cleanup() }
})

for (const input of cases) {
  it.each([undefined, false])(`SDK refuses ${input.name} without metadata, verify=%s`, async (verify) => {
    const { fx, files } = fixture(input)
    try {
      await assert.rejects(runRename('format', 'pretty', { ...{ cwd: fx.dir, scope: input.provider, verify }, engine: vueServices() }), /cannot resolve auto-import metadata/)
      for (const [path, before] of Object.entries(files)) assert.equal(fx.read(path), before)
    }
    finally { fx.cleanup() }
  })

  it.each([false, true])(`CLI refuses ${input.name} without metadata, noVerify=%s`, (noVerify) => {
    const { fx, files } = fixture(input)
    try {
      const result = spawnSync(process.execPath, [
        '--experimental-strip-types',
        '--no-warnings',
        resolve('packages/cli/src/cli.ts'),
        'rename',
        'format',
        'pretty',
        '--scope',
        input.provider,
        '--apply',
        '--json',
        ...(noVerify ? ['--no-verify'] : []),
      ], { cwd: fx.dir, encoding: 'utf8' })
      assert.notEqual(result.status, 0, result.stdout)
      assert.match(result.stderr, /cannot resolve auto-import metadata/)
      for (const [path, before] of Object.entries(files)) assert.equal(fx.read(path), before)
    }
    finally { fx.cleanup() }
  })
}

it('refuses factored configured Nuxt import providers without metadata', async () => {
  const files = {
    'package.json': '{"type":"module"}',
    'nuxt.config.ts': 'const config = { imports: { dirs: [\'custom\'] } }\nexport default defineNuxtConfig(config)\n',
    'custom/format.ts': 'export function format(value: number) { return "#" + value }',
    'pages/index.vue': '<script setup lang="ts">const label = format(1)</script><template>{{ format(2) }}</template>',
  }
  const fx = makeFixture(files)
  try {
    await assert.rejects(runRename('format', 'pretty', { ...{ cwd: fx.dir, scope: 'custom/format.ts', verify: false }, engine: vueServices() }), /cannot resolve auto-import metadata/)
    for (const [path, before] of Object.entries(files)) assert.equal(fx.read(path), before)
  }
  finally { fx.cleanup() }
})
