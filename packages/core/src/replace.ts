import type { ImportInfo } from './imports.ts'
import type { VerifyMode } from './project.ts'
import type { TsServer } from './ts-server.ts'
import type { FileChange, TextEdit } from './util.ts'
import type { Regression } from './verify.ts'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import process from 'node:process'
import { walk } from 'oxc-walker'
import { listTopLevelDeclarations, parseSource } from './declarations.ts'
import { addOrMergeImport, computeSpecifier, isImportEmpty, listImports, localNameOf, parseProgram, pruneUnusedImports, renderImport, rewriteImports, usedIdentifierNames } from './imports.ts'
import { isVuePath, projectScriptFiles, resolveVerifyMode, verifyScope } from './project.ts'
import { startTsServer } from './ts-server.ts'
import { applyTextEdits, rgFilesMany } from './util.ts'
import { findRegressions } from './verify.ts'

export interface ReplaceOptions {
  cwd?: string
  glob?: string | string[]
  verify?: boolean | VerifyMode
  targetScope?: string
  /** Import specifier for the validated target, including framework aliases. */
  targetImport?: string
}

export interface ReplaceResult {
  changes: FileChange[]
  scanned: number
  regressions: Regression[]
}

interface ReplacementTarget {
  filePath: string
  importName: string
  isTypeOnly: boolean
  declarationFiles: readonly string[]
}

export async function runReplace(from: string, to: string, opts: ReplaceOptions = {}): Promise<ReplaceResult> {
  const cwd = opts.cwd ?? process.cwd()
  const verifyMode = resolveVerifyMode(opts.verify)
  const targetPaths = opts.targetScope
    ? [resolve(cwd, opts.targetScope)]
    : rgFilesMany([to, '\\u'], { cwd, glob: opts.glob }).filter(path => !isVuePath(path))
  if (opts.targetImport !== undefined && (!opts.targetImport || /[\s'"\\]/.test(opts.targetImport)))
    throw new Error('ripast replace: --target-import requires an import path without whitespace, quotes, or backslashes')

  const server = await startTsServer(cwd)
  try {
    const target = await findReplacementTarget(server, targetPaths, to, cwd, opts.targetScope)
    // A wrapper may call the imported symbol it replaces. Rewriting it creates recursion.
    const candidatePaths = rgFilesMany([from, '\\u'], { cwd, glob: opts.glob }).filter(path => !isVuePath(path) && !target.declarationFiles.includes(path))
    const projectStyle = inferProjectSpecifierStyle(cwd)
    const changes: FileChange[] = []
    for (const path of candidatePaths) {
      const before = readFileSync(path, 'utf8')
      const after = await replaceImportedSymbol(server, path, before, from, to, target, projectStyle, opts.targetImport)
      if (after !== before)
        changes.push({ path, rel: relative(cwd, path), before, after })
    }
    const regressions = verifyMode === 'none'
      ? []
      : await findRegressions(server, changes, verifyScope(verifyMode, cwd, candidatePaths, changes.map(c => c.path), opts.glob))
    return { changes, scanned: candidatePaths.length, regressions }
  }
  finally {
    server.dispose()
  }
}

async function findReplacementTarget(server: TsServer, paths: string[], symbol: string, cwd: string, targetScope?: string): Promise<ReplacementTarget> {
  const scopeAbs = targetScope ? resolve(cwd, targetScope) : null
  const matches: ReplacementTarget[] = []
  for (const path of paths) {
    if (scopeAbs && path !== scopeAbs)
      continue
    const { program } = parseSource(path, readFileSync(path, 'utf8'))
    const decl = listTopLevelDeclarations(program).find(d => d.name === symbol && d.exported && !d.isDefault)
    if (decl) {
      matches.push({ filePath: path, importName: symbol, isTypeOnly: decl.kind === 'interface' || decl.kind === 'type', declarationFiles: [path] })
      continue
    }
    // Automatic discovery includes same-file export lists.
    // Select module re-exports explicitly with targetScope.
    for (const statement of program.body) {
      if (statement.type !== 'ExportNamedDeclaration' || statement.declaration)
        continue
      if (!targetScope && statement.source)
        continue
      const specifier = statement.specifiers.find((item: { exported: { name?: string, value?: string } }) => (item.exported.name ?? item.exported.value) === symbol)
      if (!specifier)
        continue
      let isTypeOnly = statement.exportKind === 'type' || specifier.exportKind === 'type'
      const declarationFiles = [path]
      if (!isTypeOnly) {
        server.open(path)
        const definitions = await server.definition(path, specifier.local.start)
        for (const definition of definitions) {
          declarationFiles.push(definition.path)
          const resolved = parseSource(definition.path, server.textOf(definition.path)).program
          const declaration = listTopLevelDeclarations(resolved).find(item => item.start <= definition.start && definition.start < item.end)
          if (declaration?.kind === 'interface' || declaration?.kind === 'type') {
            isTypeOnly = true
            break
          }
        }
      }
      matches.push({ filePath: path, importName: symbol, isTypeOnly, declarationFiles })
      break
    }
  }
  if (!matches.length) {
    if (targetScope)
      throw new Error(`ripast replace: no exported declaration of "${symbol}" in ${targetScope}`)
    throw new Error(`ripast replace: no exported declaration of "${symbol}" found in project`)
  }
  const uniqueFiles = new Set(matches.map(m => relative(cwd, m.filePath)))
  if (uniqueFiles.size > 1) {
    throw new Error(
      `ripast replace: "${symbol}" is exported from multiple files (${[...uniqueFiles].join(', ')}). `
      + `Pass --target-scope <file> to pick one.`,
    )
  }
  return matches[0]
}

interface ImportedBinding {
  imp: ImportInfo
  kind: 'named' | 'default'
  name?: string
  offset: number
}

async function replaceImportedSymbol(server: TsServer, path: string, source: string, from: string, to: string, target: ReplacementTarget, projectStyle: (path: string) => string, targetImport?: string): Promise<string> {
  const program = parseProgram(path, source)
  const imports = listImports(source, path, program)
  const bindings: ImportedBinding[] = []
  for (const imp of imports) {
    for (const n of imp.named) {
      if (localNameOf(n) === from)
        bindings.push({ imp, kind: 'named', name: n.name, offset: n.localStart })
    }
    if (imp.defaultImport?.name === from)
      bindings.push({ imp, kind: 'default', offset: imp.defaultImport.start })
  }
  if (!bindings.length)
    return source

  // Keep the original local binding when the target name could capture references.
  // It already resolves correctly at each semantic reference, including nested scopes.
  const occupied = usedIdentifierNames(program)
  for (const imp of imports) {
    for (const named of imp.named)
      occupied.add(localNameOf(named))
    if (imp.defaultImport)
      occupied.add(imp.defaultImport.name)
    if (imp.namespaceImport)
      occupied.add(imp.namespaceImport.name)
  }
  const localName = from !== to && occupied.has(to) ? from : to

  const referenceReplacements = new Map<number, string>()
  const bindingNames = new Set<number>()
  const qualifiedNames = new Set<number>()
  const reexports: { start: number, end: number }[] = []
  walk(program, {
    enter(node: any) {
      if ((node.type === 'Identifier' || node.type === 'JSXIdentifier') && node.name === from)
        bindingNames.add(node.start)
      if (node.type === 'Identifier' && node.name === from && source.slice(node.start, node.end).includes('\\u'))
        throw new Error(`ripast replace: TypeScript cannot resolve escaped references to "${from}" in ${path}`)
      if ((node.type === 'MemberExpression' && !node.computed) || node.type === 'JSXMemberExpression')
        qualifiedNames.add(node.property.start)
      if (node.type === 'TSQualifiedName')
        qualifiedNames.add(node.right.start)
      if ((node.type === 'Property' || node.type === 'ObjectProperty') && !node.computed && !node.shorthand)
        qualifiedNames.add(node.key.start)
      if (node.type === 'ExportNamedDeclaration' && node.source)
        reexports.push({ start: node.start, end: node.end })
      if (node.type === 'Property' && node.shorthand && node.value?.type === 'Identifier')
        referenceReplacements.set(node.value.start, `${source.slice(node.key.start, node.key.end)}: ${localName}`)
      if (node.type === 'ExportSpecifier') {
        const exportedName = source.slice(node.exported.start, node.exported.end)
        if (node.local.start === node.exported.start)
          referenceReplacements.set(node.local.start, `${localName} as ${exportedName}`)
        else
          referenceReplacements.set(node.exported.start, exportedName)
      }
    },
  })

  server.open(path, source)
  const edits: TextEdit[] = []
  let replaced = false
  for (const binding of bindings) {
    for (const ref of await server.references(path, binding.offset)) {
      if (ref.path !== path || imports.some(i => ref.start >= i.start && ref.start < i.end))
        continue
      // References can follow the exported symbol through other local aliases,
      // namespaces, and re-exports. Only this imported local binding changes.
      if (!bindingNames.has(ref.start) || qualifiedNames.has(ref.start) || reexports.some(range => ref.start >= range.start && ref.start < range.end))
        continue
      edits.push({ start: ref.start, end: ref.end, replacement: referenceReplacements.get(ref.start) ?? localName })
      replaced = true
    }
  }

  const working = new Map<ImportInfo, ImportInfo>()
  for (const binding of bindings) {
    const current = working.get(binding.imp) ?? { ...binding.imp, named: [...binding.imp.named] }
    if (binding.kind === 'named')
      current.named = current.named.filter(n => localNameOf(n) !== from)
    else
      current.defaultImport = undefined
    working.set(binding.imp, current)
  }
  for (const [imp, current] of working) {
    if (isImportEmpty(current)) {
      const end = source[imp.end] === '\n' ? imp.end + 1 : imp.end
      edits.push({ start: imp.start, end, replacement: '' })
    }
    else {
      edits.push({ start: imp.start, end: imp.end, replacement: renderImport(current) })
    }
  }
  const stripped = applyTextEdits(source, edits)
  if (!replaced)
    return stripped

  const style = bindings.find(binding => relativeScriptSpecifier(binding.imp.specifier))?.imp.specifier
    ?? imports.find(imp => relativeScriptSpecifier(imp.specifier))?.specifier
    ?? projectStyle(path)
  const specifier = targetImport ?? computeSpecifier(path, target.filePath, style)
  if (localName !== to) {
    // A separate import permits an alias even when the target is already imported.
    const aliasImport = renderImport({
      ...bindings[0].imp,
      specifier,
      isTypeOnly: target.isTypeOnly,
      named: [{ name: target.importName, alias: localName, isTypeOnly: false, localStart: -1 }],
      defaultImport: undefined,
      namespaceImport: undefined,
      sideEffectOnly: false,
    })
    return pruneUnusedImports(rewriteImports(stripped, listImports(stripped, path), new Map(), [aliasImport]), path)
  }
  const withImport = addOrMergeImport(stripped, path, specifier, {
    namedImports: [{ name: target.importName, alias: target.importName === to ? undefined : to, isTypeOnly: target.isTypeOnly }],
    isTypeOnly: target.isTypeOnly,
  })
  return pruneUnusedImports(withImport, path)
}

function relativeScriptSpecifier(specifier: string): boolean {
  return specifier.startsWith('.') && !/[?#]/.test(specifier) && !/\.(?:json|vue|css|scss|sass|less|svg|png|jpe?g|webp|woff2?|wasm)$/.test(specifier)
}

function inferProjectSpecifierStyle(cwd: string): (path: string) => string {
  let entries: { directory: string[], style: string }[] | undefined
  return (path) => {
    entries ??= projectScriptFiles(cwd).flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      return listImports(source, file).filter(imp => relativeScriptSpecifier(imp.specifier)).map(imp => ({ directory: dirname(file).split(/[\\/]/), style: imp.specifier }))
    })
    const directory = dirname(path).split(/[\\/]/)
    let nearest = Infinity
    const counts = new Map<string, { count: number, style: string }>()
    for (const entry of entries) {
      let common = 0
      while (common < directory.length && directory[common] === entry.directory[common])
        common++
      const distance = directory.length + entry.directory.length - 2 * common
      if (distance > nearest)
        continue
      if (distance < nearest) {
        nearest = distance
        counts.clear()
      }
      const ending = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/.exec(entry.style)?.[0] ?? ''
      const previous = counts.get(ending)
      counts.set(ending, { count: (previous?.count ?? 0) + 1, style: entry.style })
    }
    return [...counts.values()].sort((a, b) => b.count - a.count || a.style.localeCompare(b.style))[0]?.style ?? './placeholder'
  }
}
