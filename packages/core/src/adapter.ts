import type { FileChange, TextEdit } from './util.ts'
import type { Regression } from './verify.ts'
import type { TemplateExpression } from './vue-template.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Adapter SDK entry. @ripast/<framework> packages import from here.
export { isInsideAutoImportScope } from './nuxt.ts'
export { scan } from './scan.ts'
export type { ScanHit, ScanOptions } from './scan.ts'

export type ScanFn = typeof import('./scan.ts').scan
export { offsetOfPosition } from './ts-server.ts'
export { applyTextEdits, parseFile, parseSourceFile, posToLineCol, rgFiles, rgFilesMany } from './util.ts'
export type { TextEdit } from './util.ts'
export type { FileChange } from './util.ts'
export type { Regression } from './verify.ts'
export { extractTemplateExpressions, hyphenateVueName, parseVueTemplateAst, rewriteTemplateReferences } from './vue-template.ts'
export type { TemplateExpression } from './vue-template.ts'

export type FrameworkName = 'vue' | 'nuxt' | 'svelte'

export interface RenameSite {
  filePath: string
  source: string
  pos: number
}

export interface AutoImportRenamePlan {
  changes: FileChange[]
  verificationChanges: FileChange[]
  transformEdits: (path: string, source: string, edits: TextEdit[]) => TextEdit[]
}

export interface AddExplicitImportsContext {
  cwd: string
  symbols: string[]
  fromAbs: string
  toAbs: string
  existingChanges: FileChange[]
  noScriptError: (symbol: string) => Error
}

export interface FrameworkAdapter {
  name: string
  capabilities?: {
    nuxt?: boolean
  }

  hasFilesContaining: (cwd: string, pattern: string) => boolean

  applyRename: (
    tsconfigPath: string,
    cwd: string,
    from: string,
    to: string,
    sites: RenameSite[],
    autoImportPlan?: AutoImportRenamePlan,
  ) => Promise<FileChange[]>

  applyImportRewrite: (
    tsconfigPath: string,
    cwd: string,
    fromAbs: string,
    toAbs: string,
  ) => Promise<FileChange[]>

  applyFileRenameEdits: (
    tsconfigPath: string,
    cwd: string,
    oldAbs: string,
    newAbs: string,
  ) => Promise<FileChange[]>

  regressions: (
    tsconfigPath: string,
    cwd: string,
    changes: FileChange[],
  ) => Promise<Regression[]>

  extractTemplateExpressions?: (source: string) => TemplateExpression[]

  autoImportScopes?: (cwd: string) => Set<string>

  planAutoImportRename?: (ctx: { cwd: string, from: string, to: string, sites: RenameSite[] }) => AutoImportRenamePlan

  /** Return source consumers whose implicit binding may refer to this export. */
  inspectAutoImportConsumers?: (ctx: {
    cwd: string
    symbol: string
    fromAbs: string
    files: string[]
    scopes: Set<string>
  }) => string[]

  /** Refuse a rename whose planned consumers still need the old implicit binding. */
  validateAutoImportRename?: (ctx: {
    cwd: string
    symbol: string
    fromAbs: string
    changes: FileChange[]
    scopes: Set<string>
  }) => void

  /** Whether `filePath` is a framework-generated file (e.g. Nuxt's `.nuxt/`). */
  isGeneratedPath?: (cwd: string, filePath: string) => boolean

  /** Drop changes targeting framework-generated paths. Mutates `changes` in place. */
  filterGeneratedChanges?: (cwd: string, changes: FileChange[]) => void

  /**
   * After a move/rename that takes a symbol or file out of an auto-import scope,
   * scan consumers and add explicit named imports from `toAbs`. Returns only
   * net-new file changes; caller merges into the change set.
   */
  addExplicitImports?: (ctx: AddExplicitImportsContext) => FileChange[]

  /**
   * Hook called after a file rename has produced its baseline consumer edits.
   * Returns additional framework-specific edits and human-readable warnings
   * (e.g. resolveComponent() string references, out-of-auto-import-scope explicit imports).
   */
  finalizeFileRename?: (
    cwd: string,
    oldAbs: string,
    newAbs: string,
    existingChanges: FileChange[],
  ) => Promise<{ changes: FileChange[], warnings: string[] }>

  listComponents?: (cwd: string, opts?: { glob?: string[], source?: 'auto' | 'manifest' | 'filesystem', warn?: (msg: string) => void }) => ComponentInfo[]
  findComponentUsages?: (names: string[], opts?: { cwd?: string, glob?: string | string[] }) => ComponentUsageInfo[]

  /**
   * Doctor augmentation. Lets the framework adapter:
   *  - declare additional entry files (exempt from orphan-file)
   *  - reject false-positive findings (e.g. Nuxt server route default exports)
   *  - emit framework-specific findings
   */
  doctor?: DoctorAdapter
}

export interface DoctorFinding {
  check: string
  file: string
  message: string
  /** 1-based line, if the finding has a positional source (import/export/decl). */
  line?: number
  detail?: Record<string, unknown>
}

export interface DoctorContext {
  /** Each file's imports/exports/re-exports. Cheap shared parse from core. */
  index: DoctorContextIndex
}

export interface DoctorContextIndex {
  files: DoctorContextFile[]
}

export interface DoctorContextFile {
  file: string
  imports: { imported: string, local: string, source: string, typeOnly: boolean, line: number }[]
  namedReexports: { imported: string, exported: string, source: string, typeOnly: boolean, line: number }[]
  exportedNames: Set<string>
}

export interface DoctorAdapter {
  /** Files the framework treats as entries (won't be flagged as orphans). Paths relative to cwd. */
  entryFiles?: (cwd: string) => string[]
  /** Return true to drop a finding (false-positive filter). */
  filterFinding?: (cwd: string, finding: DoctorFinding) => boolean
  /** Framework-specific checks. Receives a shared parse context to avoid re-reading files. */
  extraFindings?: (cwd: string, ctx?: DoctorContext) => DoctorFinding[]
}

export interface ComponentInfo {
  id: string
  name: string
  registeredName: string | null
  aliases: string[]
  file: string
  rel: string
  kind: 'sfc' | 'define-component'
  layer?: string
  scope: 'auto-import' | 'global' | 'explicit'
  shadowed: boolean
  shadowedBy?: string
  source: 'manifest' | 'filesystem'
}

export interface ComponentUsageInfo {
  name: string
  file: string
  rel: string
  line: number
  col: number
  form: 'tag-pascal' | 'tag-kebab' | 'resolveComponent' | 'dynamic-is-literal' | 'dynamic-is-binding'
  binding?: string
}

const cache = new Map<FrameworkName, FrameworkAdapter | null>()

export async function loadAdapter(name: FrameworkName): Promise<FrameworkAdapter | null> {
  if (cache.has(name))
    return cache.get(name) ?? null

  const tryImport = async (spec: string): Promise<FrameworkAdapter | null> => {
    try {
      const mod = await import(spec)
      return (mod.default ?? mod) as FrameworkAdapter
    }
    catch { return null }
  }

  const adapterName = name === 'nuxt' ? 'vue' : name
  const external = await tryImport(`@ripast/${adapterName}`)
  const bundledVue = new URL('../../vue/src/index.ts', import.meta.url).href
  const resolved = external ?? (adapterName === 'vue' ? await tryImport(bundledVue) : null)
  const adapter = name === 'nuxt' && resolved
    ? { ...resolved, capabilities: { ...resolved.capabilities, nuxt: true } }
    : resolved

  cache.set(name, adapter)
  return adapter
}

export function detectFrameworks(cwd: string): FrameworkName[] {
  const out: FrameworkName[] = []
  const seen = new Set<string>()
  let dir = cwd
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
        for (const [name, marker] of [
          ['nuxt', ['nuxt', '@nuxt/kit']] as const,
          ['vue', ['vue']] as const,
          ['svelte', ['svelte', '@sveltejs/kit']] as const,
        ]) {
          if (seen.has(name))
            continue
          if (marker.some(m => allDeps[m])) {
            out.push(name as FrameworkName)
            seen.add(name)
          }
        }
      }
      catch {}
    }
    const parent = join(dir, '..')
    if (parent === dir)
      break
    dir = parent
  }
  return out
}

export function resetAdapterCache(): void {
  cache.clear()
}
