import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { it } from 'vitest'
import { runReplace, writeChanges } from '../packages/core/src/index.ts'
import { makeFixture } from './helpers.ts'

const require = createRequire(import.meta.url)
const compiler = require.resolve('typescript/lib/tsc.js')

async function compiledReplacement(style: 'extensionless' | 'javascript', fromPackage = false, targetExtension = '.ts') {
  const ending = style === 'extensionless' ? '' : '.js'
  const files = {
    'package.json': JSON.stringify({ type: style === 'extensionless' ? 'commonjs' : 'module' }),
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'Node16', moduleResolution: 'Node16', strict: true, noEmitOnError: true, outDir: 'dist', types: [] }, include: ['*.ts'] }),
    'old.ts': 'export function original() { return 0 }\n',
    [`helper${targetExtension}`]: 'export function replacement() { return 40 }\n',
    'keep.ts': 'export function keep() { return 3 }\n',
    'entry.ts': `import { original } from '${fromPackage ? 'old-package' : `./old${ending}`}'\n${fromPackage ? '' : `import { keep } from './keep${ending}'\n`}export const result = original()${fromPackage ? ' + 3' : ' + keep()'}\n`,
    // A file with package imports only still belongs to the surrounding project's policy.
    'neighbor.ts': `import { keep } from './keep${ending}'\nexport const kept = keep()\n`,
    'other-package/neighbor-a.ts': `import { keep } from '../keep${style === 'extensionless' ? '.js' : '.ts'}'\nexport const kept = keep()\n`,
    'other-package/neighbor-b.ts': `import { keep } from '../keep${style === 'extensionless' ? '.js' : '.ts'}'\nexport const kept = keep()\n`,
  }
  const fx = makeFixture(files)
  try {
    writeChanges((await runReplace('original', 'replacement', { cwd: fx.dir, verifyMode: 'none' as const })).changes)
    const compiled = spawnSync(process.execPath, [compiler, '--project', resolve(fx.dir, 'tsconfig.json')], { cwd: fx.dir, encoding: 'utf8' })
    assert.equal(compiled.status, 0, `${compiled.stdout}${compiled.stderr}`)
    const value = execFileSync(process.execPath, ['--input-type=module', '--eval', `import * as consumer from ${JSON.stringify(pathToFileURL(resolve(fx.dir, 'dist/entry.js')).href)}; console.log(consumer.result)`], { encoding: 'utf8' }).trim()
    assert.equal(value, '43')
  }
  finally { fx.cleanup() }
}

it('replacement remains callable after an extensionless project emits JavaScript', async () => {
  await compiledReplacement('extensionless')
})
it('replacement preserves JavaScript specifiers in emitted Node ESM', async () => {
  await compiledReplacement('javascript')
})
it('replacement infers extensionless project policy for a package-only consumer', async () => {
  await compiledReplacement('extensionless', true)
})
it('replacement infers JavaScript project policy for a package-only consumer', async () => {
  await compiledReplacement('javascript', true)
})
it('replacement preserves the emitted module extension for a TypeScript ESM helper', async () => {
  await compiledReplacement('javascript', false, '.mts')
})
it('replacement preserves the emitted module extension for a TypeScript CommonJS helper', async () => {
  await compiledReplacement('javascript', false, '.cts')
})
