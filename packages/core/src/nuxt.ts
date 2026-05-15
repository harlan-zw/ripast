import type { FileChange } from './util.ts'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

export function isGeneratedNuxtPath(cwd: string, filePath: string): boolean {
  const rel = relative(cwd, filePath).replace(/\\/g, '/')
  return rel === '.nuxt' || rel.startsWith('.nuxt/')
}

export interface PathAlias {
  /** Alias pattern as authored in tsconfig (e.g. "~/*", "#shared", "#layers/foo/*"). */
  pattern: string
  /** Absolute target directories the alias maps to. */
  targets: string[]
  /** Whether the alias used a trailing /* wildcard. */
  wildcard: boolean
}

const MODULE_EXT_RE = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs|vue)$/
const WIN_SEP_RE = /\\/g

export function loadNuxtPathAliases(cwd: string): PathAlias[] {
  const out: PathAlias[] = []
  const seen = new Set<string>()
  const candidates = [
    join(cwd, '.nuxt/tsconfig.json'),
    join(cwd, '.nuxt/tsconfig.app.json'),
    join(cwd, 'tsconfig.json'),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate))
      continue
    for (const alias of readTsconfigPaths(candidate)) {
      const key = `${alias.pattern}|${alias.targets.join(',')}`
      if (seen.has(key))
        continue
      seen.add(key)
      out.push(alias)
    }
  }
  return out
}

function readTsconfigPaths(tsconfigPath: string): PathAlias[] {
  const visited = new Set<string>()
  return collect(tsconfigPath)
  function collect(path: string): PathAlias[] {
    if (visited.has(path) || !existsSync(path))
      return []
    visited.add(path)
    let json: any
    try {
      json = JSON.parse(stripJsonComments(readFileSync(path, 'utf8')))
    }
    catch {
      return []
    }
    const out: PathAlias[] = []
    const co = json.compilerOptions ?? {}
    const baseUrl = co.baseUrl ? resolve(dirname(path), co.baseUrl) : dirname(path)
    const paths = co.paths ?? {}
    for (const [pattern, raw] of Object.entries(paths)) {
      if (!Array.isArray(raw) || !raw.length)
        continue
      const wildcard = pattern.endsWith('/*')
      const targets = (raw as string[]).map(t => resolve(baseUrl, wildcard ? t.replace(/\/\*$/, '') : t))
      out.push({ pattern, targets, wildcard })
    }
    if (json.extends) {
      const exts = Array.isArray(json.extends) ? json.extends : [json.extends]
      for (const ext of exts) {
        const resolved = ext.startsWith('.') ? resolve(dirname(path), ext) : ext
        const withExt = /\.json$/.test(resolved) ? resolved : `${resolved}.json`
        out.push(...collect(withExt))
      }
    }
    return out
  }
}

function stripJsonComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * Pick the most specific import specifier from `fromFile` to `toFile`.
 *
 * Prefers an alias when `fromFile` and `toFile` live under different alias roots
 * (the typical Nuxt layer-to-layer case). Falls back to a relative specifier when
 * both files share an alias root, or no alias resolves the target.
 */
export function resolveBestImportSpecifier(
  fromFile: string,
  toFile: string,
  aliases: PathAlias[],
  oldSpec?: string,
): string {
  const targetAlias = pickAliasFor(toFile, aliases)
  const sourceAlias = pickAliasFor(fromFile, aliases)
  const crossesLayer = !!targetAlias
    && (!sourceAlias || sourceAlias.matchedRoot !== targetAlias.matchedRoot)
  if (crossesLayer && targetAlias)
    return formatAliasSpecifier(targetAlias, oldSpec)
  return formatRelativeSpecifier(fromFile, toFile, oldSpec)
}

interface AliasMatch {
  pattern: string
  matchedRoot: string
  remainder: string
  wildcard: boolean
}

function pickAliasFor(file: string, aliases: PathAlias[]): AliasMatch | null {
  const normFile = file.replace(WIN_SEP_RE, '/')
  let best: AliasMatch | null = null
  for (const alias of aliases) {
    for (const target of alias.targets) {
      const normTarget = target.replace(WIN_SEP_RE, '/')
      if (alias.wildcard) {
        if (normFile === normTarget || normFile.startsWith(`${normTarget}/`)) {
          const remainder = normFile === normTarget ? '' : normFile.slice(normTarget.length + 1)
          if (!best || normTarget.length > best.matchedRoot.length)
            best = { pattern: alias.pattern, matchedRoot: normTarget, remainder, wildcard: true }
        }
      }
      else if (normFile === normTarget || stripModuleExt(normFile) === normTarget) {
        if (!best || normTarget.length > best.matchedRoot.length)
          best = { pattern: alias.pattern, matchedRoot: normTarget, remainder: '', wildcard: false }
      }
    }
  }
  return best
}

function formatAliasSpecifier(match: AliasMatch, oldSpec?: string): string {
  if (!match.wildcard)
    return match.pattern
  const base = match.pattern.replace(/\/\*$/, '')
  const hasExt = oldSpec !== undefined && MODULE_EXT_RE.test(oldSpec)
  const tail = hasExt ? match.remainder : match.remainder.replace(MODULE_EXT_RE, '')
  return tail ? `${base}/${tail}` : base
}

function formatRelativeSpecifier(fromFile: string, toFile: string, oldSpec?: string): string {
  const hasExt = oldSpec !== undefined && MODULE_EXT_RE.test(oldSpec)
  let rel = relative(dirname(fromFile), toFile).replace(WIN_SEP_RE, '/')
  if (!hasExt)
    rel = rel.replace(MODULE_EXT_RE, '')
  if (!rel.startsWith('.'))
    rel = `./${rel}`
  return rel
}

function stripModuleExt(path: string): string {
  return path.replace(MODULE_EXT_RE, '')
}

export function removeGeneratedNuxtChanges(cwd: string, changes: FileChange[]): void {
  for (let i = changes.length - 1; i >= 0; i--) {
    if (isGeneratedNuxtPath(cwd, changes[i].path))
      changes.splice(i, 1)
  }
}

export function isInsideNuxtAutoImportScope(filePath: string, scopes: Set<string>): boolean {
  const normalizedFile = normalizePath(filePath)
  for (const scope of scopes) {
    const normalizedScope = normalizePath(scope)
    if (normalizedFile === normalizedScope || normalizedFile.startsWith(`${normalizedScope}/`))
      return true
  }
  return false
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}
