import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { findFiles, hyphenateVueName } from '@ripast/core/adapter'
import { loadNuxtPathAliases } from './nuxt-paths.ts'

export type ComponentKind = 'sfc' | 'define-component'

export type PropsResolution = 'literal' | 'unresolved'

export interface VueComponent {
  id: string
  /** Canonical name: Nuxt's registered identifier when manifest-sourced, basename otherwise. */
  name: string
  /** Always the Nuxt-registered name when manifest-sourced; null in filesystem-only mode. */
  registeredName: string | null
  aliases: string[]
  file: string
  rel: string
  kind: ComponentKind
  layer?: string
  scope: 'auto-import' | 'global' | 'explicit'
  shadowed: boolean
  shadowedBy?: string
  source: 'manifest' | 'filesystem'
}

export interface ListComponentsOptions {
  glob?: string[]
  /** Force one of the resolution strategies. Default: 'auto' (manifest if present, else filesystem). */
  source?: 'auto' | 'manifest' | 'filesystem'
  /** Emit warnings to this sink (default: process.stderr). Pass () => {} to silence. */
  warn?: (msg: string) => void
}

interface ManifestEntry {
  name: string
  importPath: string
  lazy: boolean
}

const MANIFEST_PATH = '.nuxt/components.d.ts'

// Matches all forms emitted by Nuxt's components.d.ts across versions:
//   Name: typeof import("...")["default"]                            (interface property)
//   export const Name: typeof import("...")['default']               (top-level const)
//   export const LazyName: LazyComponent<typeof import("...")['..']> (Nuxt 4+ lazy wrapper)
const MANIFEST_ENTRY_RE = /^\s*(?:export\s+const\s+)?([A-Z]\w*)\s*:\s*(?:LazyComponent<\s*)?typeof\s+import\(\s*["']([^"']+)["']\s*\)\s*\[\s*["']default["']\s*\]/gm

const COMPONENT_DIR_NAMES = new Set(['components'])

const DEFAULT_VUE_GLOB = ['*.vue']

export function listComponents(cwd: string, opts: ListComponentsOptions = {}): VueComponent[] {
  const source = opts.source ?? 'auto'
  const warn = opts.warn ?? (msg => process.stderr.write(`${msg}\n`))

  const manifestPath = join(cwd, MANIFEST_PATH)
  const manifestPresent = existsSync(manifestPath)

  if (source === 'manifest' || (source === 'auto' && manifestPresent)) {
    if (!manifestPresent) {
      warn(`ripast components: ${MANIFEST_PATH} not found at ${cwd}; cannot use manifest source.`)
      return []
    }
    const fromManifest = readManifest(cwd, manifestPath)
    const overlay = filesystemOverlay(cwd, opts.glob ?? DEFAULT_VUE_GLOB, fromManifest)
    return [...fromManifest, ...overlay].sort(sortComponents)
  }

  if (source === 'auto')
    warn(`ripast components: ${MANIFEST_PATH} not found; falling back to filesystem glob. Run \`nuxi prepare\` for accurate resolution.`)

  return filesystemOnly(cwd, opts.glob ?? DEFAULT_VUE_GLOB).sort(sortComponents)
}

function readManifest(cwd: string, manifestPath: string): VueComponent[] {
  const source = readFileSync(manifestPath, 'utf8')
  const entries = parseManifest(source, cwd, manifestPath)

  // Collapse Lazy* aliases onto the underlying component.
  const byImportPath = new Map<string, ManifestEntry[]>()
  for (const entry of entries) {
    const list = byImportPath.get(entry.importPath) ?? []
    list.push(entry)
    byImportPath.set(entry.importPath, list)
  }

  const out: VueComponent[] = []
  for (const [importPath, group] of byImportPath) {
    const file = resolveImportPath(cwd, manifestPath, importPath)
    if (!file)
      continue
    const primary = group.find(g => !g.lazy) ?? group[0]
    const aliases = new Set<string>()
    aliases.add(hyphenateVueName(primary.name))
    for (const g of group) aliases.add(g.name)
    aliases.delete(primary.name)
    out.push({
      id: file,
      name: primary.name,
      registeredName: primary.name,
      aliases: [...aliases].sort(),
      file,
      rel: relative(cwd, file),
      kind: file.endsWith('.vue') ? 'sfc' : 'define-component',
      scope: 'auto-import',
      shadowed: false,
      source: 'manifest',
    })
  }
  return out
}

function parseManifest(source: string, _cwd: string, _manifestPath: string): ManifestEntry[] {
  const out: ManifestEntry[] = []
  for (const match of source.matchAll(MANIFEST_ENTRY_RE)) {
    const fullName = match[1]!
    const importPath = match[2]!
    const lazy = fullName.startsWith('Lazy') && /^Lazy[A-Z]/.test(fullName)
    out.push({ name: fullName, importPath, lazy })
  }
  return out
}

function resolveImportPath(cwd: string, manifestPath: string, importPath: string): string | null {
  const manifestDir = resolve(manifestPath, '..')
  const bases = candidateBases(cwd, manifestDir, importPath)
  for (const base of bases) {
    if (existsSync(base) && statSync(base).isFile())
      return base
    for (const ext of ['.vue', '.ts', '.tsx', '.js', '.jsx', '.mjs']) {
      const candidate = `${base}${ext}`
      if (existsSync(candidate))
        return candidate
    }
  }
  return null
}

function candidateBases(cwd: string, manifestDir: string, importPath: string): string[] {
  if (importPath.startsWith('.'))
    return [resolve(manifestDir, importPath)]
  const aliases = loadNuxtPathAliases(cwd)
  const out: string[] = []
  for (const alias of aliases) {
    if (!alias.wildcard) {
      if (importPath === alias.pattern) {
        for (const target of alias.targets) out.push(resolve(cwd, target))
      }
      continue
    }
    const prefix = alias.pattern.replace(/\*$/, '')
    if (!importPath.startsWith(prefix))
      continue
    const tail = importPath.slice(prefix.length)
    for (const target of alias.targets) {
      const targetPrefix = target.replace(/\*$/, '')
      out.push(resolve(cwd, targetPrefix + tail))
    }
  }
  // Fallback: treat as cwd-relative path (Nuxt sometimes emits bare paths).
  out.push(resolve(cwd, importPath))
  return out
}

function filesystemOverlay(cwd: string, glob: string[], manifestComponents: VueComponent[]): VueComponent[] {
  const manifestByRealPath = new Set<string>()
  for (const c of manifestComponents)
    manifestByRealPath.add(realOrSelf(c.id))
  const manifestByName = new Map(manifestComponents.map(c => [c.name, c]))
  const candidates = discoverVueFiles(cwd, glob)
  const out: VueComponent[] = []
  for (const file of candidates) {
    if (manifestByRealPath.has(realOrSelf(file)))
      continue
    if (!isUnderComponentsDir(cwd, file))
      continue
    const name = filenameToComponentName(file)
    const shadowedBy = manifestByName.get(name)
    out.push({
      id: file,
      name,
      registeredName: null,
      aliases: [hyphenateVueName(name)],
      file,
      rel: relative(cwd, file),
      kind: 'sfc',
      scope: 'auto-import',
      shadowed: !!shadowedBy,
      shadowedBy: shadowedBy?.id,
      source: 'filesystem',
    })
  }
  return out
}

function realOrSelf(file: string): string {
  try {
    return realpathSync(file)
  }
  catch {
    return file
  }
}

function filesystemOnly(cwd: string, glob: string[]): VueComponent[] {
  const files = discoverVueFiles(cwd, glob).filter(file => isUnderComponentsDir(cwd, file))
  const byName = new Map<string, string[]>()
  for (const file of files) {
    const name = filenameToComponentName(file)
    const list = byName.get(name) ?? []
    list.push(file)
    byName.set(name, list)
  }
  const out: VueComponent[] = []
  for (const file of files) {
    const name = filenameToComponentName(file)
    const sameName = byName.get(name) ?? []
    // First file wins arbitrarily when no manifest; flag others as collision (not "shadowed", since we don't know precedence).
    const isFirst = sameName[0] === file
    out.push({
      id: file,
      name,
      registeredName: null,
      aliases: [hyphenateVueName(name)],
      file,
      rel: relative(cwd, file),
      kind: 'sfc',
      scope: 'auto-import',
      shadowed: !isFirst,
      shadowedBy: isFirst ? undefined : sameName[0],
      source: 'filesystem',
    })
  }
  return out
}

function discoverVueFiles(cwd: string, glob: string[]): string[] {
  return findFiles('', { cwd, glob, listAll: true }).filter(f => f.endsWith('.vue'))
}

function isUnderComponentsDir(cwd: string, file: string): boolean {
  const rel = relative(cwd, file).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..'))
    return false
  const segments = rel.split('/')
  return segments.some(seg => COMPONENT_DIR_NAMES.has(seg))
}

function filenameToComponentName(file: string): string {
  const base = basename(file).replace(/\.vue$/, '')
  return base
    .split(/[-_.]/)
    .filter(Boolean)
    .map(part => part[0]!.toUpperCase() + part.slice(1))
    .join('')
}

function sortComponents(a: VueComponent, b: VueComponent): number {
  return a.name.localeCompare(b.name) || a.rel.localeCompare(b.rel)
}
