import type { FileChange, TextEdit } from '@ripast/core/adapter'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { applyTextEdits } from '@ripast/core/adapter'
import ts from '@typescript/typescript6'
import { isNuxtBindingTarget, nuxtImportMetadataPaths } from './nuxt-bindings.ts'

/** Predict Nuxt prepare declarations for verification. These changes never reach the apply plan. */
export function nuxtRenameVerificationChanges(
  cwd: string,
  contexts: Set<string>,
  providers: Set<string>,
  from: string,
  to: string,
): FileChange[] {
  const changes: FileChange[] = []
  for (const context of contexts) {
    for (const path of nuxtImportMetadataPaths(context)) {
      const before = readFileSync(path, 'utf8')
      const source = ts.createSourceFile(path, before, ts.ScriptTarget.Latest, true)
      const edits: TextEdit[] = []
      const replace = (node: ts.Node, quoted = false): void => {
        edits.push({ start: node.getStart(source) + Number(quoted), end: node.end - Number(quoted), replacement: to })
      }
      const matches = (specifier: string): boolean => isNuxtBindingTarget(context, path, specifier, providers)
      const renameType = (type: ts.TypeNode): boolean => {
        if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === 'UnwrapRef' && type.typeArguments?.length === 1)
          type = type.typeArguments[0]!
        const indexed = ts.isIndexedAccessTypeNode(type) ? type : undefined
        const imported = indexed?.objectType ?? type
        if (!ts.isImportTypeNode(imported) || !imported.isTypeOf || !ts.isLiteralTypeNode(imported.argument)
          || !ts.isStringLiteral(imported.argument.literal) || !matches(imported.argument.literal.text)) {
          return false
        }
        if (indexed && ts.isLiteralTypeNode(indexed.indexType) && ts.isStringLiteral(indexed.indexType.literal)
          && indexed.indexType.literal.text === from) {
          replace(indexed.indexType.literal, true)
          return true
        }
        if (!indexed && imported.qualifier && ts.isIdentifier(imported.qualifier) && imported.qualifier.text === from) {
          replace(imported.qualifier)
          return true
        }
        return false
      }
      for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          && matches(statement.moduleSpecifier.text) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            const imported = element.propertyName ?? element.name
            if (imported.text === from)
              replace(imported, ts.isStringLiteral(imported))
          }
        }
        if (!ts.isModuleDeclaration(statement) || !statement.body || !ts.isModuleBlock(statement.body))
          continue
        if (ts.isIdentifier(statement.name) && statement.name.text === 'global') {
          for (const declaration of statement.body.statements) {
            if (!ts.isVariableStatement(declaration))
              continue
            for (const variable of declaration.declarationList.declarations) {
              if (variable.type && renameType(variable.type) && ts.isIdentifier(variable.name) && variable.name.text === from)
                replace(variable.name)
            }
          }
        }
        if (ts.isStringLiteral(statement.name) && statement.name.text === 'vue') {
          for (const declaration of statement.body.statements) {
            if (!ts.isInterfaceDeclaration(declaration) || declaration.name.text !== 'ComponentCustomProperties')
              continue
            for (const property of declaration.members) {
              if (ts.isPropertySignature(property) && property.type && renameType(property.type)
                && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === from) {
                replace(property.name, ts.isStringLiteral(property.name))
              }
            }
          }
        }
      }
      const after = applyTextEdits(before, edits)
      if (after !== before)
        changes.push({ path, rel: relative(cwd, path), before, after })
    }
  }
  return changes
}
