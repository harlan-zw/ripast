import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'
import { listTopLevelDeclarations, localExportSpecifierNames, localExportSpecifierRanges, parseSource } from './declarations.ts'
import { listImports } from './imports.ts'
import { startTsServer } from './ts-server.ts'
import { findFiles, findFilesMany, parseFile, posToLineCol } from './util.ts'
import { extractTemplateExpressions } from './vue-template.ts'

export interface ScanHit {
  file: string
  line: number
  col: number
  kind: string
  snippet: string
}

export interface ScanOptions {
  cwd?: string
  glob?: string | string[]
  kinds?: string[]
}

export interface ScanGraphNode {
  file: string
  hits: ScanHit[]
}

export interface ScanGraphEdge {
  from: string
  to: string
  specifier: string
}

export interface ScanGraph {
  pattern: string
  nodes: ScanGraphNode[]
  edges: ScanGraphEdge[]
}

export type ExportFilter = 'all' | 'exported' | 'local'

export interface DeclarationTreeItem {
  name: string
  kind: string
  exported: boolean
  signature?: string
  line: number
  col: number
}

export interface DeclarationTreeFile {
  file: string
  imports: string[]
  reexports: string[]
  declarations: DeclarationTreeItem[]
}

export interface DeclarationTree {
  files: DeclarationTreeFile[]
}

export interface UnusedDeclarationFile {
  file: string
  declarations: DeclarationTreeItem[]
}

export interface UnusedDeclarations {
  files: UnusedDeclarationFile[]
}

export function scan(pattern: string, opts: ScanOptions = {}): ScanHit[] {
  const cwd = opts.cwd ?? process.cwd()
  const files = findFilesMany([pattern, '\\u', '\\x'], { cwd, glob: opts.glob })
  const hits: ScanHit[] = []
  for (const f of files) {
    const file = parseFile(f, cwd)
    const seen = new Set<string>()
    if (file.program) {
      walk(file.program as any, {
        enter(node: any, parent: any) {
          const kind = classify(node, parent, pattern)
          if (!kind)
            return
          if (opts.kinds && !opts.kinds.includes(kind))
            return
          const abs = node.start + file.scriptStart
          const key = `${abs}:${node.end + file.scriptStart}:${kind}`
          if (seen.has(key))
            return
          seen.add(key)
          pushHit(hits, file.rel, file.fullSource, abs, kind)
        },
      })
    }
    if (file.isSfc)
      scanTemplate(f, file.rel, file.fullSource, pattern, opts.kinds, hits, seen)
  }
  return hits
}

export function buildScanGraph(pattern: string, opts: ScanOptions = {}): ScanGraph {
  const cwd = opts.cwd ?? process.cwd()
  const files = findFilesMany([pattern, '\\u', '\\x'], { cwd, glob: opts.glob })
  const hitsByFile = new Map<string, ScanHit[]>()
  const parsed = files.map((f) => {
    const file = parseFile(f, cwd)
    const seen = new Set<string>()
    const hits: ScanHit[] = []
    if (file.program) {
      walk(file.program as any, {
        enter(node: any, parent: any) {
          const kind = classify(node, parent, pattern)
          if (!kind)
            return
          if (opts.kinds && !opts.kinds.includes(kind))
            return
          const abs = node.start + file.scriptStart
          const key = `${abs}:${node.end + file.scriptStart}:${kind}`
          if (seen.has(key))
            return
          seen.add(key)
          pushHit(hits, file.rel, file.fullSource, abs, kind)
        },
      })
    }
    if (file.isSfc)
      scanTemplate(f, file.rel, file.fullSource, pattern, opts.kinds, hits, seen)
    if (hits.length)
      hitsByFile.set(file.path, hits)
    return file
  })

  const nodePathSet = new Set(hitsByFile.keys())
  const edges = new Map<string, ScanGraphEdge>()
  for (const file of parsed) {
    if (!nodePathSet.has(file.path) || !file.program)
      continue
    for (const specifier of importSpecifiers(file.program as any)) {
      const target = resolveModuleSpecifier(file.path, specifier)
      if (!target || !nodePathSet.has(target))
        continue
      const edge = {
        from: relative(cwd, file.path),
        to: relative(cwd, target),
        specifier,
      }
      edges.set(`${edge.from}\0${edge.to}\0${edge.specifier}`, edge)
    }
  }

  return {
    pattern,
    nodes: [...hitsByFile.entries()]
      .map(([path, hits]) => ({ file: relative(cwd, path), hits }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    edges: [...edges.values()].sort((a, b) => `${a.from}\0${a.to}\0${a.specifier}`.localeCompare(`${b.from}\0${b.to}\0${b.specifier}`)),
  }
}

export function buildDeclarationTree(opts: ScanOptions & { exports?: ExportFilter } = {}): DeclarationTree {
  const cwd = opts.cwd ?? process.cwd()
  const files = findFiles('', { cwd, glob: opts.glob, fixedStrings: false, listAll: true })
  const exportFilter = opts.exports ?? 'all'
  return buildDeclarationTreeForPaths(cwd, files, exportFilter)
}

function buildDeclarationTreeForPaths(cwd: string, files: string[], exportFilter: ExportFilter): DeclarationTree {
  const out: DeclarationTreeFile[] = []
  for (const abs of files) {
    const file = parseFile(abs, cwd)
    if (!file.program)
      continue
    const declarations = collectTopLevelDeclarations(file.program as any, file.fullSource, file.scriptStart)
      .filter((d) => {
        if (exportFilter === 'exported')
          return d.exported
        if (exportFilter === 'local')
          return !d.exported
        return true
      })
    const imports = moduleSpecifiers(file.program as any, 'import')
    const reexports = moduleSpecifiers(file.program as any, 'reexport')
    if (!declarations.length && !imports.length && !reexports.length)
      continue
    out.push({
      file: file.rel,
      imports,
      reexports,
      declarations,
    })
  }
  out.sort((a, b) => a.file.localeCompare(b.file))
  return { files: out }
}

export async function buildUnusedDeclarations(opts: ScanOptions & { exports?: ExportFilter } = {}): Promise<UnusedDeclarations> {
  const cwd = opts.cwd ?? process.cwd()
  const exportFilter = opts.exports ?? 'local'
  const candidates = findFiles('', { cwd, glob: opts.glob, fixedStrings: false, listAll: true })
    .filter(path => !path.endsWith('.vue'))
  const tree = buildDeclarationTreeForPaths(cwd, candidates, exportFilter)
  const treeByFile = new Map(tree.files.map(file => [resolve(cwd, file.file), file]))
  const potentialReferenceNames = buildPotentialReferenceNames(candidates, cwd)
  const importedNames = buildImportedNames(candidates)

  const unusedByFile = new Map<string, Set<string>>()
  const server = await startTsServer(cwd)
  try {
    for (const path of candidates) {
      if (!treeByFile.has(path))
        continue
      const { program } = parseSource(path, readFileSync(path, 'utf8'))
      const declaredExports = localExportSpecifierNames(program)
      const exportRanges = localExportSpecifierRanges(program)
      for (const decl of listTopLevelDeclarations(program)) {
        const exported = decl.exported || declaredExports.has(decl.name)
        if (exportFilter === 'exported' && !exported)
          continue
        if (exportFilter === 'local' && exported)
          continue
        if (!potentialReferenceNames.has(decl.name)) {
          addUnusedName(unusedByFile, path, decl.name)
          continue
        }
        // An explicit import of the name from this file is a reference, even
        // when the importer sits outside the server's project (e.g. .js files
        // without allowJs).
        if (importedNames.get(path)?.has(decl.name))
          continue
        const references = await server.references(path, decl.nameStart)
        const referenced = references.some((ref) => {
          if (ref.path !== path)
            return true
          if (ref.start >= decl.start && ref.start < decl.end)
            return false
          return !exportRanges.some(range => ref.start >= range.start && ref.start < range.end)
        })
        if (!referenced)
          addUnusedName(unusedByFile, path, decl.name)
      }
    }
  }
  finally {
    server.dispose()
  }

  const files: UnusedDeclarationFile[] = []
  for (const file of tree.files) {
    const names = unusedByFile.get(resolve(cwd, file.file))
    if (!names?.size)
      continue
    const declarations = file.declarations.filter(decl => names.has(decl.name))
    if (declarations.length)
      files.push({ file: file.file, declarations })
  }
  return { files }
}

function addUnusedName(unusedByFile: Map<string, Set<string>>, path: string, name: string): void {
  const names = unusedByFile.get(path) ?? new Set<string>()
  names.add(name)
  unusedByFile.set(path, names)
}

/** Names each file exports that some other candidate imports or re-exports from it through a relative specifier. */
function buildImportedNames(paths: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const add = (target: string, name: string): void => {
    const names = out.get(target) ?? new Set<string>()
    names.add(name)
    out.set(target, names)
  }
  for (const path of paths) {
    const source = readFileSync(path, 'utf8')
    let program: any
    try {
      program = parseSync(path, source).program
    }
    catch {
      continue
    }
    for (const imp of listImports(source, path, program)) {
      const target = resolveModuleSpecifier(path, imp.specifier)
      if (!target)
        continue
      for (const n of imp.named) add(target, n.name)
      if (imp.defaultImport)
        add(target, 'default')
    }
    for (const statement of program.body ?? []) {
      if (statement.type !== 'ExportNamedDeclaration' || !statement.source)
        continue
      const target = resolveModuleSpecifier(path, statement.source.value)
      if (!target)
        continue
      for (const spec of statement.specifiers ?? []) add(target, spec.local?.name ?? spec.local?.value)
    }
  }
  return out
}

function scanTemplate(
  absPath: string,
  rel: string,
  fullSource: string,
  pattern: string,
  kinds: string[] | undefined,
  hits: ScanHit[],
  seen: Set<string>,
): void {
  const source = fullSource || (() => {
    try {
      return readFileSync(absPath, 'utf8')
    }
    catch {
      return ''
    }
  })()
  if (!source.includes(pattern) && !/\\[ux]/.test(source))
    return
  const exprs = extractTemplateExpressions(source)
  for (const expr of exprs) {
    if (!expr.code.includes(pattern) && !/\\[ux]/.test(expr.code))
      continue
    let program: any
    try {
      program = parseSync(`${absPath}.expr.ts`, expr.code).program
    }
    catch {
      continue
    }
    if (!program)
      continue
    walk(program, {
      enter(node: any, parent: any) {
        const kind = classify(node, parent, pattern)
        if (!kind)
          return
        if (kinds && !kinds.includes(kind))
          return
        const abs = expr.offsetInSource + node.start
        const key = `${abs}:${expr.offsetInSource + node.end}:${kind}`
        if (seen.has(key))
          return
        seen.add(key)
        pushHit(hits, rel, source, abs, kind)
      },
    })
  }
}

function pushHit(hits: ScanHit[], rel: string, fullSource: string, abs: number, kind: string): void {
  const { line, col } = posToLineCol(fullSource, abs)
  const nl = fullSource.indexOf('\n', abs)
  const snippetEnd = nl === -1 ? fullSource.length : nl
  const lineStart = fullSource.lastIndexOf('\n', abs - 1) + 1
  hits.push({
    file: rel,
    line,
    col,
    kind,
    snippet: fullSource.slice(lineStart, snippetEnd).trim().slice(0, 120),
  })
}

function classify(node: any, parent: any, pattern: string): string | null {
  if (!node)
    return null
  if (node.type === 'Identifier' && node.name === pattern) {
    if (!parent)
      return 'identifier-reference'
    switch (parent.type) {
      case 'ImportSpecifier':
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
      case 'ExportSpecifier':
        return 'import-specifier'
      case 'VariableDeclarator':
        return parent.id === node ? 'identifier-binding' : 'identifier-reference'
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ClassDeclaration':
      case 'ClassExpression':
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSEnumDeclaration':
        return parent.id === node ? 'identifier-binding' : 'identifier-reference'
      case 'MemberExpression':
      case 'TSQualifiedName':
        if (!parent.computed && parent.property === node)
          return 'member-access'
        return 'identifier-reference'
      case 'Property':
      case 'ObjectProperty':
        if (!parent.computed && parent.key === node && parent.value !== node)
          return 'property'
        return 'identifier-reference'
      case 'LabeledStatement':
      case 'BreakStatement':
      case 'ContinueStatement':
        return 'label'
      default:
        return 'identifier-reference'
    }
  }
  if (node.type === 'JSXIdentifier' && node.name === pattern)
    return 'jsx'
  if (node.type === 'Literal' && typeof node.value === 'string' && node.value.includes(pattern))
    return 'string-literal'
  return null
}

export function formatHits(hits: ScanHit[], json: boolean): string {
  if (json)
    return JSON.stringify(hits, null, 2)
  const byKind: Record<string, number> = {}
  const lines: string[] = []
  for (const h of hits) {
    byKind[h.kind] = (byKind[h.kind] ?? 0) + 1
    lines.push(`${h.file}:${h.line}:${h.col}  ${h.kind.padEnd(22)} ${h.snippet}`)
  }
  lines.push('')
  lines.push(`${hits.length} hits across ${new Set(hits.map(h => h.file)).size} files`)
  for (const [k, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1]))
    lines.push(`  ${k.padEnd(22)} ${n}`)
  return lines.join('\n')
}

export function formatAgentHits(hits: ScanHit[]): string {
  const files = new Set(hits.map(h => h.file))
  const byKind: Record<string, number> = {}
  const byFile = new Map<string, ScanHit[]>()
  for (const hit of hits) {
    byKind[hit.kind] = (byKind[hit.kind] ?? 0) + 1
    const fileHits = byFile.get(hit.file) ?? []
    fileHits.push(hit)
    byFile.set(hit.file, fileHits)
  }
  const lines = ['scan']
  lines.push(`${hits.length} hits across ${files.size} files`)
  if (hits.length) {
    lines.push(`kinds: ${Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`)
    lines.push('files:')
    for (const [file, fileHits] of [...byFile.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
      const kinds = summarizeKinds(fileHits)
      const first = fileHits[0]
      lines.push(`  ${file}: ${fileHits.length} (${kinds}); first L${first.line}:${first.col}`)
    }
  }
  return lines.join('\n')
}

export function formatScanGraph(graph: ScanGraph, format: 'mermaid' | 'dot'): string {
  return format === 'dot' ? formatDotGraph(graph) : formatMermaidGraph(graph)
}

export function formatDeclarationTree(tree: DeclarationTree, json: boolean): string {
  if (json)
    return JSON.stringify(tree, null, 2)
  const lines: string[] = []
  for (const file of tree.files) {
    lines.push(file.file)
    if (file.imports.length) {
      lines.push('  imports')
      for (const specifier of file.imports)
        lines.push(`    ${specifier}`)
    }
    if (file.reexports.length) {
      lines.push('  reexports')
      for (const specifier of file.reexports)
        lines.push(`    ${specifier}`)
    }
    if (file.declarations.length) {
      lines.push('  declarations')
      for (const decl of file.declarations) {
        const marker = decl.exported ? 'export' : 'local'
        lines.push(`    ${marker.padEnd(6)} ${decl.kind.padEnd(10)} ${declarationLabel(decl)}  L${decl.line}:${decl.col}`)
      }
    }
    lines.push('')
  }
  lines.push(`${tree.files.length} files`)
  return lines.join('\n')
}

export function formatUnusedDeclarations(unused: UnusedDeclarations, json: boolean): string {
  if (json)
    return JSON.stringify(unused, null, 2)
  const lines: string[] = []
  for (const file of unused.files) {
    lines.push(file.file)
    for (const decl of file.declarations) {
      const marker = decl.exported ? 'exported' : 'local'
      lines.push(`  ${declarationLabel(decl)} ${decl.kind} ${marker} line ${decl.line}: no project references`)
    }
    lines.push('')
  }
  const count = unused.files.reduce((total, file) => total + file.declarations.length, 0)
  lines.push(`${count} unused declaration${count === 1 ? '' : 's'} across ${unused.files.length} file${unused.files.length === 1 ? '' : 's'}`)
  return lines.join('\n')
}

export function formatAgentDeclarationTree(tree: DeclarationTree, exportFilter: ExportFilter = 'exported'): string {
  const lines = ['architecture']
  for (const file of tree.files) {
    const exported = file.declarations.filter(d => d.exported)
    const local = file.declarations.filter(d => !d.exported)
    const localImports = file.imports.filter(i => i.startsWith('.'))
    const externalImports = file.imports.filter(i => !i.startsWith('.'))
    const visibleDeclarations = exportFilter === 'exported'
      ? exported
      : exportFilter === 'local'
        ? local
        : file.declarations
    if (!visibleDeclarations.length && !localImports.length)
      continue
    lines.push(file.file)
    if (localImports.length)
      lines.push(`  imports: ${localImports.join(', ')}`)
    if (externalImports.length)
      lines.push(`  external: ${externalImports.join(', ')}`)
    if (file.reexports.length)
      lines.push(`  reexports: ${file.reexports.join(', ')}`)
    if (exportFilter !== 'local' && exported.length)
      lines.push(`  exports: ${summarizeDeclarations(exported)}`)
    if (exportFilter !== 'exported' && local.length)
      lines.push(`  locals: ${summarizeDeclarations(local)}`)
    else if (local.length)
      lines.push(`  locals: ${local.length}`)
  }
  lines.push(`${tree.files.length} files`)
  return lines.join('\n')
}

interface SourceRange {
  start: number
  end: number
}

function buildPotentialReferenceNames(paths: string[], cwd: string): Set<string> {
  const out = new Set<string>()
  for (const path of paths) {
    const file = parseFile(path, cwd)
    if (!file.program)
      continue
    const ignored = ignoredTopLevelNameRanges(file.program as any, file.scriptStart)
    walk(file.program as any, {
      enter(node: any) {
        const name = potentialReferenceName(node)
        if (!name)
          return
        const start = (node.start ?? 0) + file.scriptStart
        if (ignored.some(range => start >= range.start && start < range.end))
          return
        out.add(name)
      },
    })
  }
  return out
}

function potentialReferenceName(node: any): string | null {
  if (node?.type === 'Identifier' || node?.type === 'JSXIdentifier')
    return node.name ?? null
  // String imports and computed namespace access can reference exported names.
  if (node?.type === 'Literal' && typeof node.value === 'string')
    return node.value
  if (node?.type === 'TemplateElement')
    return node.value.cooked ?? null
  return null
}

function ignoredTopLevelNameRanges(program: any, offset: number): SourceRange[] {
  const ranges: SourceRange[] = []
  const body = program?.body ?? []
  for (const node of body) {
    const declaration = node.type === 'ExportNamedDeclaration' && node.declaration ? node.declaration : node
    if (node.type === 'ExportNamedDeclaration' && !node.declaration && !node.source) {
      for (const spec of node.specifiers ?? [])
        pushNodeRange(ranges, spec.local, offset)
      continue
    }
    if (node.type === 'ExportDefaultDeclaration') {
      pushNodeRange(ranges, node.declaration?.id, offset)
      continue
    }
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration')
      continue
    switch (declaration.type) {
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
      case 'TSInterfaceDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSEnumDeclaration':
        pushBindingNameRange(ranges, declaration.id, offset)
        break
      case 'VariableDeclaration':
        for (const decl of declaration.declarations ?? [])
          pushBindingNameRange(ranges, decl.id, offset)
        break
    }
  }
  return ranges
}

function pushNodeRange(ranges: SourceRange[], node: any, offset: number): void {
  if (!node || typeof node.start !== 'number' || typeof node.end !== 'number')
    return
  ranges.push({ start: node.start + offset, end: node.end + offset })
}

function pushBindingNameRange(ranges: SourceRange[], node: any, offset: number): void {
  if (node?.type === 'Identifier' && typeof node.start === 'number' && typeof node.name === 'string') {
    ranges.push({ start: node.start + offset, end: node.start + offset + node.name.length })
  }
  // Destructuring patterns can contain references in computed keys and defaults.
}

function importSpecifiers(program: any): string[] {
  const out: string[] = []
  walk(program, {
    enter(node: any) {
      const source = node?.source
      if (
        (node.type === 'ImportDeclaration'
          || node.type === 'ExportNamedDeclaration'
          || node.type === 'ExportAllDeclaration')
        && typeof source?.value === 'string'
        && source.value.startsWith('.')
      ) {
        out.push(source.value)
      }
    },
  })
  return out
}

function moduleSpecifiers(program: any, kind: 'import' | 'reexport'): string[] {
  const out = new Set<string>()
  walk(program, {
    enter(node: any) {
      const source = node?.source
      if (typeof source?.value !== 'string')
        return
      if (kind === 'import' && node.type === 'ImportDeclaration')
        out.add(source.value)
      if (kind === 'reexport' && (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration'))
        out.add(source.value)
    },
  })
  return [...out].sort()
}

function collectTopLevelDeclarations(program: any, fullSource: string, offset: number): DeclarationTreeItem[] {
  const body = program?.body ?? []
  const declaredExports = namedExportSpecifiers(body)
  const out: DeclarationTreeItem[] = []
  for (const node of body) {
    if (node.type === 'ExportNamedDeclaration' && node.declaration) {
      out.push(...declarationItems(node.declaration, true, fullSource, offset))
      continue
    }
    if (node.type === 'ExportDefaultDeclaration') {
      out.push(...defaultDeclarationItems(node.declaration, fullSource, offset))
      continue
    }
    if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration' || node.type === 'ImportDeclaration')
      continue
    out.push(...declarationItems(node, false, fullSource, offset, declaredExports))
  }
  return out.sort((a, b) => a.line - b.line || a.col - b.col || a.name.localeCompare(b.name))
}

function namedExportSpecifiers(body: any[]): Set<string> {
  const out = new Set<string>()
  for (const node of body) {
    if (node.type !== 'ExportNamedDeclaration' || node.declaration || node.source)
      continue
    for (const spec of node.specifiers ?? []) {
      const local = spec.local?.name
      if (local)
        out.add(local)
    }
  }
  return out
}

function declarationItems(
  node: any,
  exported: boolean,
  fullSource: string,
  offset: number,
  declaredExports: Set<string> = new Set(),
): DeclarationTreeItem[] {
  switch (node.type) {
    case 'FunctionDeclaration':
      return singleDeclaration(node, node.id?.name, 'function', exported || declaredExports.has(node.id?.name), fullSource, offset, functionSignature(node, node.id?.name, fullSource, offset))
    case 'ClassDeclaration':
      return singleDeclaration(node, node.id?.name, 'class', exported || declaredExports.has(node.id?.name), fullSource, offset)
    case 'TSInterfaceDeclaration':
      return singleDeclaration(node, node.id?.name, 'interface', exported || declaredExports.has(node.id?.name), fullSource, offset)
    case 'TSTypeAliasDeclaration':
      return singleDeclaration(node, node.id?.name, 'type', exported || declaredExports.has(node.id?.name), fullSource, offset)
    case 'TSEnumDeclaration':
      return singleDeclaration(node, node.id?.name, 'enum', exported || declaredExports.has(node.id?.name), fullSource, offset)
    case 'VariableDeclaration':
      return (node.declarations ?? []).flatMap((decl: any) => {
        const name = bindingName(decl.id)
        if (!name)
          return []
        return singleDeclaration(decl, name, node.kind ?? 'var', exported || declaredExports.has(name), fullSource, offset, functionSignature(decl.init, name, fullSource, offset))
      })
    default:
      return []
  }
}

function defaultDeclarationItems(node: any, fullSource: string, offset: number): DeclarationTreeItem[] {
  if (!node)
    return []
  const kind = node.type === 'FunctionDeclaration'
    ? 'function'
    : node.type === 'ClassDeclaration'
      ? 'class'
      : node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression'
        ? 'function'
        : 'default'
  const name = node.id?.name ?? 'default'
  return singleDeclaration(node, name, kind, true, fullSource, offset, functionSignature(node, name, fullSource, offset))
}

function singleDeclaration(
  node: any,
  name: string | undefined,
  kind: string,
  exported: boolean,
  fullSource: string,
  offset: number,
  signature?: string,
): DeclarationTreeItem[] {
  if (!name)
    return []
  const { line, col } = posToLineCol(fullSource, (node.start ?? 0) + offset)
  return [{ name, kind, exported, signature, line, col }]
}

function functionSignature(node: any, name: string | undefined, fullSource: string, offset: number): string | undefined {
  if (!node || !name)
    return undefined
  if (node.type !== 'FunctionDeclaration' && node.type !== 'FunctionExpression' && node.type !== 'ArrowFunctionExpression')
    return undefined
  const typeParameters = sourceSlice(fullSource, node.typeParameters, offset)
  const params = summarizeParams(node.params ?? [], fullSource, offset)
  const returnType = truncatePart(normalizeSource(sourceSlice(fullSource, node.returnType, offset) ?? ''), 80)
  return `${name}${typeParameters ?? ''}(${params})${returnType}`
}

function summarizeParams(params: any[], fullSource: string, offset: number): string {
  const visible = params.slice(0, 4).map(param => truncatePart(normalizeSource(sourceSlice(fullSource, param, offset) ?? ''), 80))
  if (params.length > visible.length)
    visible.push(`...${params.length - visible.length} more`)
  return visible.join(', ')
}

function sourceSlice(fullSource: string, node: any, offset: number): string | undefined {
  if (!node || typeof node.start !== 'number' || typeof node.end !== 'number')
    return undefined
  return fullSource.slice(node.start + offset, node.end + offset)
}

function normalizeSource(source: string): string {
  return source.replace(/\s+/g, ' ').trim()
}

function truncatePart(source: string, max: number): string {
  if (source.length <= max)
    return source
  return `${source.slice(0, max - 3)}...`
}

function bindingName(node: any): string | undefined {
  if (!node)
    return undefined
  if (node.type === 'Identifier')
    return node.name
  if (node.type === 'ObjectPattern')
    return '{...}'
  if (node.type === 'ArrayPattern')
    return '[...]'
  return undefined
}

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue']

function resolveModuleSpecifier(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.'))
    return null
  const base = resolve(dirname(fromFile), specifier)
  for (const ext of RESOLVE_EXTS) {
    const candidate = `${base}${ext}`
    if (existsSync(candidate))
      return candidate
  }
  for (const ext of RESOLVE_EXTS.slice(1)) {
    const candidate = join(base, `index${ext}`)
    if (existsSync(candidate))
      return candidate
  }
  return null
}

function formatMermaidGraph(graph: ScanGraph): string {
  const ids = nodeIds(graph.nodes.map(n => n.file))
  const lines = ['flowchart LR']
  for (const node of graph.nodes) {
    const byKind = summarizeKinds(node.hits)
    lines.push(`  ${ids.get(node.file)}["${escapeMermaid(`${node.file}<br/>${node.hits.length} hits${byKind ? `: ${byKind}` : ''}`)}"]`)
  }
  for (const edge of graph.edges)
    lines.push(`  ${ids.get(edge.from)} -->|${escapeMermaid(edge.specifier)}| ${ids.get(edge.to)}`)
  return lines.join('\n')
}

function formatDotGraph(graph: ScanGraph): string {
  const lines = ['digraph ripast_scan {', '  rankdir=LR;']
  for (const node of graph.nodes) {
    const byKind = summarizeKinds(node.hits)
    lines.push(`  "${escapeDot(node.file)}" [label="${escapeDot(`${node.file}\\n${node.hits.length} hits${byKind ? `: ${byKind}` : ''}`)}"];`)
  }
  for (const edge of graph.edges)
    lines.push(`  "${escapeDot(edge.from)}" -> "${escapeDot(edge.to)}" [label="${escapeDot(edge.specifier)}"];`)
  lines.push('}')
  return lines.join('\n')
}

function summarizeKinds(hits: ScanHit[]): string {
  const byKind: Record<string, number> = {}
  for (const hit of hits) byKind[hit.kind] = (byKind[hit.kind] ?? 0) + 1
  return Object.entries(byKind)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([kind, count]) => `${kind} ${count}`)
    .join(', ')
}

function summarizeDeclarations(declarations: DeclarationTreeItem[]): string {
  const byKind = new Map<string, string[]>()
  for (const decl of declarations) {
    const names = byKind.get(decl.kind) ?? []
    names.push(declarationLabel(decl))
    byKind.set(decl.kind, names)
  }
  return [...byKind.entries()]
    .map(([kind, names]) => `${kind} ${names.join(', ')}`)
    .join('; ')
}

function declarationLabel(decl: DeclarationTreeItem): string {
  return decl.signature ?? decl.name
}

function nodeIds(files: string[]): Map<string, string> {
  const out = new Map<string, string>()
  files.forEach((file, i) => out.set(file, `n${i}`))
  return out
}

function escapeMermaid(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('"', '&quot;').replaceAll('|', '#124;')
}

function escapeDot(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}
