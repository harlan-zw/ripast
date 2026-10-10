import type { FileChange } from 'ripide-api/adapter'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from '@typescript/typescript6'

const MODULE_EXT_RE = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs|vue)$/
const WIN_SEP_RE = /\\/g

export function isGeneratedNuxtPath(cwd: string, filePath: string): boolean {
  const rel = relative(cwd, filePath).replace(/\\/g, '/')
  return rel.split('/').includes('.nuxt')
}

export function removeGeneratedNuxtChanges(cwd: string, changes: FileChange[]): void {
  for (let i = changes.length - 1; i >= 0; i--) {
    if (isGeneratedNuxtPath(cwd, changes[i].path))
      changes.splice(i, 1)
  }
}

export interface PathAlias {
  pattern: string
  targets: string[]
  wildcard: boolean
}

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
    const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, 'utf8'))
    if (parsed.error)
      return []
    const json = parsed.config
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

/**
 * Walk up from a consumer file to its nearest `.nuxt/tsconfig.json` (typically the
 * generated tsconfig of the Nuxt app the file belongs to). Returns the path-aliases
 * declared there, with their targets resolved relative to that tsconfig's baseUrl.
 *
 * In a multi-app Nuxt workspace, each app re-roots `~/*` to its own srcDir, so the
 * workspace-level tsconfig's `~/*` mapping is not portable across consumers. This
 * lets a caller validate whether an alias-prefixed specifier emitted by the TS server
 * actually resolves to the same file from the consumer's app perspective.
 */
export function loadConsumerLocalAliases(consumerFile: string, workspaceCwd: string): PathAlias[] {
  const workspaceNorm = workspaceCwd.replace(WIN_SEP_RE, '/')
  let dir = dirname(consumerFile)
  while (true) {
    const tsconfig = join(dir, '.nuxt/tsconfig.json')
    const dirNorm = dir.replace(WIN_SEP_RE, '/')
    if (dirNorm !== workspaceNorm && existsSync(tsconfig))
      return readTsconfigPaths(tsconfig)
    if (dirNorm === workspaceNorm || dirNorm === '/' || dirNorm === '')
      return []
    const parent = dirname(dir)
    if (parent === dir)
      return []
    dir = parent
  }
}

/**
 * Returns true if `targetFile` is reachable from `consumerFile` through any alias
 * defined in `consumerAliases` whose pattern starts with `specifierPrefix` (e.g. `~`).
 * Used to decide whether an alias prefix emitted into a consumer is portable.
 */
export function aliasResolvesToTarget(
  consumerAliases: PathAlias[],
  specifier: string,
  targetFile: string,
): boolean {
  const targetNorm = targetFile.replace(WIN_SEP_RE, '/')
  for (const alias of consumerAliases) {
    const base = alias.wildcard ? alias.pattern.replace(/\/\*$/, '') : alias.pattern
    if (!alias.wildcard) {
      if (specifier !== alias.pattern)
        continue
      if (alias.targets.some(t => t.replace(WIN_SEP_RE, '/') === targetNorm))
        return true
      continue
    }
    if (specifier !== base && !specifier.startsWith(`${base}/`))
      continue
    const remainder = specifier === base ? '' : specifier.slice(base.length + 1)
    for (const target of alias.targets) {
      const normTarget = target.replace(WIN_SEP_RE, '/')
      const candidate = remainder ? `${normTarget}/${remainder}` : normTarget
      if (targetNorm === candidate)
        return true
      if (stripModuleExt(targetNorm) === candidate)
        return true
      if (targetNorm === `${candidate}/index.ts` || targetNorm === `${candidate}/index.js` || targetNorm === `${candidate}/index.vue`)
        return true
    }
  }
  return false
}

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
