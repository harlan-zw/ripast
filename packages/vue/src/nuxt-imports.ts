import type { FileChange, ScanFn } from '@ripast/core/adapter'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { isGeneratedNuxtPath, loadNuxtPathAliases, resolveBestImportSpecifier } from './nuxt-paths.ts'

export interface ExplicitImportContext {
  cwd: string
  symbols: string[]
  toAbs: string
  fromAbs: string
  existingChanges: FileChange[]
  scan: ScanFn
  noScriptError: (symbol: string) => Error
}

/**
 * Walk every consumer file that references one of `symbols` (via rg scan) and
 * insert an explicit named import from `toAbs`.
 */
export function addNuxtExplicitImports(ctx: ExplicitImportContext): FileChange[] {
  const { cwd, symbols, toAbs, fromAbs, existingChanges, noScriptError, scan } = ctx
  const byPath = new Map(existingChanges.map(change => [change.path, change]))
  const aliases = loadNuxtPathAliases(cwd)
  const consumerSymbols = new Map<string, Set<string>>()
  for (const symbol of symbols) {
    const hits = scan(symbol, { cwd, kinds: ['identifier-reference'] })
    for (const hit of hits) {
      const abs = resolve(cwd, hit.file)
      if (!consumerSymbols.has(abs))
        consumerSymbols.set(abs, new Set())
      consumerSymbols.get(abs)!.add(symbol)
    }
  }
  const out: FileChange[] = []
  for (const [filePath, neededSymbols] of consumerSymbols) {
    if (isGeneratedNuxtPath(cwd, filePath))
      continue
    if (filePath === fromAbs || filePath === toAbs)
      continue
    let current = byPath.get(filePath)?.after ?? readFileSync(filePath, 'utf8')
    const before = byPath.get(filePath)?.before ?? current
    const specifier = resolveBestImportSpecifier(filePath, toAbs, aliases, './placeholder')
    let touched = false
    for (const symbol of neededSymbols) {
      if (hasNamedImport(current, symbol))
        continue
      const next = filePath.endsWith('.vue')
        ? insertVueScriptImport(current, symbol, specifier, noScriptError)
        : insertTopLevelImport(current, symbol, specifier)
      if (next !== current) {
        current = next
        touched = true
      }
    }
    if (touched) {
      out.push({
        path: filePath,
        rel: relative(cwd, filePath),
        before,
        after: current,
      })
    }
  }
  return out
}

export function insertVueScriptImport(
  source: string,
  symbol: string,
  specifier: string,
  noScriptError: (symbol: string) => Error,
): string {
  const match = source.match(/<script(?:\s[^>]*)?>/)
  if (!match || match.index === undefined)
    throw noScriptError(symbol)
  const insertAt = match.index + match[0].length
  const scriptEnd = source.indexOf('</script>', insertAt)
  const scriptSource = scriptEnd >= 0 ? source.slice(insertAt, scriptEnd) : source.slice(insertAt)
  const mergedScript = mergeNamedImport(scriptSource, symbol, specifier)
  if (mergedScript !== scriptSource)
    return `${source.slice(0, insertAt)}${mergedScript}${scriptEnd >= 0 ? source.slice(scriptEnd) : ''}`
  const rest = source[insertAt] === '\n' ? source.slice(insertAt + 1) : source.slice(insertAt)
  return `${source.slice(0, insertAt)}\nimport { ${symbol} } from '${specifier}'\n${rest}`
}

export function insertTopLevelImport(source: string, symbol: string, specifier: string): string {
  const merged = mergeNamedImport(source, symbol, specifier)
  if (merged !== source)
    return merged
  const importLine = `import { ${symbol} } from '${specifier}'\n`
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n')
    if (nl >= 0)
      return `${source.slice(0, nl + 1)}${importLine}${source.slice(nl + 1)}`
  }
  return `${importLine}${source}`
}

export function hasNamedImport(source: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\bimport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s*from\\s*['"]`).test(source)
}

export function mergeNamedImport(source: string, symbol: string, specifier: string): string {
  const spec = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const importRe = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*(['"])${spec}\\2`)
  const match = importRe.exec(source)
  if (!match)
    return source
  const names = match[1].split(',').map(part => part.trim()).filter(Boolean)
  if (names.some(name => name === symbol || name.startsWith(`${symbol} as `)))
    return source
  const replacement = `import { ${[...names, symbol].join(', ')} } from ${match[2]}${specifier}${match[2]}`
  return `${source.slice(0, match.index)}${replacement}${source.slice(match.index + match[0].length)}`
}

const EXPORT_DECL_RE = /^\s*export\s+(?:async\s+)?(?:function|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/gm
const EXPORT_LIST_RE = /^\s*export\s*\{([^}]+)\}/gm

export function extractTopLevelExportNames(source: string): string[] {
  const out = new Set<string>()
  for (const match of source.matchAll(EXPORT_DECL_RE))
    out.add(match[1])
  for (const match of source.matchAll(EXPORT_LIST_RE)) {
    for (const part of match[1].split(',')) {
      const cleaned = part.trim()
      if (!cleaned)
        continue
      const asMatch = cleaned.match(/^(?:type\s+)?[\w$]+\s+as\s+([A-Za-z_$][\w$]*)$/)
      if (asMatch) {
        out.add(asMatch[1])
        continue
      }
      const direct = cleaned.replace(/^type\s+/, '').match(/^([A-Z_$][\w$]*)$/i)
      if (direct)
        out.add(direct[1])
    }
  }
  return [...out]
}
