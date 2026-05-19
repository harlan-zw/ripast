export { buildComponentDetail, buildComponentInventory, formatAgentInventory, formatDetail, formatInventory } from './components.ts'
export type { ComponentDetail, ComponentInventory, ComponentsListOptions, DuplicateGroup } from './components.ts'
export { rewriteClassString, rewriteToken, runCssClassRename } from './css-class-rename.ts'
export type { CssClassRenameOptions, CssClassRenameResult, RenameMap } from './css-class-rename.ts'
export { formatAgentFileScanHits, formatAgentScanHits, formatFileScanHits, formatScanHits, runCssClassFileScan, runCssClassScan } from './css-class-scan.ts'
export { runDelete } from './delete.ts'
export type { DeleteOptions, DeleteReference, DeleteResult } from './delete.ts'
export { buildDoctorFixes, formatAgentDoctorReport, formatDoctorReport, getChangedFiles, runDoctor } from './doctor.ts'
export type { ChangedFilesOptions, DoctorCheck, DoctorFinding, DoctorFixResult, DoctorOptions, DoctorReport, FixableCheck } from './doctor.ts'
export { runMove } from './move.ts'
export type { MoveOptions, MoveResult } from './move.ts'
export type { ProfileEvent, ProfileSink } from './profile.ts'
export { resolveVerifyMode } from './project.ts'
export type { VerifyMode } from './project.ts'
export { runRenameFile } from './rename-file.ts'
export type { RenameFileOptions, RenameFileResult } from './rename-file.ts'
export { runRename } from './rename.ts'
export type { RenameOptions, RenameResult } from './rename.ts'
export { runReplace } from './replace.ts'
export type { ReplaceOptions, ReplaceResult } from './replace.ts'
export {
  buildDeclarationTree,
  buildScanGraph,
  buildUnusedDeclarations,
  formatAgentDeclarationTree,
  formatAgentHits,
  formatDeclarationTree,
  formatHits,
  formatScanGraph,
  formatUnusedDeclarations,
  scan,
} from './scan.ts'
export type {
  DeclarationTree,
  DeclarationTreeFile,
  DeclarationTreeItem,
  ExportFilter,
  ScanGraph,
  ScanGraphEdge,
  ScanGraphNode,
  ScanHit,
  ScanOptions,
  UnusedDeclarationFile,
  UnusedDeclarations,
} from './scan.ts'
export { printDiffs, summarize, writeChanges } from './util.ts'
export type { FileChange } from './util.ts'
export { findRegressions, formatRegressions, snapshotDiagnostics } from './verify.ts'
export type { DiagnosticSnapshot, Regression } from './verify.ts'
export { runVueTemplateUnwrap, runVueTemplateWrap } from './vue-template-wrap.ts'
export type { VueTemplateWrapOptions, VueTemplateWrapResult } from './vue-template-wrap.ts'
