import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from '@vue/compiler-sfc'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

const require = createRequire(import.meta.url)

it('renames files through Vue when the host uses the TypeScript 7 compiler', async () => {
  const fx = makeFixture({
    'source.ts': 'export const value = 42\n',
    'consumer.ts': 'import { value } from "./source.ts"\nexport const result = value + 1\n',
    'Component.vue': '<script lang="ts">import { value } from "./source.ts"; export const result = value + 1</script><template>{{ result }}</template>\n',
  })
  try {
    const config = JSON.parse(fx.read('tsconfig.json'))
    config.include.push('**/*.vue')
    fx.write('tsconfig.json', JSON.stringify(config))
    // Redirect only the host's bare TypeScript import to its native compiler.
    // The adapter's explicitly named JavaScript API remains independent.
    const runner = fx.write('rename.ts', `
import { registerHooks } from 'node:module'
import { renameSync, writeFileSync } from 'node:fs'
registerHooks({ resolve(id, context, next) {
  return next(id === 'typescript' ? ${JSON.stringify(require.resolve('@typescript/native'))} : id, context)
} })
const { default: adapter } = await import(${JSON.stringify(pathToFileURL(resolve('packages/vue/dist/index.mjs')).href)})
const changes = await adapter.applyFileRenameEdits(${JSON.stringify(join(fx.dir, 'tsconfig.json'))}, ${JSON.stringify(fx.dir)}, ${JSON.stringify(join(fx.dir, 'source.ts'))}, ${JSON.stringify(join(fx.dir, 'renamed.ts'))})
for (const change of changes) writeFileSync(change.path, change.after)
renameSync(${JSON.stringify(join(fx.dir, 'source.ts'))}, ${JSON.stringify(join(fx.dir, 'renamed.ts'))})
`)
    execFileSync(process.execPath, [runner], { encoding: 'utf8' })
    const script = parse(fx.read('Component.vue')).descriptor.script!.content
    writeFileSync(join(fx.dir, 'component-script.ts'), script)
    const component = await import(pathToFileURL(join(fx.dir, 'component-script.ts')).href)
    assert.equal(component.result, 43)
  }
  finally { fx.cleanup() }
})
