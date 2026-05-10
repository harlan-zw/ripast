import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'
import { parseFile, posToLineCol, rgFiles } from './util.ts'
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

export function scan(pattern: string, opts: ScanOptions = {}): ScanHit[] {
  const cwd = opts.cwd ?? process.cwd()
  const files = rgFiles(pattern, { cwd, glob: opts.glob })
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
  const files = rgFiles(pattern, { cwd, glob: opts.glob })
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
  const files = rgFiles('', { cwd, glob: opts.glob, fixedStrings: false, listAll: true })
  const exportFilter = opts.exports ?? 'all'
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
    try { return readFileSync(absPath, 'utf8') }
    catch { return '' }
  })()
  if (!source.includes(pattern))
    return
  const exprs = extractTemplateExpressions(source)
  for (const expr of exprs) {
    if (!expr.code.includes(pattern))
      continue
    let program: any
    try { program = parseSync(`${absPath}.expr.ts`, expr.code).program }
    catch { continue }
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
        lines.push(`    ${marker.padEnd(6)} ${decl.kind.padEnd(10)} ${decl.name}  L${decl.line}:${decl.col}`)
      }
    }
    lines.push('')
  }
  lines.push(`${tree.files.length} files`)
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
      return singleDeclaration(node, node.id?.name, 'function', exported || declaredExports.has(node.id?.name), fullSource, offset)
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
        return singleDeclaration(decl, name, node.kind ?? 'var', exported || declaredExports.has(name), fullSource, offset)
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
      : 'default'
  return singleDeclaration(node, node.id?.name ?? 'default', kind, true, fullSource, offset)
}

function singleDeclaration(
  node: any,
  name: string | undefined,
  kind: string,
  exported: boolean,
  fullSource: string,
  offset: number,
): DeclarationTreeItem[] {
  if (!name)
    return []
  const { line, col } = posToLineCol(fullSource, (node.start ?? 0) + offset)
  return [{ name, kind, exported, line, col }]
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
    names.push(decl.name)
    byKind.set(decl.kind, names)
  }
  return [...byKind.entries()]
    .map(([kind, names]) => `${kind} ${names.join(', ')}`)
    .join('; ')
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
