import type { PathAlias } from './nuxt-paths.ts'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from '@typescript/typescript6'
import { configProperty, literalNuxtConfig, literalString } from './nuxt-config.ts'
import { isGeneratedNuxtPath, loadNuxtPathAliases } from './nuxt-paths.ts'

type NuxtBindingNames = { _tag: 'Resolved', names: string[] } | { _tag: 'Unknown' }

/** Select the generated declarations used by the consumer's Nuxt runtime. */
export function nuxtImportMetadataPaths(cwd: string, consumerPath?: string): string[] {
  const app = [join(cwd, '.nuxt/imports.d.ts'), join(cwd, '.nuxt/types/imports.d.ts')]
  const server = join(cwd, '.nuxt/types/nitro-imports.d.ts')
  const shared = join(cwd, '.nuxt/types/shared-imports.d.ts')
  if (!consumerPath)
    return [...app, server, shared].filter(path => existsSync(path))
  const inDirectory = (directory: string): boolean => {
    const rel = relative(directory, consumerPath).replace(/\\/g, '/')
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('/'))
  }
  const inProject = (name: string): boolean => {
    const configPath = join(cwd, '.nuxt', name)
    if (!existsSync(configPath))
      return false
    const parsed = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'))
    if (parsed.error)
      throw new Error(`ripast: cannot read Nuxt runtime configuration in ${configPath}. Run Nuxt prepare first.`)
    return (parsed.config.include ?? []).some((pattern: unknown) => typeof pattern === 'string'
      && pattern.endsWith('/**/*') && inDirectory(resolve(dirname(configPath), pattern.slice(0, -5))))
  }
  if (existsSync(shared) && (inDirectory(join(cwd, 'shared')) || inProject('tsconfig.shared.json')))
    return [shared]
  if (inDirectory(join(cwd, 'server')) || inProject('tsconfig.server.json'))
    return [server].filter(path => existsSync(path))
  return app.filter(path => existsSync(path))
}

export function nuxtConsumerContext(path: string, cwd: string): string {
  let current = dirname(path)
  while (current !== cwd) {
    if ((existsSync(join(current, '.nuxt')) || nuxtConfigPath(current)) && !isRegisteredLayer(cwd, current))
      return current
    const parent = dirname(current)
    if (parent === current)
      return cwd
    current = parent
  }
  return cwd
}

function nuxtConfigPath(cwd: string): string | undefined {
  return ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mts', 'nuxt.config.mjs']
    .map(name => join(cwd, name))
    .find(existsSync)
}

function isRegisteredLayer(cwd: string, target: string): boolean {
  const seen = new Set<string>()
  const visit = (context: string): boolean => {
    if (seen.has(context))
      return false
    seen.add(context)
    const automatic = relative(join(context, 'layers'), target).replace(/\\/g, '/')
    if (automatic && !automatic.includes('/') && automatic !== '..')
      return true
    const configPath = nuxtConfigPath(context)
    const config = configPath ? literalNuxtConfig(readFileSync(configPath, 'utf8')) : undefined
    const extended = configProperty(config, 'extends')
    const layers = extended && ts.isArrayLiteralExpression(extended) ? extended.elements : extended ? [extended] : []
    for (const layer of layers) {
      const path = literalString(layer)
      if (!path?.startsWith('.'))
        continue
      const root = resolve(context, path)
      if (root === target || visit(root))
        return true
    }
    return false
  }
  return visit(cwd)
}

/** Exact local providers extend scope without treating every app directory as a Nuxt source directory. */
export function loadNuxtProviderPaths(cwd: string): Set<string> {
  const out = new Set<string>()
  let aliases: PathAlias[] | undefined
  for (const path of nuxtImportMetadataPaths(cwd)) {
    if (!existsSync(path))
      continue
    const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node): void => {
      const module = ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)
        ? node.argument.literal.text
        : ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined
      if (module) {
        const target = resolveBindingTarget(cwd, path, module, aliases ??= loadNuxtPathAliases(cwd))
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
export function loadNuxtBindingNames(cwd: string, symbol: string, fromAbs: string, consumerPath = fromAbs): NuxtBindingNames {
  const paths = nuxtImportMetadataPaths(cwd, consumerPath)
  if (!paths.length)
    return { _tag: 'Unknown' }
  const names = new Set<string>()
  let mapped = false
  let unresolved = false
  const providers = new Map<string, string>()
  let aliases: PathAlias[] | undefined
  const record = (name: string, specifier: string, path: string): void => {
    mapped = true
    const target = resolveBindingTarget(cwd, path, specifier, aliases ??= loadNuxtPathAliases(cwd))
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
  if (!mapped && paths.join('|') !== nuxtImportMetadataPaths(cwd, fromAbs).join('|')) {
    const provider = loadNuxtBindingNames(cwd, symbol, fromAbs)
    if (provider._tag === 'Resolved')
      return { _tag: 'Resolved', names: [] }
  }
  return mapped && !unresolved ? { _tag: 'Resolved', names: [...names] } : { _tag: 'Unknown' }
}

function resolveBindingTarget(cwd: string, declarationPath: string, specifier: string, aliases: PathAlias[]): { _tag: 'Resolved', path: string } | { _tag: 'Unknown' } {
  const bases: string[] = []
  for (const alias of aliases) {
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

export function isNuxtBindingTarget(cwd: string, declarationPath: string, specifier: string, providers: Set<string>): boolean {
  const target = resolveBindingTarget(cwd, declarationPath, specifier, loadNuxtPathAliases(cwd))
  return target._tag === 'Resolved' && [...providers].some(provider => realpathSync(provider) === target.path)
}
