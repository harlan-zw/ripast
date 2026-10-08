import type { Fixture } from './helpers.ts'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import { makeFixture } from './helpers.ts'

const require = createRequire(import.meta.url)

export function makeReactFixture(files: Record<string, string>): Fixture {
  const fixture = makeFixture(files, false)
  fixture.write('tsconfig.json', JSON.stringify({
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      jsx: 'react-jsx',
      strict: true,
      allowJs: true,
      checkJs: true,
      noEmit: true,
      skipLibCheck: true,
      types: ['react'],
    },
    include: ['src/**/*'],
  }))
  mkdirSync(join(fixture.dir, 'node_modules/@types'), { recursive: true })
  for (const [name, entry] of [
    ['react', 'react/package.json'],
    ['react-dom', 'react-dom/package.json'],
    ['@types/react', '@types/react/package.json'],
  ]) {
    symlinkSync(dirname(realpathSync(require.resolve(entry!))), join(fixture.dir, 'node_modules', name!), 'dir')
  }
  return fixture
}

export function reactDiagnostics(fixture: Fixture): string[] {
  const configPath = join(fixture.dir, 'tsconfig.json')
  const config = ts.readConfigFile(configPath, ts.sys.readFile)
  if (config.error)
    throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'))
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, fixture.dir)
  const program = ts.createProgram(parsed.fileNames, parsed.options)
  return [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}

export function renderReactFixture(fixture: Fixture, entry: string): string {
  const output = mkdtempSync(join(fixture.dir, '.render-'))
  function emit(directory: string): void {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, item.name)
      if (item.isDirectory()) {
        emit(path)
      }
      else if (/\.(?:tsx?|jsx?)$/.test(path)) {
        const target = join(output, relative(join(fixture.dir, 'src'), path).replace(/\.(?:tsx?|jsx?)$/, '.js'))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, ts.transpileModule(fixture.read(relative(fixture.dir, path)), {
          fileName: path,
          compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
        }).outputText)
      }
    }
  }
  emit(join(fixture.dir, 'src'))
  const { View } = require(join(output, entry.replace(/^src\//, '').replace(/\.(?:tsx?|jsx?)$/, '.js')))
  const markup = renderToStaticMarkup(createElement(View))
  rmSync(output, { recursive: true, force: true })
  return markup
}
