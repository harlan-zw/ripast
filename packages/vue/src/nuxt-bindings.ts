import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from '@typescript/typescript6'
import { aliasResolvesToTarget, loadNuxtPathAliases } from './nuxt-paths.ts'

type NuxtBindingNames = { _tag: 'Resolved', names: string[] } | { _tag: 'Unknown' }

/** Match generated global names to the exact source export, including aliased globals. */
export function loadNuxtBindingNames(cwd: string, symbol: string, fromAbs: string): NuxtBindingNames {
  const paths = [join(cwd, '.nuxt/imports.d.ts'), join(cwd, '.nuxt/types/imports.d.ts')].filter(path => existsSync(path))
  if (!paths.length)
    return { _tag: 'Unknown' }
  const names = new Set<string>()
  let mapped = false
  let unresolved = false
  const providers = new Map<string, string>()
  const record = (name: string, specifier: string, path: string): void => {
    mapped = true
    const target = resolveBindingTarget(cwd, path, specifier, fromAbs)
    if (target._tag === 'Unknown') {
      unresolved = true
      return
    }
    const provider = realpathSync(target.path)
    const previous = providers.get(name)
    if (previous && previous !== provider)
      unresolved = true
    providers.set(name, provider)
    if (provider === realpathSync(fromAbs))
      names.add(name)
  }
  const visit = (node: ts.Node, path: string): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.type) {
      const declared = ts.isTypeReferenceNode(node.type) && ts.isIdentifier(node.type.typeName)
        && node.type.typeName.text === 'UnwrapRef' && node.type.typeArguments?.length === 1
        ? node.type.typeArguments[0]!
        : node.type
      const indexed = ts.isIndexedAccessTypeNode(declared) ? declared : undefined
      const type = indexed?.objectType ?? declared
      const importedName = indexed && ts.isLiteralTypeNode(indexed.indexType) && ts.isStringLiteral(indexed.indexType.literal)
        ? indexed.indexType.literal.text
        : ts.isImportTypeNode(type) && type.qualifier && ts.isIdentifier(type.qualifier) ? type.qualifier.text : undefined
      if (importedName === symbol) {
        mapped = true
        if (!ts.isImportTypeNode(type) || !type.isTypeOf || !ts.isLiteralTypeNode(type.argument) || !ts.isStringLiteral(type.argument.literal)) {
          unresolved = true
        }
        else {
          record(node.name.text, type.argument.literal.text, path)
        }
      }
    }
    ts.forEachChild(node, child => visit(child, path))
  }
  for (const path of paths) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const host = ts.createCompilerHost({ noLib: true, noResolve: true })
    host.getSourceFile = name => name === path ? source : undefined
    const program = ts.createProgram([path], { noLib: true, noResolve: true }, host)
    if (program.getSyntacticDiagnostics(source).length)
      return { _tag: 'Unknown' }
    for (const statement of source.statements) {
      if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name) && statement.name.text === 'global')
        visit(statement, path)
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const exported of statement.exportClause.elements) {
          if ((exported.propertyName ?? exported.name).text === symbol)
            record(exported.name.text, statement.moduleSpecifier.text, path)
        }
      }
    }
  }
  return mapped && !unresolved ? { _tag: 'Resolved', names: [...names] } : { _tag: 'Unknown' }
}

function resolveBindingTarget(cwd: string, declarationPath: string, specifier: string, fromAbs: string): { _tag: 'Resolved', path: string } | { _tag: 'Unknown' } {
  if (/^[~@#]/.test(specifier)) {
    if (aliasResolvesToTarget(loadNuxtPathAliases(cwd), specifier, fromAbs))
      return { _tag: 'Resolved', path: fromAbs }
    return { _tag: 'Unknown' }
  }
  // Bare specifiers may name workspace packages whose exports point into this project.
  if (!specifier.startsWith('.') && !specifier.startsWith('/'))
    return { _tag: 'Unknown' }
  const base = resolve(dirname(declarationPath), specifier)
  const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
  const targets = [base, ...extensions.map(ext => `${base}${ext}`), ...extensions.map(ext => join(base, `index${ext}`))]
    .filter(path => existsSync(path) && statSync(path).isFile())
  return targets.length === 1 ? { _tag: 'Resolved', path: targets[0]! } : { _tag: 'Unknown' }
}
