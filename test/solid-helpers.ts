import type { Fixture } from './helpers.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { resolveNativeTsc } from '../packages/core/src/index.ts'
import { makeFixture } from './helpers.ts'

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
  const visit = (node: ts.Node): void => {
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
  return { tags, calls, declarations, imports, attributes }
}
