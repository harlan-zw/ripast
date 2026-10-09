import type { Hookable } from 'hookable'
import type { FileChange, ParsedFile, TextEdit } from './util.ts'
import type { Regression } from './verify.ts'

export { cssSyntax, encodeAttributeValue, mapIncludesAny, rewriteCss, rewriteScriptWithin, rewriteStringsInProgram, visitCss, visitProgramClassStrings } from './css-class-source.ts'
export type { CssClassSourceFile } from './css-class-source.ts'
export type ScanFn = typeof import('./scan.ts').scan
export { visitClassTokens } from './css-class-token.ts'
export { rewriteClassString } from './css-class-token.ts'
export type { RenameMap } from './css-class-token.ts'
export { scan } from './scan.ts'
export type { ScanHit, ScanOptions } from './scan.ts'
export type FrameworkName = string
export interface TemplateExpression {
  code: string
  offsetInSource: number
}
export interface RenameSite {
  filePath: string
  source: string
  pos: number
}
export interface AutoImportRenamePlan {
  changes: FileChange[]
  verificationChanges: FileChange[]
  /** Consumers whose generated barrel uses a different provider for this name. */
  unrelatedGeneratedImports?: Set<string>
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
  suffixes: readonly string[]
  parse?: (path: string, source: string) => Omit<ParsedFile, 'path' | 'rel' | 'fullSource'>
  configFiles?: (cwd: string) => string[]
  semanticService?: string
  operations?: readonly OperationName[]
  verifyPlan?: (context: OperationContext) => void | Promise<void>
  setup?: (hooks: Hookable<EngineHooks>) => void
  inspectionSource?: (path: string, source: string) => {
    source: string
    extension: 'ts' | 'tsx'
  }
  templateRename?: (cwd: string, oldAbs: string, newAbs: string, changes: FileChange[]) => FileChange[]
  classSource?: {
    visit: (file: {
      abs: string
      rel: string
      source: string
      cwd: string
    }, visit: (bare: string) => void) => void
    rewrite: (file: {
      abs: string
      rel: string
      source: string
      cwd: string
    }, map: ReadonlyMap<string, string>) => string
  }
  hasFilesContaining?: (cwd: string, pattern: string) => boolean
  applyRename?: (tsconfigPath: string, cwd: string, from: string, to: string, sites: RenameSite[], autoImportPlan?: AutoImportRenamePlan) => Promise<FileChange[]>
  applyImportRewrite?: (tsconfigPath: string, cwd: string, fromAbs: string, toAbs: string) => Promise<FileChange[]>
  applyFileRenameEdits?: (tsconfigPath: string, cwd: string, oldAbs: string, newAbs: string) => Promise<FileChange[]>
  regressions?: (tsconfigPath: string, cwd: string, changes: FileChange[]) => Promise<Regression[]>
  extractTemplateExpressions?: (source: string) => TemplateExpression[]
  autoImportScopes?: (cwd: string) => Set<string>
  planAutoImportRename?: (ctx: {
    cwd: string
    from: string
    to: string
    sites: RenameSite[]
  }) => AutoImportRenamePlan
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
    to: string
    fromAbs: string
    changes: FileChange[]
    scopes: Set<string>
  }) => void
  /** Whether `filePath` is a framework-generated file . */
  isGeneratedPath?: (cwd: string, filePath: string) => boolean
  /** Drop changes targeting framework-generated paths. Mutates `changes` in place. */
  filterGeneratedChanges?: (cwd: string, changes: FileChange[]) => void
  /** Prove an unresolved consumer specifier points at the planned destination. */
  isPlannedImportTarget?: (cwd: string, consumer: string, specifier: string, target: string) => boolean
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
  finalizeFileRename?: (cwd: string, oldAbs: string, newAbs: string, existingChanges: FileChange[]) => Promise<{
    changes: FileChange[]
    warnings: string[]
  }>
  listComponents?: (cwd: string, opts?: {
    glob?: string[]
    source?: 'auto' | 'manifest' | 'filesystem'
    warn?: (msg: string) => void
  }) => ComponentInfo[]
  findComponentUsages?: (names: string[], opts?: {
    cwd?: string
    glob?: string | string[]
  }) => ComponentUsageInfo[]
  /**
   * Doctor augmentation. Lets the framework adapter:
   *  - declare additional entry files (exempt from orphan-file)
   *  - reject false-positive findings (e.g. framework entry exports)
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
  imports: {
    imported: string
    local: string
    source: string
    typeOnly: boolean
    line: number
  }[]
  namedReexports: {
    imported: string
    exported: string
    source: string
    typeOnly: boolean
    line: number
  }[]
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
export type OperationName = 'rename' | 'move' | 'delete' | 'rename-file' | 'replace'
export interface OperationContext {
  operation: OperationName
  args: readonly string[]
  cwd: string
  changes: FileChange[]
  regressions: Regression[]
}
export interface EngineHooks {
  'operation:plan': (context: OperationContext) => void | Promise<void>
  'operation:verify': (context: OperationContext) => void | Promise<void>
}
export interface ExtensionOptions {
  extensions?: readonly FrameworkAdapter[]
}
/** Compose instance-owned services. Conflicting file plans fail closed. */
export function composeAdapters(extensions: readonly FrameworkAdapter[] = []): (FrameworkAdapter & Required<Pick<FrameworkAdapter, 'hasFilesContaining' | 'applyRename' | 'applyImportRewrite' | 'applyFileRenameEdits' | 'regressions'>>) | null {
  if (!extensions.length)
    return null
  const merge = (target: FileChange[], incoming: FileChange[]) => {
    for (const change of incoming) {
      const existing = target.find(item => item.path === change.path)
      if (existing && (existing.before !== change.before || existing.after !== change.after))
        throw new Error(`Conflicting extension plans for ${change.path}`)
      if (!existing)
        target.push(change)
    }
  }
  const combined: FrameworkAdapter = { name: 'extensions', suffixes: extensions.flatMap(extension => [...extension.suffixes]) }
  combined.hasFilesContaining = (cwd, pattern) => extensions.some(extension => extension.hasFilesContaining?.(cwd, pattern))
  combined.applyRename = async (...args) => {
    const changes: FileChange[] = []
    for (const extension of extensions) {
      if (extension.applyRename)
        merge(changes, await extension.applyRename(...args))
    }
    return changes
  }
  combined.applyImportRewrite = async (...args) => {
    const changes: FileChange[] = []
    for (const extension of extensions) {
      if (extension.applyImportRewrite)
        merge(changes, await extension.applyImportRewrite(...args))
    }
    return changes
  }
  combined.applyFileRenameEdits = async (...args) => {
    const changes: FileChange[] = []
    for (const extension of extensions) {
      if (extension.applyFileRenameEdits)
        merge(changes, await extension.applyFileRenameEdits(...args))
    }
    return changes
  }
  combined.regressions = async (...args) => {
    const regressions: Regression[] = []
    for (const extension of extensions) {
      if (extension.regressions)
        regressions.push(...await extension.regressions(...args))
    }
    return regressions
  }
  combined.autoImportScopes = cwd => new Set(extensions.flatMap(extension => [...extension.autoImportScopes?.(cwd) ?? []]))
  combined.isGeneratedPath = (cwd, path) => extensions.some(extension => extension.isGeneratedPath?.(cwd, path))
  combined.filterGeneratedChanges = (cwd, changes) => {
    for (const extension of extensions)
      extension.filterGeneratedChanges?.(cwd, changes)
  }
  combined.inspectAutoImportConsumers = context => extensions.flatMap(extension => extension.inspectAutoImportConsumers?.(context) ?? [])
  combined.validateAutoImportRename = (context) => {
    for (const extension of extensions)
      extension.validateAutoImportRename?.(context)
  }
  combined.planAutoImportRename = (context) => {
    const plans = extensions.flatMap((extension) => {
      const plan = extension.planAutoImportRename?.(context)
      return plan ? [plan] : []
    })
    const changes: FileChange[] = []
    const verificationChanges: FileChange[] = []
    for (const plan of plans) {
      merge(changes, plan.changes)
      merge(verificationChanges, plan.verificationChanges)
    }
    return { changes, verificationChanges, unrelatedGeneratedImports: new Set(plans.flatMap(plan => [...plan.unrelatedGeneratedImports ?? []])), transformEdits: (path, source, edits) => plans.reduce((current, plan) => plan.transformEdits(path, source, current), edits) }
  }
  combined.addExplicitImports = (context) => {
    const changes: FileChange[] = []
    for (const extension of extensions)
      merge(changes, extension.addExplicitImports?.(context) ?? [])
    return changes
  }
  combined.isPlannedImportTarget = (...args) => extensions.some(extension => extension.isPlannedImportTarget?.(...args))
  combined.finalizeFileRename = async (...args) => {
    const changes: FileChange[] = []
    const warnings: string[] = []
    for (const extension of extensions) {
      const result = await extension.finalizeFileRename?.(...args)
      if (result) {
        merge(changes, result.changes)
        warnings.push(...result.warnings)
      }
    }
    return { changes, warnings }
  }
  combined.templateRename = (...args) => {
    const changes: FileChange[] = []
    for (const extension of extensions)
      merge(changes, extension.templateRename?.(...args) ?? [])
    return changes
  }
  return combined as FrameworkAdapter & Required<Pick<FrameworkAdapter, 'hasFilesContaining' | 'applyRename' | 'applyImportRewrite' | 'applyFileRenameEdits' | 'regressions'>>
}
// Adapter SDK entry. @ripast/<framework> packages import from here.
export { isInsideAutoImportScope } from './source-policy.ts'
export { offsetOfPosition } from './ts-server.ts'
export { applyTextEdits, parseFile, parseSourceFile, posToLineCol, rgFiles, rgFilesMany } from './util.ts'
export type { TextEdit } from './util.ts'
export type { FileChange } from './util.ts'
export type { Regression } from './verify.ts'
