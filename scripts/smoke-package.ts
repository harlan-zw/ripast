import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

assert.ok(process.argv[2], 'Pass the directory containing the package tarballs.')
const packageDirectory = resolve(process.argv[2])
const tarballs = readdirSync(packageDirectory).filter(path => path.endsWith('.tgz')).map(path => join(packageDirectory, path))
assert.equal(tarballs.length, 3, 'Pass the core, CLI, and Vue package tarballs.')
assert.ok(process.env.npm_execpath?.endsWith('npm-cli.js'), 'Run this smoke check with npm run smoke:package.')
const cwd = mkdtempSync(join(tmpdir(), 'ripide-package-'))
const run = (args: string[], env = process.env) => execFileSync(process.execPath, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
try {
  writeFileSync(join(cwd, 'package.json'), '{"type":"module","private":true}')
  run([process.env.npm_execpath!, 'install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs, '@typescript/typescript6@6.0.2', '@types/node@^22'])
  writeFileSync(join(cwd, 'tsconfig.json'), '{"compilerOptions":{"target":"ES2022","module":"NodeNext","types":["node"],"strict":true,"skipLibCheck":true,"noEmit":true},"include":["*.ts"]}')
  writeFileSync(join(cwd, 'source.ts'), 'export const target = 1\n')
  writeFileSync(join(cwd, 'component.vue'), '<template>{{ target }}</template>\n')
  writeFileSync(join(cwd, 'consumer.ts'), `import { runRename, scan } from 'ripide-api'
import { parseSourceFile } from 'ripide-api/adapter'
import { formatHits } from 'ripide/presentation'
import vueAdapter from 'ripide-vue'
const result = await runRename('target', 'next', { cwd: process.cwd(), vue: false, verifyMode: 'none' })
if (!result.changes.some(change => change.after.includes('export const next')))
  throw new Error('SDK rename did not produce the expected edit')
parseSourceFile('source.ts', 'export const target = 1')
const rendered = formatHits(scan('target', { cwd: process.cwd(), glob: ['source.ts'] }), false)
console.log(JSON.stringify({ changes: result.changes.length, rendered, vueMatch: vueAdapter.hasFilesContaining(process.cwd(), 'target') }))
`)
  run([join(cwd, 'node_modules/@typescript/typescript6/bin/tsc6'), '--project', 'tsconfig.json'])
  const cli = join(cwd, 'node_modules/ripide/bin/ripide.mjs')
  const isolated = { ...process.env, PATH: cwd }
  const renamed = JSON.parse(run([cli, 'rename', 'target', 'next', '--no-vue', '--verify-mode', 'none', '--profile', 'full', '--json'], isolated))
  assert.ok(renamed.data.changes.some((change: { after: string }) => change.after.includes('export const next')))
  assert.equal(readFileSync(join(cwd, 'source.ts'), 'utf8'), 'export const target = 1\n')
  const named = JSON.parse(run([process.env.npm_execpath!, 'exec', '--offline', '--', 'ripide', 'rename', 'target', 'next', '--no-vue', '--verify-mode', 'none', '--profile', 'full', '--json']))
  assert.ok(named.data.changes.some((change: { after: string }) => change.after.includes('export const next')))
  const sdk = JSON.parse(run(['--experimental-strip-types', 'consumer.ts']))
  assert.ok(sdk.changes > 0)
  assert.equal(sdk.vueMatch, true)
  assert.match(sdk.rendered, /source\.ts:1:14\s+identifier-binding\s+export const target = 1/)
  assert.match(sdk.rendered, /1 hits across 1 files/)
  process.stdout.write('Packed CLI and SDK passed installation, typecheck, and rename checks.\n')
}
finally { rmSync(cwd, { recursive: true, force: true }) }
