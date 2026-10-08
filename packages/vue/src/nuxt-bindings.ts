import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import ts from '@typescript/typescript6'
import { isGeneratedNuxtPath, loadNuxtPathAliases } from './nuxt-paths.ts'

type NuxtBindingNames = { _tag: 'Resolved', names: string[] } | { _tag: 'Unknown' }
type NuxtGlobalProvider = { _tag: 'Missing' } | { _tag: 'Resolved', exported: string, path: string } | { _tag: 'Unknown' }

export function nuxtConsumerContext(path: string, cwd: string): string {
  let current = dirname(path)
  while (current !== cwd) {
    if (existsSync(join(current, '.nuxt')) || ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mts', 'nuxt.config.mjs'].some(name => existsSync(join(current, name))))
      return current
    const parent = dirname(current)
    if (parent === current)
      return cwd
    current = parent
  }
  return cwd
}

/** Exact local providers extend scope without treating every app directory as a Nuxt source directory. */
export function loadNuxtProviderPaths(cwd: string): Set<string> {
  const out = new Set<string>()
  for (const path of [join(cwd, '.nuxt/imports.d.ts'), join(cwd, '.nuxt/types/imports.d.ts')]) {
    if (!existsSync(path))
      continue
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      const module = ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)
        ? node.argument.literal.text
        : ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined
      if (module) {
        const target = resolveBindingTarget(cwd, path, module)
        if (target._tag === 'Resolved')
          out.add(target.path)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return out
}

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
    const target = resolveBindingTarget(cwd, path, specifier)
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

/** Resolve one generated global to its provider export, preserving an absent destination as distinct from invalid metadata. */
export function loadNuxtGlobalProvider(cwd: string, name: string): NuxtGlobalProvider {
  const paths = [join(cwd, '.nuxt/imports.d.ts'), join(cwd, '.nuxt/types/imports.d.ts')].filter(path => existsSync(path))
  if (!paths.length)
    return { _tag: 'Unknown' }
  const providers: { exported: string, path: string }[] = []
  let matched = false
  let unresolved = false
  const record = (specifier: string, exported: string, path: string): void => {
    matched = true
    const target = resolveBindingTarget(cwd, path, specifier)
    if (target._tag === 'Unknown') {
      unresolved = true
      return
    }
    const provider = { exported, path: realpathSync(target.path) }
    if (providers[0] && (providers[0].path !== provider.path || providers[0].exported !== provider.exported))
      unresolved = true
    if (!providers[0])
      providers.push(provider)
  }
  const visit = (node: ts.Node, path: string): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      matched = true
      const nodeType = node.type
      const declared = nodeType && ts.isTypeReferenceNode(nodeType) && ts.isIdentifier(nodeType.typeName)
        && nodeType.typeName.text === 'UnwrapRef' && nodeType.typeArguments?.length === 1
        ? nodeType.typeArguments[0]!
        : nodeType
      const indexed = declared && ts.isIndexedAccessTypeNode(declared) ? declared : undefined
      const type = indexed?.objectType ?? declared
      const exported = indexed && ts.isLiteralTypeNode(indexed.indexType) && ts.isStringLiteral(indexed.indexType.literal)
        ? indexed.indexType.literal.text
        : type && ts.isImportTypeNode(type) && type.qualifier && ts.isIdentifier(type.qualifier) ? type.qualifier.text : undefined
      if (exported && type && ts.isImportTypeNode(type) && type.isTypeOf && ts.isLiteralTypeNode(type.argument) && ts.isStringLiteral(type.argument.literal))
        record(type.argument.literal.text, exported, path)
      else
        unresolved = true
    }
    ts.forEachChild(node, child => visit(child, path))
  }
  for (const path of paths) {
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const host = ts.createCompilerHost({ noLib: true, noResolve: true })
    host.getSourceFile = file => file === path ? source : undefined
    const program = ts.createProgram([path], { noLib: true, noResolve: true }, host)
    if (program.getSyntacticDiagnostics(source).length)
      return { _tag: 'Unknown' }
    for (const statement of source.statements) {
      if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name) && statement.name.text === 'global')
        visit(statement, path)
      if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
        && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const exported of statement.exportClause.elements) {
          if (exported.name.text === name)
            record(statement.moduleSpecifier.text, (exported.propertyName ?? exported.name).text, path)
        }
      }
    }
  }
  if (!matched)
    return { _tag: 'Missing' }
  if (unresolved || providers.length !== 1)
    return { _tag: 'Unknown' }
  return { _tag: 'Resolved', exported: providers[0]!.exported, path: providers[0]!.path }
}

function resolveBindingTarget(cwd: string, declarationPath: string, specifier: string): { _tag: 'Resolved', path: string } | { _tag: 'Unknown' } {
  const bases: string[] = []
  for (const alias of loadNuxtPathAliases(cwd)) {
    const prefix = alias.wildcard ? alias.pattern.slice(0, -1) : alias.pattern
    if (alias.wildcard ? specifier.startsWith(prefix) : specifier === prefix) {
      for (const target of alias.targets)
        bases.push(alias.wildcard ? resolve(target, specifier.slice(prefix.length)) : target)
    }
  }
  // Bare specifiers may name workspace packages whose exports point into this project.
  if (!bases.length && (specifier.startsWith('.') || specifier.startsWith('/'))) {
    bases.push(resolve(dirname(declarationPath), specifier))
  }
  if (!bases.length)
    return { _tag: 'Unknown' }
  const extensions = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']
  const targets = new Set(bases.flatMap(base => [base, ...extensions.map(ext => `${base}${ext}`), ...extensions.map(ext => join(base, `index${ext}`))])
    .filter(path => existsSync(path) && statSync(path).isFile())
    .map(path => realpathSync(path)))
  const target = [...targets][0]
  return targets.size === 1 && target && !isGeneratedNuxtPath(cwd, target) ? { _tag: 'Resolved', path: target } : { _tag: 'Unknown' }
}
