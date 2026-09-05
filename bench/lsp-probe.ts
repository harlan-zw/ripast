// Probe: does native TS LSP rename follow `export *` barrels and package (node_modules symlink) imports?
// Run: pnpm exec tsx bench/lsp-probe.ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { connect, lspRename, openFile, uriOf } from './lsp-spike.ts'

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

async function probe(label: string, setup: (dir: string) => void, declFile: string, symbol: string, expectFiles: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ripast-lsp-probe-'))
  try {
    setup(dir)
    const client = await connect(dir)
    const { edits } = await lspRename(client, join(dir, declFile), symbol, `${symbol}Renamed`)
    for (const [u, es] of edits) console.log('    edit', u.split('/').slice(-2).join('/'), JSON.stringify(es.map((e: any) => e.newText)))
    const got = [...edits.keys()].map(u => new URL(u).pathname.replace(`${resolve(dir)}/`, '')).sort()
    // references too, for comparison
    const abs = join(dir, declFile)
    const uri = openFile(client, abs)
    const refs = await client.request('textDocument/references', {
      textDocument: { uri },
      position: { line: 0, character: 16 },
      context: { includeDeclaration: true },
    })
    const refFiles = [...new Set((refs ?? []).map((r: any) => new URL(r.uri).pathname.replace(`${resolve(dir)}/`, '')))].sort()
    client.kill()
    const missing = expectFiles.filter(f => !got.includes(f))
    console.log(`${missing.length ? '✗' : '✓'} ${label}\n    rename: ${got.join(', ')}\n    refs:   ${refFiles.join(', ')}${missing.length ? `\n    missing: ${missing.join(', ')}` : ''}`)
    void uriOf
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function TSCONFIG(include: string[]) {
  return JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', strict: true, allowImportingTsExtensions: true, noEmit: true },
    include,
  }, null, 2)
}

async function main() {
  await probe('export * barrel (relative)', (dir) => {
    write(dir, 'tsconfig.json', TSCONFIG(['src/**/*']))
    write(dir, 'src/a.ts', 'export function target(): number { return 1 }\n')
    write(dir, 'src/index.ts', 'export * from \'./a.ts\'\n')
    write(dir, 'src/b.ts', 'import { target } from \'./index.ts\'\nexport const v = target()\n')
  }, 'src/a.ts', 'target', ['src/a.ts', 'src/b.ts'])

  await probe('named re-export barrel (relative)', (dir) => {
    write(dir, 'tsconfig.json', TSCONFIG(['src/**/*']))
    write(dir, 'src/a.ts', 'export function target(): number { return 1 }\n')
    write(dir, 'src/index.ts', 'export { target } from \'./a.ts\'\n')
    write(dir, 'src/b.ts', 'import { target } from \'./index.ts\'\nexport const v = target()\n')
  }, 'src/a.ts', 'target', ['src/a.ts', 'src/index.ts', 'src/b.ts'])

  await probe('workspace package via node_modules symlink + exports', (dir) => {
    write(dir, 'tsconfig.json', TSCONFIG(['packages/**/*', 'app/**/*']))
    write(dir, 'packages/core/package.json', JSON.stringify({ name: '@x/core', type: 'module', exports: { '.': { types: './dist/index.d.mts', import: './dist/index.mjs' } } }))
    write(dir, 'packages/core/src/a.ts', 'export function target(): number { return 1 }\n')
    write(dir, 'packages/core/src/index.ts', 'export { target } from \'./a.ts\'\n')
    write(dir, 'packages/core/dist/index.d.mts', 'export * from \'../src/index.ts\'\n')
    write(dir, 'packages/core/dist/index.mjs', 'export * from \'../src/index.ts\'\n')
    mkdirSync(join(dir, 'node_modules/@x'), { recursive: true })
    symlinkSync(join(dir, 'packages/core'), join(dir, 'node_modules/@x/core'))
    write(dir, 'app/b.ts', 'import { target } from \'@x/core\'\nexport const v = target()\n')
  }, 'packages/core/src/a.ts', 'target', ['packages/core/src/a.ts', 'packages/core/src/index.ts', 'app/b.ts'])

  await probe('workspace package, consumer file NOT opened, direct src import', (dir) => {
    write(dir, 'tsconfig.json', TSCONFIG(['packages/**/*', 'app/**/*']))
    write(dir, 'packages/core/src/a.ts', 'export function target(): number { return 1 }\n')
    write(dir, 'app/b.ts', 'import { target } from \'../packages/core/src/a.ts\'\nexport const v = target()\n')
  }, 'packages/core/src/a.ts', 'target', ['packages/core/src/a.ts', 'app/b.ts'])
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
