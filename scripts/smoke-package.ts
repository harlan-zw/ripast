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
const cwd = mkdtempSync(join(tmpdir(), 'ripide-package-'))
const run = (args: string[], env = process.env, directory = cwd) => execFileSync(process.execPath, args, { cwd: directory, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
try {
  writeFileSync(join(cwd, 'package.json'), '{"type":"module","private":true}')
  run([process.env.npm_execpath!, 'install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs.filter(path => !path.includes('ripide-tsrx-')), '@typescript/typescript6@6.0.2', '@types/node@^22'])
  writeFileSync(join(cwd, 'tsconfig.json'), '{"compilerOptions":{"target":"ES2022","module":"NodeNext","types":["node"],"strict":true,"skipLibCheck":true,"noEmit":true},"include":["*.ts"]}')
  writeFileSync(join(cwd, 'source.ts'), 'export const target = 1\n')
  writeFileSync(join(cwd, 'component.vue'), '<script setup lang="ts">import { target } from "./source.ts"; const doubled = target * 2</script><template>{{ doubled }}</template>\n')
  writeFileSync(join(cwd, 'consumer.ts'), `import { createEngine } from 'ripide-api'
import { parseSourceFile } from 'ripide-api/adapter'
import { createVueExtension } from 'ripide-vue'
import { formatHits } from 'ripide/presentation'
import { runInlineTest } from 'ripide/check'
const checked = await runInlineTest({ cwd: process.cwd(), from: 'source.ts', source: "import { test, expect } from 'vitest'; import { target } from './source.ts'; test('target', () => expect(target).toBe(1))" })
if (checked._tag !== 'Passed')
  throw new Error('SDK transient check failed: ' + JSON.stringify(checked))
const extension = createVueExtension()
const engine = createEngine({ extensions: [extension] })
const result = await engine.rename('target', 'next', { cwd: process.cwd(), scope: 'source.ts', verifyMode: 'none' })
if (!result.changes.some(change => change.after.includes('export const next')))
  throw new Error('SDK rename did not produce the expected edit')
parseSourceFile('source.ts', 'export const target = 1')
const rendered = formatHits(engine.scan('target', { cwd: process.cwd(), glob: ['source.ts'] }), false)
console.log(JSON.stringify({ changes: result.changes.length, rendered, vueMatch: extension.semantic!.hasFilesContaining(process.cwd(), 'target') }))
`)
  run([join(cwd, 'node_modules/@typescript/typescript6/bin/tsc6'), '--project', 'tsconfig.json'])
  const cliPackage = join(cwd, 'node_modules/ripide')
  const cliManifest = JSON.parse(readFileSync(join(cliPackage, 'package.json'), 'utf8'))
  const cli = join(cliPackage, cliManifest.bin.ripide)
  writeFileSync(join(cwd, 'math.ts'), 'export function add(a: number, b: number) { return a + b }\n')
  const checked = JSON.parse(execFileSync(process.execPath, [cli, 'check', 'add', '--from', 'math.ts', '--json'], {
    cwd,
    encoding: 'utf8',
    input: 'test(\'adds\', () => expect(add(2, 3)).toBe(5))',
    stdio: ['pipe', 'pipe', 'pipe'],
  }))
  assert.equal(checked.data.result._tag, 'Passed')
  assert.ok(checked.data.result.coverage.length > 0)
  const isolated = { ...process.env, PATH: cwd }
  const renamed = JSON.parse(run([cli, 'rename', 'target', 'next', '--verify-mode', 'none', '--json', '--profile', 'full'], isolated))
  assert.ok(renamed.data.changes.some((change: { after: string }) => change.after.includes('export const next')))
  assert.equal(readFileSync(join(cwd, 'source.ts'), 'utf8'), 'export const target = 1\n')
  const named = JSON.parse(run([cli, 'rename', 'target', 'next', '--verify-mode', 'none', '--json', '--profile', 'full']))
  assert.ok(named.data.changes.some((change: { after: string }) => change.after.includes('export const next')))
  const sdk = JSON.parse(run(['--experimental-strip-types', 'consumer.ts']))
  assert.ok(sdk.changes > 0)
  assert.equal(sdk.vueMatch, true)
  assert.match(sdk.rendered, /source\.ts:1:14\s+identifier-binding\s+export const target = 1/)
  assert.match(sdk.rendered, /1 hits across 1 files/)
  run([process.env.npm_execpath!, 'install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs.filter(path => path.includes('ripide-tsrx-')), 'octane@0.10.2'])
  const tsrxDirectory = join(cwd, 'tsrx')
  mkdirSync(tsrxDirectory)
  writeFileSync(join(tsrxDirectory, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, skipLibCheck: true, noEmit: true, jsx: 'react-jsx', jsxImportSource: 'octane', allowImportingTsExtensions: true },
    contentMappers: [{ package: '@tsrx/content-mapper', extensions: ['.tsrx'], options: { compiler: 'ripide-tsrx/compiler' } }],
    include: ['*.ts', '*.tsrx'],
  }))
  writeFileSync(join(tsrxDirectory, 'source.ts'), 'export function target() { return 1 }\n')
  writeFileSync(join(tsrxDirectory, 'View.tsrx'), 'import { target } from \'./source.ts\'\nexport function View() @{ <span>{target()}</span> }\n')
  run([cli, 'rename', 'target', 'next', '--scope', 'source.ts', '--apply', '--json'], { ...process.env, RIPIDE_RUN_EXTERNAL_CODE: '1' }, tsrxDirectory)
  for (let attempt = 0; attempt < 3; attempt++) {
    run([cli, 'rename', 'next', 'final', '--scope', 'source.ts', '--json'], { ...process.env, RIPIDE_RUN_EXTERNAL_CODE: '1' }, tsrxDirectory)
  }
  assert.match(readFileSync(join(tsrxDirectory, 'source.ts'), 'utf8'), /function next\(/)
  assert.match(readFileSync(join(tsrxDirectory, 'View.tsrx'), 'utf8'), /import \{ next \}/)
  assert.match(readFileSync(join(tsrxDirectory, 'View.tsrx'), 'utf8'), /\{next\(\)\}/)
  process.stdout.write('Packed CLI, SDK, and TSRX adapter passed installation, typecheck, rename, and transient checks.\n')
}
finally { rmSync(cwd, { recursive: true, force: true }) }
