import type { FileChange, TextEdit } from 'ripide-api/adapter'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import ts from '@typescript/typescript6'
import { applyTextEdits } from 'ripide-api/adapter'
import { isNuxtBindingTarget, nuxtImportMetadataPaths } from './nuxt-bindings.ts'

/** Predict Nuxt prepare declarations for verification. These changes never reach the apply plan. */
export function nuxtRenameVerificationChanges(
  cwd: string,
  contexts: Set<string>,
  providers: Set<string>,
  from: string,
  to: string,
  authoredChanges: FileChange[],
): FileChange[] {
  if (from === to)
    return []
  const exportedNames = new Map([...providers].map((path) => {
    const change = authoredChanges.find(change => change.path === path)
    if (!change)
      return [path, new Set<string>()] as const
    const source = ts.createSourceFile(path, change.after, ts.ScriptTarget.Latest, true)
    const names = new Set<string>()
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text)
      }
      if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
        continue
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name))
            names.add(declaration.name.text)
        }
      }
      else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isEnumDeclaration(statement)
        || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name) {
        names.add(statement.name.text)
      }
    }
    return [path, names] as const
  }))
  const renamedProviders = new Set([...exportedNames].filter(([, names]) => names.has(to)).map(([path]) => path))
  const retainedProviders = new Set([...exportedNames].filter(([, names]) => names.has(from) && names.has(to)).map(([path]) => path))
  const changes: FileChange[] = []
  for (const context of contexts) {
    for (const path of nuxtImportMetadataPaths(context)) {
      const before = readFileSync(path, 'utf8')
      const source = ts.createSourceFile(path, before, ts.ScriptTarget.Latest, true)
      const edits: TextEdit[] = []
      const replace = (node: ts.Node, quoted = false): void => {
        edits.push({ start: node.getStart(source) + Number(quoted), end: node.end - Number(quoted), replacement: to })
      }
      const matches = (specifier: string): boolean => isNuxtBindingTarget(context, path, specifier, renamedProviders)
      const retains = (specifier: string): boolean => isNuxtBindingTarget(context, path, specifier, retainedProviders)
      const duplicate = (node: ts.Node, replacements: TextEdit[], start: number, prefix: string): void => {
        const offset = node.getStart(source)
        const cloned = applyTextEdits(node.getText(source), replacements.map(edit => ({ ...edit, start: edit.start - offset, end: edit.end - offset })))
        edits.push({ start, end: start, replacement: `\n${prefix}${cloned}${cloned.endsWith(';') ? '' : ';'}` })
      }
      const renameType = (type: ts.TypeNode): 'None' | 'Replace' | 'Add' => {
        if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && type.typeName.text === 'UnwrapRef' && type.typeArguments?.length === 1)
          type = type.typeArguments[0]!
        const indexed = ts.isIndexedAccessTypeNode(type) ? type : undefined
        const imported = indexed?.objectType ?? type
        if (!ts.isImportTypeNode(imported) || !imported.isTypeOf || !ts.isLiteralTypeNode(imported.argument)
          || !ts.isStringLiteral(imported.argument.literal) || !matches(imported.argument.literal.text)) {
          return 'None'
        }
        if (indexed && ts.isLiteralTypeNode(indexed.indexType) && ts.isStringLiteral(indexed.indexType.literal)
          && indexed.indexType.literal.text === from) {
          replace(indexed.indexType.literal, true)
          return retains(imported.argument.literal.text) ? 'Add' : 'Replace'
        }
        if (!indexed && imported.qualifier && ts.isIdentifier(imported.qualifier) && imported.qualifier.text === from) {
          replace(imported.qualifier)
          return retains(imported.argument.literal.text) ? 'Add' : 'Replace'
        }
        return 'None'
      }
      for (const statement of source.statements) {
        if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
          && matches(statement.moduleSpecifier.text) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            const imported = element.propertyName ?? element.name
            if (imported.text === from) {
              if (retains(statement.moduleSpecifier.text))
                edits.push({ start: element.end, end: element.end, replacement: `, ${to}` })
              else
                replace(imported, ts.isStringLiteral(imported))
            }
          }
        }
        if (!ts.isModuleDeclaration(statement) || !statement.body || !ts.isModuleBlock(statement.body))
          continue
        if (ts.isIdentifier(statement.name) && statement.name.text === 'global') {
          for (const declaration of statement.body.statements) {
            if (!ts.isVariableStatement(declaration))
              continue
            for (const variable of declaration.declarationList.declarations) {
              const start = edits.length
              const projection = variable.type ? renameType(variable.type) : 'None'
              if (projection !== 'None' && ts.isIdentifier(variable.name) && variable.name.text === from)
                replace(variable.name)
              if (projection === 'Add') {
                const replacements = edits.splice(start)
                if (ts.isIdentifier(variable.name) && variable.name.text === from)
                  duplicate(variable, replacements, declaration.end, 'const ')
              }
            }
          }
        }
        if (ts.isStringLiteral(statement.name) && statement.name.text === 'vue') {
          for (const declaration of statement.body.statements) {
            if (!ts.isInterfaceDeclaration(declaration) || declaration.name.text !== 'ComponentCustomProperties')
              continue
            for (const property of declaration.members) {
              if (!ts.isPropertySignature(property) || !property.type)
                continue
              const start = edits.length
              const projection = renameType(property.type)
              const named = (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === from
              if (projection !== 'None' && named)
                replace(property.name, ts.isStringLiteral(property.name))
              if (projection === 'Add') {
                const replacements = edits.splice(start)
                if (named)
                  duplicate(property, replacements, property.end, '')
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
