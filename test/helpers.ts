import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    strict: true,
    allowImportingTsExtensions: true,
    noEmit: true,
    jsx: 'preserve',
  },
  include: ['**/*.ts', '**/*.tsx'],
}, null, 2)

export interface Fixture {
  dir: string
  write: (rel: string, content: string) => string
  read: (rel: string) => string
  cleanup: () => void
}

export function prepareLauncher(fx: Fixture): string {
  const path = fx.write('bin/ripast.mjs', '')
  copyFileSync(resolve('packages/cli/bin/ripast.mjs'), path)
  mkdirSync(join(fx.dir, 'node_modules'), { recursive: true })
  // Link this dependency alone. Keep adapter resolution isolated from the workspace.
  symlinkSync(resolve('packages/cli/node_modules/cross-spawn'), join(fx.dir, 'node_modules/cross-spawn'), 'junction')
  symlinkSync(resolve('packages/cli/dist'), join(fx.dir, 'dist'), 'junction')
  return path
}

export function makeFixture(files: Record<string, string> = {}, includeTsconfig = true): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'ripast-test-'))
  const write = (rel: string, content: string): string => {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    return abs
  }
  const read = (rel: string): string => readFileSync(join(dir, rel), 'utf8')
  if (includeTsconfig)
    write('tsconfig.json', TSCONFIG)
  for (const [rel, content] of Object.entries(files)) write(rel, content)
  return {
    dir,
    write,
    read,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const JS_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    allowJs: true,
    checkJs: false,
    noEmit: true,
  },
  include: ['**/*.js', '**/*.mjs'],
}, null, 2)

export function makeJsFixture(files: Record<string, string> = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'ripast-test-js-'))
  const write = (rel: string, content: string): string => {
    const abs = join(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
    return abs
  }
  const read = (rel: string): string => readFileSync(join(dir, rel), 'utf8')
  write('tsconfig.json', JS_TSCONFIG)
  for (const [rel, content] of Object.entries(files)) write(rel, content)
  return {
    dir,
    write,
    read,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
