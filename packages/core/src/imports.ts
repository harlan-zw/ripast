import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'
import { applyTextEdits } from './util.ts'

// Import declarations as data, with text transforms that re-render only the
// statements they touch. Everything here is syntactic (oxc); nothing needs a
// type checker.

export interface ImportName {
  name: string
  alias?: string
  isTypeOnly?: boolean
}

export interface ImportBinding {
  /** Imported (exported-from-module) name. */
  name: string
  /** Local alias when it differs from `name`. */
  alias?: string
  isTypeOnly: boolean
  /** Offset of the local binding identifier. */
  localStart: number
}

export interface ImportInfo {
  start: number
  end: number
  specifier: string
  quote: string
  semicolon: boolean
  isTypeOnly: boolean
  named: ImportBinding[]
  defaultImport?: { name: string, start: number }
  namespaceImport?: { name: string, start: number }
  sideEffectOnly: boolean
}

export interface ImportSpec {
  namedImports: ImportName[]
  defaultImport?: string
  namespaceImport?: string
  isTypeOnly?: boolean
}

const IMPORT_SPECIFIER_PARENTS = new Set(['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'])

export function parseProgram(path: string, source: string): any {
  return parseSync(path, source).program
}

export function listImports(source: string, path: string, program: any = parseProgram(path, source)): ImportInfo[] {
  const out: ImportInfo[] = []
  for (const node of program.body ?? []) {
    if (node.type !== 'ImportDeclaration')
      continue
    const info: ImportInfo = {
      start: node.start,
      end: node.end,
      specifier: node.source.value,
      quote: source[node.source.start] ?? '\'',
      semicolon: source[node.end - 1] === ';',
      isTypeOnly: node.importKind === 'type',
      named: [],
      sideEffectOnly: !node.specifiers?.length,
    }
    for (const spec of node.specifiers ?? []) {
      if (spec.type === 'ImportDefaultSpecifier') {
        info.defaultImport = { name: spec.local.name, start: spec.local.start }
      }
      else if (spec.type === 'ImportNamespaceSpecifier') {
        info.namespaceImport = { name: spec.local.name, start: spec.local.start }
      }
      else if (spec.type === 'ImportSpecifier') {
        const imported = spec.imported.name ?? spec.imported.value
        const local = spec.local.name
        info.named.push({
          name: imported,
          alias: local !== imported ? local : undefined,
          isTypeOnly: spec.importKind === 'type',
          localStart: spec.local.start,
        })
      }
    }
    out.push(info)
  }
  return out
}

export function localNameOf(binding: ImportBinding): string {
  return binding.alias ?? binding.name
}

export function isImportEmpty(info: ImportInfo): boolean {
  return !info.named.length && !info.defaultImport && !info.namespaceImport
}

export function renderImport(info: Omit<ImportInfo, 'start' | 'end'>): string {
  const q = info.quote
  const semi = info.semicolon ? ';' : ''
  if (info.sideEffectOnly)
    return `import ${q}${info.specifier}${q}${semi}`
  const parts: string[] = []
  if (info.defaultImport)
    parts.push(info.defaultImport.name)
  if (info.namespaceImport)
    parts.push(`* as ${info.namespaceImport.name}`)
  if (info.named.length) {
    const names = info.named.map((n) => {
      const typePrefix = n.isTypeOnly && !info.isTypeOnly ? 'type ' : ''
      return n.alias ? `${typePrefix}${n.name} as ${n.alias}` : `${typePrefix}${n.name}`
    })
    parts.push(`{ ${names.join(', ')} }`)
  }
  const typeKeyword = info.isTypeOnly ? 'type ' : ''
  return `import ${typeKeyword}${parts.join(', ')} from ${q}${info.specifier}${q}${semi}`
}

/**
 * Replace or remove whole import statements. `null` removes the statement and
 * the line break that follows it. `insert` adds new statements after the last
 * import (or at the top of the file).
 */
export function rewriteImports(source: string, imports: ImportInfo[], replacements: Map<ImportInfo, string | null>, insert: string[] = []): string {
  const edits: { start: number, end: number, replacement: string }[] = []
  for (const [info, text] of replacements) {
    if (text === null) {
      const end = source[info.end] === '\n' ? info.end + 1 : info.end
      edits.push({ start: info.start, end, replacement: '' })
    }
    else {
      edits.push({ start: info.start, end: info.end, replacement: text })
    }
  }
  if (insert.length) {
    const last = imports[imports.length - 1]
    if (last && replacements.get(last) === null) {
      // The anchor import is being removed: insert where its line ended.
      const at = source[last.end] === '\n' ? last.end + 1 : last.end
      edits.push({ start: at, end: at, replacement: `${insert.join('\n')}\n` })
    }
    else if (last) {
      edits.push({ start: last.end, end: last.end, replacement: `\n${insert.join('\n')}` })
    }
    else {
      const at = source.startsWith('#!') ? source.indexOf('\n') + 1 || source.length : 0
      edits.push({ start: at, end: at, replacement: `${insert.join('\n')}\n` })
    }
  }
  return applyTextEdits(source, edits)
}

/** Identifier names used outside import specifiers. Scope-insensitive on purpose: a kept import is never wrong. */
export function usedIdentifierNames(program: any): Set<string> {
  const used = new Set<string>()
  walk(program, {
    enter(node: any, parent: any) {
      if (node.type !== 'Identifier' && node.type !== 'JSXIdentifier')
        return
      if (parent && IMPORT_SPECIFIER_PARENTS.has(parent.type))
        return
      used.add(node.name)
    },
  })
  return used
}

export function pruneUnusedImports(source: string, path: string): string {
  const program = parseProgram(path, source)
  const imports = listImports(source, path, program)
  if (!imports.length)
    return source
  const used = usedIdentifierNames(program)
  const replacements = new Map<ImportInfo, string | null>()
  for (const info of imports) {
    if (info.sideEffectOnly)
      continue
    const next: ImportInfo = {
      ...info,
      named: info.named.filter(n => used.has(localNameOf(n))),
      defaultImport: info.defaultImport && used.has(info.defaultImport.name) ? info.defaultImport : undefined,
      namespaceImport: info.namespaceImport && used.has(info.namespaceImport.name) ? info.namespaceImport : undefined,
    }
    const changed = next.named.length !== info.named.length
      || !!next.defaultImport !== !!info.defaultImport
      || !!next.namespaceImport !== !!info.namespaceImport
    if (!changed)
      continue
    replacements.set(info, isImportEmpty(next) ? null : renderImport(next))
  }
  return rewriteImports(source, imports, replacements)
}

/** Add bindings to an existing import of `specifier` (same type-only-ness) or insert a new import statement. */
export function addOrMergeImport(source: string, path: string, specifier: string, spec: ImportSpec): string {
  const program = parseProgram(path, source)
  const imports = listImports(source, path, program)
  const existing = imports.find(i => i.specifier === specifier && i.isTypeOnly === !!spec.isTypeOnly && !i.sideEffectOnly)
  if (existing) {
    const next: ImportInfo = { ...existing, named: [...existing.named] }
    const have = new Set(existing.named.map(n => n.name))
    for (const ni of spec.namedImports) {
      if (have.has(ni.name))
        continue
      have.add(ni.name)
      next.named.push({ name: ni.name, alias: ni.alias, isTypeOnly: !existing.isTypeOnly && !!ni.isTypeOnly, localStart: -1 })
    }
    if (spec.defaultImport && !existing.defaultImport)
      next.defaultImport = { name: spec.defaultImport, start: -1 }
    if (spec.namespaceImport && !existing.namespaceImport)
      next.namespaceImport = { name: spec.namespaceImport, start: -1 }
    const text = renderImport(next)
    return text === source.slice(existing.start, existing.end) ? source : rewriteImports(source, imports, new Map([[existing, text]]))
  }
  const style = imports[0]
  const text = renderImport({
    specifier,
    quote: style?.quote ?? '\'',
    semicolon: style?.semicolon ?? false,
    isTypeOnly: !!spec.isTypeOnly,
    named: spec.namedImports.map(ni => ({ name: ni.name, alias: ni.alias, isTypeOnly: !spec.isTypeOnly && !!ni.isTypeOnly, localStart: -1 })),
    defaultImport: spec.defaultImport ? { name: spec.defaultImport, start: -1 } : undefined,
    namespaceImport: spec.namespaceImport ? { name: spec.namespaceImport, start: -1 } : undefined,
    sideEffectOnly: false,
  })
  return rewriteImports(source, imports, new Map(), [text])
}

/** Append a top-level statement at the end of the file. */
export function appendStatement(source: string, statement: string): string {
  const trimmed = statement.trim()
  if (!source.trim())
    return `${trimmed}\n`
  const base = source.endsWith('\n') ? source : `${source}\n`
  return `${base}${trimmed}\n`
}

const MODULE_EXT_RE = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/
const WIN_SEP_RE = /\\/g

/** Relative specifier from `fromFilePath` to `toFilePath`, keeping the extension style of `styleSpec`. */
export function computeSpecifier(fromFilePath: string, toFilePath: string, styleSpec: string): string {
  const extension = MODULE_EXT_RE.exec(styleSpec)?.[0]
  let rel = relativePosix(fromFilePath, toFilePath)
  if (!extension) {
    rel = rel.replace(MODULE_EXT_RE, '')
  }
  else if (/^\.(?:jsx?|mjs|cjs)$/.test(extension)) {
    const runtimeExtension = /\.(?:jsx?|mjs|cjs)$/.exec(rel)?.[0]
    const emitted = runtimeExtension ?? (rel.endsWith('.mts') ? '.mjs' : rel.endsWith('.cts') ? '.cjs' : rel.endsWith('.tsx') && extension === '.jsx' ? '.jsx' : '.js')
    rel = rel.replace(MODULE_EXT_RE, emitted)
  }
  if (!rel.startsWith('.'))
    rel = `./${rel}`
  return rel
}

function relativePosix(fromFilePath: string, toFilePath: string): string {
  const fromParts = fromFilePath.replace(WIN_SEP_RE, '/').split('/').slice(0, -1)
  const toParts = toFilePath.replace(WIN_SEP_RE, '/').split('/')
  let common = 0
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common])
    common++
  const ups = fromParts.length - common
  const rest = toParts.slice(common)
  return [...Array.from({ length: ups }).fill('..'), ...rest].join('/')
}
