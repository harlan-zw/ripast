import type { FileChange, TextEdit } from './util.ts'
import type { DiagnosticRecorder } from './verification.ts'
import type { Regression } from './verify.ts'

export { cssSyntax, encodeAttributeValue, mapIncludesAny, rewriteCss, rewriteStringsInProgram, visitCss, visitProgramClassStrings } from './css-class-source.ts'
export type { CssClassSourceFile } from './css-class-source.ts'

export { completeClassBounds, rewriteClassString, visitClassTokens } from './css-class-token.ts'
export type { RenameMap } from './css-class-token.ts'

export type ScanFn = typeof import('./scan.ts').scan
export { diagnosticRegressions } from './diagnostic-matching.ts'
// Adapter SDK entry. ripide-<framework> packages import from here.
export { scan } from './scan.ts'
export type { ScanHit, ScanOptions } from './scan.ts'
export { offsetOfPosition } from './ts-server.ts'
export { applyTextEdits, parseFile, parseSourceFile, posToLineCol, rgFiles, rgFilesMany } from './util.ts'

export type FrameworkName = string

export interface SourceExpression { code: string, offsetInSource: number }

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
    onChecked?: DiagnosticRecorder,
  ) => Promise<Regression[]>

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
    to: string
    fromAbs: string
    changes: FileChange[]
    scopes: Set<string>
  }) => void

  /** Whether filePath is generated source. */
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
  /** Names of the framework checks registered by this adapter. */
  checks: readonly string[]
  /** Files the framework treats as entries (won't be flagged as orphans). Paths relative to cwd. */
  entryFiles?: (cwd: string) => string[]
  /** Return true to drop a finding (false-positive filter). */
  filterFinding?: (cwd: string, finding: DoctorFinding) => boolean
  /** Framework-specific checks. Receives a shared parse context to avoid re-reading files. */
  extraFindings?: (cwd: string, ctx: DoctorContext | undefined, checks: ReadonlySet<string>) => DoctorFinding[]
}

export interface ComponentInfo {
  id: string
  name: string
  registeredName: string | null
  aliases: string[]
  file: string
  rel: string
  kind: string
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
  form: string
  binding?: string
}

export type { TextEdit } from './util.ts'
export type { FileChange } from './util.ts'

export type { DiagnosticRecorder } from './verification.ts'
export type { Regression } from './verify.ts'
