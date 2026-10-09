import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export interface BenchFixtureOptions {
  files?: number
  importersPerSymbol?: number
  tsconfig?: string
}

export interface BenchFixture {
  dir: string
  fileCount: number
  importersPerSymbol: number
  cleanup: () => void
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    strict: true,
    allowImportingTsExtensions: true,
    noEmit: true,
  },
  include: ['src/**/*.ts'],
}, null, 2)

export function makeBenchFixture(opts: BenchFixtureOptions = {}): BenchFixture {
  const fileCount = opts.files ?? 500
  const importersPerSymbol = opts.importersPerSymbol ?? 160
  const dir = mkdtempSync(join(tmpdir(), 'ripide-bench-'))

  const config = JSON.parse(TSCONFIG)
  config.include = [join(dir, 'src/**/*.ts')]
  write(dir, opts.tsconfig ?? 'tsconfig.json', JSON.stringify(config))
  write(dir, 'src/hot.ts', [
    'export interface SharedShape { value: number }',
    'export function hotSymbol(input: SharedShape): number { return input.value + 1 }',
    '',
  ].join('\n'))
  write(dir, 'src/source.ts', [
    'export function movedSymbol(value: number): number { return value * 2 }',
    'export function sourceLocal(value: number): number { return movedSymbol(value) + 1 }',
    '',
  ].join('\n'))
  write(dir, 'src/target.ts', 'export const targetSentinel = 1\n')

  for (let i = 0; i < fileCount; i++) {
    const importsHot = i < importersPerSymbol
    const importsMoved = i < importersPerSymbol
    const imports = [
      importsHot ? `import { hotSymbol } from './hot.ts'` : '',
      importsMoved ? `import { movedSymbol } from './source.ts'` : '',
    ].filter(Boolean)

    const body = [
      ...imports,
      `export interface Shape${i} { value: number, label: string }`,
      `export const value${i} = ${i}`,
      importsHot ? `export const hotValue${i} = hotSymbol({ value: value${i} })` : `export const hotValue${i} = value${i} + 1`,
      importsMoved ? `export const movedValue${i} = movedSymbol(value${i})` : `export const movedValue${i} = value${i} * 2`,
      `export function fn${i}(input: Shape${i}): string { return input.label + String(input.value + value${i}) }`,
      '',
    ].join('\n')
    write(dir, `src/file-${String(i).padStart(4, '0')}.ts`, body)
  }

  return {
    dir,
    fileCount,
    importersPerSymbol,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}
