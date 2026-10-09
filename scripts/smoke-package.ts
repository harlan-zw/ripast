import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

assert.ok(process.argv[2], 'Pass the directory containing the package tarballs.')
const packageDirectory = resolve(process.argv[2])
const tarballs = readdirSync(packageDirectory).filter(path => path.endsWith('.tgz')).map(path => join(packageDirectory, path))
assert.equal(tarballs.length, 3, 'Pass the core, CLI, and Vue package tarballs.')
assert.ok(process.env.npm_execpath?.endsWith('npm-cli.js'), 'Run this smoke check with npm run smoke:package.')
const cwd = mkdtempSync(join(tmpdir(), 'ripast-package-'))
const run = (args: string[], env = process.env) => execFileSync(process.execPath, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const cli = join(cwd, 'node_modules/@ripast/cli/bin/ripast.mjs')
try {
  writeFileSync(join(cwd, 'package.json'), '{"type":"module","private":true}')
  const vueTarball = tarballs.find(path => /ripast-vue-/.test(path))!
  const coreTarballs = tarballs.filter(path => path !== vueTarball)
  run([process.env.npm_execpath!, 'install', '--ignore-scripts', '--no-audit', '--no-fund', ...coreTarballs, '@typescript/typescript6@6.0.2', '@types/node@^22'])
  const dependencyGraph = run([process.env.npm_execpath!, 'ls', '--all', '--json'])
  assert.doesNotMatch(dependencyGraph, /"(?:@vue\/|@volar\/|@ripast\/vue|@sveltejs\/)/)
  process.stdout.write(`Core-only dependency graph:\n${dependencyGraph}\n`)
  writeFileSync(join(cwd, 'tsconfig.json'), '{"compilerOptions":{"target":"ES2022","module":"NodeNext","types":["node"],"strict":true,"skipLibCheck":true,"noEmit":true,"allowJs":true},"include":["*.ts","*.js"]}')
  writeFileSync(join(cwd, 'source.ts'), 'export const target = 1\n')
  writeFileSync(join(cwd, 'plain.js'), 'export const independent = 2\n')
  writeFileSync(join(cwd, 'consumer.ts'), `import { createEngine } from '@ripast/core'
const engine = createEngine()
const result = await engine.runRename('target', 'next', { cwd: process.cwd(), verify: false })
if (!result.changes.some(change => change.after.includes('export const next')))
  throw new Error('SDK rename did not produce the expected edit')
if (!engine.scan('independent').some(hit => hit.file === 'plain.js'))
  throw new Error('Core SDK did not scan JavaScript')
console.log(JSON.stringify({ changes: result.changes.length }))
`)
  run([join(cwd, 'node_modules/@typescript/typescript6/bin/tsc6'), '--project', 'tsconfig.json'])
  const isolated = { ...process.env, PATH: cwd }
  const renamed = JSON.parse(run([cli, 'rename', 'target', 'next', '--no-verify', '--json'], isolated))
  assert.ok(renamed.changes.some((change: { after: string }) => change.after.includes('export const next')))
  assert.equal(readFileSync(join(cwd, 'source.ts'), 'utf8'), 'export const target = 1\n')
  assert.ok(JSON.parse(run(['--experimental-strip-types', 'consumer.ts'])).changes > 0)
  writeFileSync(join(cwd, 'component.vue'), '<script setup lang="ts">import { target } from "./source"</script><template>{{ target }}</template>\n')
  const missing = spawnSync(process.execPath, [cli, 'rename', 'target', 'next', '--apply', '--no-verify', '--json'], { cwd, env: isolated, encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /@ripast\/vue/)
  assert.equal(readFileSync(join(cwd, 'source.ts'), 'utf8'), 'export const target = 1\n')
  run([process.env.npm_execpath!, 'install', '--ignore-scripts', '--no-audit', '--no-fund', vueTarball])
  writeFileSync(join(cwd, 'consumer.ts'), `import { createEngine } from '@ripast/core'
import vue from '@ripast/vue'
import { runVueTemplateWrap } from '@ripast/vue'
const engine = createEngine({ extensions: [vue] })
const result = await engine.runRename('target', 'next', { cwd: process.cwd(), verify: false })
if (!result.changes.some(change => change.path.endsWith('.vue') && change.after.includes('next')))
  throw new Error('Injected Vue extension omitted the consumer')
const wrapped = await runVueTemplateWrap('template', 'div', { cwd: process.cwd() })
console.log(JSON.stringify({ changes: result.changes.length, wrapped: wrapped.scanned }))
`)
  run([join(cwd, 'node_modules/@typescript/typescript6/bin/tsc6'), '--project', 'tsconfig.json'])
  assert.ok(JSON.parse(run(['--experimental-strip-types', 'consumer.ts'])).changes > 1)
  const mixed = JSON.parse(run([cli, 'rename', 'target', 'next', '--no-verify', '--json'], isolated))
  assert.ok(mixed.changes.some((change: { path: string }) => change.path.endsWith('.vue')))
  process.stdout.write('Packed core-only and Vue CLI/SDK passed installation, dependency graph, typecheck, dry-run, and consumer checks.\n')
}
finally { rmSync(cwd, { recursive: true, force: true }) }
