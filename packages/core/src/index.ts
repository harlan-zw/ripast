export { buildChangeManifest } from './change-manifest.ts'
export type { ChangeManifest, ChangeManifestEntry, FileMoveSnapshot } from './change-manifest.ts'
export { buildComponentDetail, buildComponentInventory } from './components.ts'
export type { ComponentDetail, ComponentInventory, ComponentsListOptions, DuplicateGroup } from './components.ts'
export { rewriteClassString, rewriteToken, runCssClassRename } from './css-class-rename.ts'
export type { CssClassRenameOptions, CssClassRenameResult, RenameMap } from './css-class-rename.ts'
export { runCssClassFileScan, runCssClassScan } from './css-class-scan.ts'
export type { CssClassFileScanHit, CssClassFileScanOptions, CssClassScanHit, CssClassScanOptions } from './css-class-scan.ts'
export { runDelete } from './delete.ts'
export type { DeleteOptions, DeleteReference, DeleteResult } from './delete.ts'
export { buildDoctorFixes, getChangedFiles, getDoctorCheckNames, runDoctor } from './doctor.ts'
export type { ChangedFilesOptions, DoctorCheck, DoctorFinding, DoctorFixResult, DoctorOptions, DoctorReport, FixableCheck } from './doctor.ts'
export { runMove } from './move.ts'

export type { MoveOptions, MoveResult } from './move.ts'
export type { ProfileEvent, ProfileSink } from './profile.ts'
export { resolveVerificationOptions, resolveVerifyMode } from './project.ts'
export type { VerifyMode } from './project.ts'
export { runRenameFile } from './rename-file.ts'
export type { RenameFileOptions, RenameFileResult } from './rename-file.ts'
export { runRename } from './rename.ts'
export type { RenameOptions, RenameResult } from './rename.ts'
export { runReplace } from './replace.ts'
export type { ReplaceOptions, ReplaceResult } from './replace.ts'
export { buildDeclarationTree, buildScanGraph, buildUnusedDeclarations, createDeclarationCache, scan } from './scan.ts'
export type {
  DeclarationCache,
  DeclarationCacheOptions,
  DeclarationCacheStats,
  DeclarationTree,
  DeclarationTreeFile,
  DeclarationTreeItem,
  DeclarationTreeOptions,
  ExportFilter,
  ScanGraph,
  ScanGraphEdge,
  ScanGraphNode,
  ScanHit,
  ScanOptions,
  UnusedDeclarationFile,
  UnusedDeclarations,
} from './scan.ts'
export { applyLspEdits, offsetOfPosition, resolveNativeTsc, startTsServer } from './ts-server.ts'
export type { LspDiagnostic, LspLocation, LspTextEdit, SourceSite, TsServer, TsServerOptions } from './ts-server.ts'
export { writeChanges } from './util.ts'

export type { FileChange } from './util.ts'

export type { DiagnosticCheck, Verification } from './verification.ts'
export { findRegressions } from './verify.ts'
export type { Regression } from './verify.ts'
export { runVueTemplateUnwrap, runVueTemplateWrap } from './vue-template-wrap.ts'

export type { VueTemplateWrapOptions, VueTemplateWrapResult } from './vue-template-wrap.ts'
