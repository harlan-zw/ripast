import assert from 'node:assert/strict'
import { it } from 'vitest'
import { compactVerification } from '../packages/cli/src/presentation/index.ts'
import { runCssClassRename, runDelete, runMove, runRename, runRenameFile, runReplace, runVueTemplateUnwrap, runVueTemplateWrap } from '../packages/core/src/index.ts'
import { makeFixture } from './helpers.ts'

const files = {
  'source.ts': 'export const answer = 42\n',
  'replacement.ts': 'export const replacement = 7\n',
  'consumer.ts': 'import { answer } from "./source"\nconsole.log(answer)\n',
  'unrelated.ts': 'export const unrelated = true\n',
}

it.each([
  { command: 'rename', count: 2, scope: 'touched', run: (cwd: string) => runRename('answer', 'value', { cwd, vue: false }) },
  { command: 'move', count: 5, scope: 'touched', run: (cwd: string) => runMove('answer', 'source.ts', 'lib/value.ts', { cwd, vue: false }) },
  { command: 'delete', count: 1, scope: 'touched', run: (cwd: string) => runDelete('replacement', 'replacement.ts', { cwd }) },
  { command: 'replace', count: 4, scope: 'project', run: (cwd: string) => runReplace('answer', 'replacement', { cwd }) },
  { command: 'rename-file', count: 3, scope: 'touched', run: (cwd: string) => runRenameFile('source.ts', 'lib/value.ts', { cwd, vue: false }) },
])('$command reports files actually checked and retained new errors', async ({ run, count, scope }) => {
  const fixture = makeFixture(files)
  try {
    const result = await run(fixture.dir)
    assert.equal(result.verification._tag, 'Checked')
    if (result.verification._tag !== 'Checked')
      throw new Error('Expected completed diagnostics')
    const [check] = result.verification.checks
    assert.equal(check.checker, 'typescript')
    assert.equal(check.scope, scope)
    assert.equal(check.files, count)
    assert.equal(check.newErrors, result.regressions.length)
    assert.equal(check.newErrors, 0)
    if (check.ignoredErrors)
      assert.equal(compactVerification(result.verification)[0]?.[4], check.ignoredErrors)
    assert.equal(fixture.read('source.ts'), files['source.ts'])
  }
  finally { fixture.cleanup() }
})

it.each([
  { command: 'rename', run: (cwd: string) => runRename('answer', 'value', { cwd, verifyMode: 'none' as const, vue: false }) },
  { command: 'move', run: (cwd: string) => runMove('answer', 'source.ts', 'lib/value.ts', { cwd, verifyMode: 'none' as const, vue: false }) },
  { command: 'delete', run: (cwd: string) => runDelete('replacement', 'replacement.ts', { cwd, verifyMode: 'none' as const }) },
  { command: 'replace', run: (cwd: string) => runReplace('answer', 'replacement', { cwd, verifyMode: 'none' as const }) },
  { command: 'rename-file', run: (cwd: string) => runRenameFile('source.ts', 'lib/value.ts', { cwd, verifyMode: 'none' as const, vue: false }) },
])('$command records disabled diagnostics', async ({ run }) => {
  const fixture = makeFixture(files)
  try {
    const result = await run(fixture.dir)
    assert.deepEqual(result.verification, { _tag: 'Skipped', reason: 'disabled' })
  }
  finally { fixture.cleanup() }
})

it('unchanged refactors skip diagnostics instead of claiming a pass', async () => {
  const fixture = makeFixture(files)
  try {
    const renamed = await runRename('answer', 'answer', { cwd: fixture.dir, vue: false })
    const replaced = await runReplace('missing', 'replacement', { cwd: fixture.dir })
    assert.deepEqual(renamed.verification, { _tag: 'Skipped', reason: 'no-changes' })
    assert.deepEqual(replaced.verification, { _tag: 'Skipped', reason: 'no-changes' })
  }
  finally { fixture.cleanup() }
})

it('vue diagnostics count unchanged configured consumers', async () => {
  const fixture = makeFixture({
    'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'bundler', noEmit: true }, include: ['**/*.ts', '**/*.vue'] }),
    'original.ts': 'export function original() { return 42 }\n',
    'replacement.ts': 'export function replacement() { return "text" }\n',
    'bridge.ts': 'import { original } from "./original"\nexport const value = original()\n',
    'Comp.vue': '<script setup lang="ts">\nimport { value } from "./bridge"\nconst result: number = value\n</script>\n<template>{{ result }}</template>\n',
    'Unchanged.vue': '<template>Hello</template>\n',
    'excluded/Outside.vue': '<template>Ignored by tsconfig</template>\n',
  })
  fixture.write('tsconfig.json', JSON.stringify({ compilerOptions: { strict: true, module: 'ESNext', moduleResolution: 'bundler', noEmit: true }, include: ['*.ts', '*.vue'] }))
  try {
    const result = await runReplace('original', 'replacement', { cwd: fixture.dir })
    assert.equal(result.verification._tag, 'Checked')
    if (result.verification._tag !== 'Checked')
      throw new Error('Expected completed diagnostics')
    assert.deepEqual(result.verification.checks.find(check => check.checker === 'vue'), { checker: 'vue', scope: 'project', files: 2, newErrors: 1 })
  }
  finally { fixture.cleanup() }
})

it('cSS and template transforms record unsupported diagnostics', async () => {
  const fixture = makeFixture({
    'source.ts': 'export const className = "font-semibold"\n',
    'Comp.vue': '<template><section><span>Hello</span></section></template>\n',
  })
  try {
    const results = await Promise.all([
      runCssClassRename(new Map([['font-semibold', 'font-medium']]), { cwd: fixture.dir }),
      runVueTemplateWrap('span', 'article', { cwd: fixture.dir }),
      runVueTemplateUnwrap('section', { cwd: fixture.dir }),
    ])
    for (const result of results)
      assert.deepEqual(result.verification, { _tag: 'Skipped', reason: 'not-applicable' })
  }
  finally { fixture.cleanup() }
})
