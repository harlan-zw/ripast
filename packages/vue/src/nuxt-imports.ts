import type { FileChange, ScanFn } from 'ripide-api/adapter'
import type { PathAlias } from './nuxt-paths.ts'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import { rgFiles } from 'ripide-api/adapter'
import { loadNuxtBindingNames, nuxtConsumerContext } from './nuxt-bindings.ts'
import { unboundNuxtSymbols } from './nuxt-consumers.ts'
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
  const { cwd, symbols, toAbs, fromAbs, existingChanges, noScriptError } = ctx
  const byPath = new Map(existingChanges.map(change => [change.path, change]))
  const out: FileChange[] = []
  const byContext = new Map<string, Map<string, string>>()
  const aliasesByContext = new Map<string, PathAlias[]>()
  for (const filePath of rgFiles('', { cwd, listAll: true })) {
    if (isGeneratedNuxtPath(cwd, filePath))
      continue
    if (filePath === fromAbs || filePath === toAbs)
      continue
    const context = nuxtConsumerContext(filePath, cwd)
    let names = byContext.get(context)
    if (!names) {
      names = new Map()
      for (const symbol of symbols) {
        const binding = loadNuxtBindingNames(context, symbol, fromAbs)
        if (binding._tag === 'Unknown')
          throw new Error(`ripide: cannot resolve Nuxt auto-import metadata for "${symbol}" in ${context}. Run Nuxt prepare first.`)
        for (const name of binding.names) {
          if (names.has(name) && names.get(name) !== symbol)
            throw new Error(`ripide: cannot resolve the Nuxt auto-import binding "${name}". Run Nuxt prepare first.`)
          names.set(name, symbol)
        }
      }
      byContext.set(context, names)
    }
    if (!names.size)
      continue
    let current = byPath.get(filePath)?.after ?? readFileSync(filePath, 'utf8')
    const before = byPath.get(filePath)?.before ?? current
    let aliases = aliasesByContext.get(context)
    if (!aliases) {
      const localAliases = loadNuxtPathAliases(context)
      // Conflicting inherited mappings cannot establish a portable alias.
      aliases = localAliases.filter(alias => localAliases.every(other => other.pattern !== alias.pattern || JSON.stringify(other.targets) === JSON.stringify(alias.targets)))
      aliasesByContext.set(context, aliases)
    }
    const specifier = resolveBestImportSpecifier(filePath, toAbs, aliases, './placeholder')
    let touched = false
    for (const [symbol, block] of unboundNuxtSymbols(filePath, current, new Set(names.keys()))) {
      const exported = names.get(symbol)!
      const binding = exported === symbol ? symbol : `${exported} as ${symbol}`
      const next = filePath.endsWith('.vue')
        ? insertVueScriptImport(current, binding, specifier, () => noScriptError(exported), block)
        : insertTopLevelImport(current, binding, specifier)
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
  target?: 'script' | 'scriptSetup',
): string {
  const { descriptor } = parse(source)
  const block = target ? descriptor[target] : descriptor.scriptSetup ?? descriptor.script
  if (!block || block.src)
    throw noScriptError(symbol)
  const insertAt = block.loc.start.offset
  const scriptEnd = block.loc.end.offset
  const scriptSource = block.content
  const mergedScript = mergeNamedImport(scriptSource, symbol, specifier)
  if (mergedScript !== scriptSource)
    return `${source.slice(0, insertAt)}${mergedScript}${source.slice(scriptEnd)}`
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

export function mergeNamedImport(source: string, symbol: string, specifier: string): string {
  const spec = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const importRe = new RegExp(`import\\s*\\{([^}]*)\\}\\s*from\\s*(['"])${spec}\\2`)
  const match = importRe.exec(source)
  if (!match)
    return source
  const names = match[1].split(',').map(part => part.trim()).filter(Boolean)
  if (names.includes(symbol))
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
