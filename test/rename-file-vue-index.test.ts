import assert from 'node:assert/strict'
import { it } from 'vitest'
import { runRenameFile } from '../packages/core/src/index.ts'
import { parseSourceFile } from '../packages/core/src/util.ts'
import { makeFixture } from './helpers.ts'

it.each(['touched', 'none'] as const)('rewrites Vue directory-index imports with %s verification', async (verify) => {
  const fixture = makeFixture({
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'bundler', noEmit: true, baseUrl: '.', paths: { '@/*': ['./src/*'] } }, include: ['src/**/*.ts', 'src/**/*.vue'] }),
    'src/utils/index.ts': 'export const amount = 42\n',
    'src/Relative.vue': '<script setup lang="ts">import { amount } from "./utils"</script><template>{{ amount }}</template>',
    'src/Alias.vue': '<script setup lang="ts">import { amount } from "@/utils"</script><template>{{ amount }}</template>',
  })
  try {
    const result = await runRenameFile('src/utils/index.ts', 'src/utils/value.ts', { cwd: fixture.dir, verify })
    for (const [file, specifier] of [['src/Relative.vue', './utils/value'], ['src/Alias.vue', '@/utils/value']]) {
      const change = result.changes.find(change => change.rel === file)
      assert.ok(change, `Vue consumer ${file} must follow the moved module`)
      const program = parseSourceFile(file, change.after).program
      const imported = program.body.find((statement: any) => statement.type === 'ImportDeclaration')
      assert.equal(imported.source.value, specifier)
    }
    assert.deepEqual(result.regressions, [])
    assert.deepEqual(result.warnings, [])
  }
  finally { fixture.cleanup() }
})
