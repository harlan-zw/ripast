import type { DeclarationTree, DeclarationTreeItem, ExportFilter, ScanGraph, ScanHit, UnusedDeclarations } from 'ripide-api'
import type { OutputSelection } from './output.ts'
import { formatOutputPage, selectOutput } from './output.ts'

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

export function formatAgentHits(hits: ScanHit[], options: OutputSelection = { limit: 40 }): string {
  const page = selectOutput(hits, options, hit => hit.file)
  const visibleFiles = new Set(page.results.map(hit => hit.file))
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
    for (const [file, fileHits] of [...byFile.entries()].filter(([file]) => visibleFiles.has(file)).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
      const kinds = summarizeKinds(fileHits)
      const first = fileHits[0]
      lines.push(`  ${file}: ${fileHits.length} (${kinds}); first L${first.line}:${first.col}`)
    }
  }
  lines.push(formatOutputPage(page))
  if (page.omitted)
    lines.push('Retrieve more with --offset, --limit, or --file.')
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

export function formatAgentDeclarationTree(tree: DeclarationTree, exportFilter: ExportFilter = 'exported', options: OutputSelection = { limit: 40 }): string {
  const page = selectOutput(tree.files, options, file => file.file)
  const lines = ['architecture', formatOutputPage(page)]
  for (const file of page.results) {
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
  const lines = ['digraph ripide_scan {', '  rankdir=LR;']
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
