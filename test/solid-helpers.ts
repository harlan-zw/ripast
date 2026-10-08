import type { Fixture } from './helpers.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { transformSync } from '@babel/core'
import ts from 'typescript'
import { resolveNativeTsc } from '../packages/core/src/index.ts'
import { makeFixture } from './helpers.ts'

const require = createRequire(import.meta.url)
const solidPreset = require('babel-preset-solid')

export function renderSolidFixture(fx: Fixture): string {
  const output = mkdtempSync(join(fx.dir, '.render-'))
  const source = join(fx.dir, 'src')
  function emit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        emit(path)
      }
      else if (/\.tsx?$/.test(path)) {
        const stripped = ts.transpileModule(fx.read(relative(fx.dir, path)), {
          fileName: path,
          compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 },
        }).outputText
        const compiled = transformSync(stripped, {
          filename: path,
          babelrc: false,
          configFile: false,
          presets: [[solidPreset, { generate: 'ssr' }]],
        })?.code
        if (!compiled)
          throw new Error(`Solid compilation produced no code for ${path}`)
        const target = join(output, relative(source, path).replace(/\.tsx?$/, '.js'))
        mkdirSync(dirname(target), { recursive: true })
        writeFileSync(target, ts.transpileModule(compiled, {
          compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText)
      }
    }
  }
  try {
    emit(source)
    const fixtureRequire = createRequire(join(output, 'App.js'))
    const { renderToString } = fixtureRequire('solid-js/web')
    const { App } = fixtureRequire('./App.js')
    return renderToString(() => App())
  }
  finally {
    rmSync(output, { recursive: true, force: true })
  }
}

export function makeSolidFixture(): Fixture {
  const fx = makeFixture({}, false)
  cpSync(resolve('test/fixtures/solid'), fx.dir, { recursive: true })
  mkdirSync(join(fx.dir, 'node_modules'))
  symlinkSync(resolve('node_modules/solid-js'), join(fx.dir, 'node_modules/solid-js'), 'junction')
  return fx
}

export function assertSolidDiagnostics(fx: Fixture): void {
  assert.equal(execFileSync(resolveNativeTsc(), ['--noEmit', '--project', join(fx.dir, 'tsconfig.json')], { encoding: 'utf8' }), '')
}

export function solidSyntax(fx: Fixture, rel: string) {
  const file = ts.createSourceFile(rel, fx.read(rel), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const tags: string[] = []
  const calls: string[] = []
  const declarations: string[] = []
  const imports: { from: string, imported: string, local: string }[] = []
  const attributes: { name: string, values: string[] }[] = []
  const strings: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node))
      strings.push(node.text)
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node))
      tags.push(node.tagName.getText(file))
    if (ts.isCallExpression(node))
      calls.push(node.expression.getText(file))
    if ((ts.isFunctionDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.name)
      declarations.push(node.name.text)
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const bindings = node.importClause?.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const specifier of bindings.elements)
          imports.push({ from: node.moduleSpecifier.text, imported: specifier.propertyName?.text ?? specifier.name.text, local: specifier.name.text })
      }
    }
    if (ts.isJsxAttribute(node)) {
      const values: string[] = []
      const collect = (child: ts.Node): void => {
        if (ts.isStringLiteral(child))
          values.push(child.text)
        ts.forEachChild(child, collect)
      }
      if (node.initializer)
        collect(node.initializer)
      attributes.push({ name: node.name.getText(file), values })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return { tags, calls, declarations, imports, attributes, strings }
}

export function solidModuleValue(fx: Fixture, rel: string, name: string): unknown {
  const compiled = ts.transpileModule(fx.read(rel), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } })
  const exports: Record<string, unknown> = {}
  runInNewContext(compiled.outputText, { exports })
  return JSON.parse(JSON.stringify(exports[name]))
}
