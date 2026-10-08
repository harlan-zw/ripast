import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'

assert.ok(process.argv[2], 'Pass the directory containing the package tarballs.')
const packageDirectory = resolve(process.argv[2])
const tarballs = readdirSync(packageDirectory).filter(path => path.endsWith('.tgz')).map(path => join(packageDirectory, path))
assert.equal(tarballs.length, 4, 'Pass the core, CLI, Vue, and TSRX package tarballs.')
assert.ok(process.env.npm_execpath?.endsWith('npm-cli.js'), 'Run this smoke check with npm run smoke:package.')
const cwd = mkdtempSync(join(tmpdir(), 'ripast-package-'))
const run = (args: string[], env = process.env, directory = cwd) => execFileSync(process.execPath, args, { cwd: directory, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
try {
  writeFileSync(join(cwd, 'package.json'), '{"type":"module","private":true}')
  run([process.env.npm_execpath!, 'install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs.filter(path => !path.includes('ripast-tsrx-')), '@typescript/typescript6@6.0.2', '@types/node@^22'])
  writeFileSync(join(cwd, 'tsconfig.json'), '{"compilerOptions":{"target":"ES2022","module":"NodeNext","types":["node"],"strict":true,"skipLibCheck":true,"noEmit":true},"include":["*.ts"]}')
  writeFileSync(join(cwd, 'source.ts'), 'export const target = 1\n')
  writeFileSync(join(cwd, 'component.vue'), '<template>{{ target }}</template>\n')
  writeFileSync(join(cwd, 'consumer.ts'), `import { runRename } from '@ripast/core'
import { parseSourceFile } from '@ripast/core/adapter'
import vueAdapter from '@ripast/vue'
const result = await runRename('target', 'next', { cwd: process.cwd(), vue: false, verify: false })
if (!result.changes.some(change => change.after.includes('export const next')))
  throw new Error('SDK rename did not produce the expected edit')
parseSourceFile('source.ts', 'export const target = 1')
console.log(JSON.stringify({ changes: result.changes.length, vueMatch: vueAdapter.hasFilesContaining(process.cwd(), 'target') }))
`)
  run([join(cwd, 'node_modules/@typescript/typescript6/bin/tsc6'), '--project', 'tsconfig.json'])
  const cli = join(cwd, 'node_modules/@ripast/cli/bin/ripast.mjs')
  const isolated = { ...process.env, PATH: cwd }
  const renamed = JSON.parse(run([cli, 'rename', 'target', 'next', '--no-vue', '--no-verify', '--json'], isolated))
  assert.ok(renamed.changes.some((change: { after: string }) => change.after.includes('export const next')))
  assert.equal(readFileSync(join(cwd, 'source.ts'), 'utf8'), 'export const target = 1\n')
  const sdk = JSON.parse(run(['--experimental-strip-types', 'consumer.ts']))
  assert.ok(sdk.changes > 0)
  assert.equal(sdk.vueMatch, true)
  run([process.env.npm_execpath!, 'install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs.filter(path => path.includes('ripast-tsrx-')), 'octane@0.10.2'])
  const tsrxDirectory = join(cwd, 'tsrx')
  mkdirSync(tsrxDirectory)
  writeFileSync(join(tsrxDirectory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, skipLibCheck: true, noEmit: true, jsx: 'react-jsx', jsxImportSource: 'octane', allowImportingTsExtensions: true },
    contentMappers: [{ package: '@tsrx/content-mapper', extensions: ['.tsrx'], options: { compiler: '@ripast/tsrx/compiler' } }],
    include: ['*.ts', '*.tsrx'],
  }))
  writeFileSync(join(tsrxDirectory, 'source.ts'), 'export function target() { return 1 }\n')
  writeFileSync(join(tsrxDirectory, 'View.tsrx'), 'import { target } from \'./source.ts\'\nexport function View() @{ <span>{target()}</span> }\n')
  run([cli, 'rename', 'target', 'next', '--scope', 'source.ts', '--apply', '--json'], { ...process.env, RIPAST_RUN_EXTERNAL_CODE: '1' }, tsrxDirectory)
  for (let attempt = 0; attempt < 3; attempt++) {
    run([cli, 'rename', 'next', 'final', '--scope', 'source.ts', '--json'], { ...process.env, RIPAST_RUN_EXTERNAL_CODE: '1' }, tsrxDirectory)
  }
  assert.match(readFileSync(join(tsrxDirectory, 'source.ts'), 'utf8'), /function next\(/)
  assert.match(readFileSync(join(tsrxDirectory, 'View.tsrx'), 'utf8'), /import \{ next \}/)
  assert.match(readFileSync(join(tsrxDirectory, 'View.tsrx'), 'utf8'), /\{next\(\)\}/)
  process.stdout.write('Packed CLI, SDK, and TSRX adapter passed installation, typecheck, and rename checks.\n')
}
finally { rmSync(cwd, { recursive: true, force: true }) }
