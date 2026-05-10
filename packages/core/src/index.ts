export { rewriteClassString, rewriteToken, runCssClassRename } from './css-class-rename.ts'
export type { CssClassRenameOptions, CssClassRenameResult, RenameMap } from './css-class-rename.ts'
export { formatAgentScanHits, formatScanHits, runCssClassScan } from './css-class-scan.ts'
export { runMove } from './move.ts'
export type { MoveOptions, MoveResult } from './move.ts'
export type { ProfileEvent, ProfileSink } from './profile.ts'
export { resolveVerifyMode } from './project.ts'
export type { VerifyMode } from './project.ts'
export { runRenameFile } from './rename-file.ts'
export type { RenameFileOptions, RenameFileResult } from './rename-file.ts'
export { runRename } from './rename.ts'
export type { RenameOptions, RenameResult } from './rename.ts'
export {
  buildDeclarationTree,
  buildScanGraph,
  formatAgentDeclarationTree,
  formatAgentHits,
  formatDeclarationTree,
  formatHits,
  formatScanGraph,
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
} from './scan.ts'
export { printDiffs, summarize, writeChanges } from './util.ts'
export type { FileChange } from './util.ts'
export { findRegressions, formatRegressions, snapshotDiagnostics } from './verify.ts'
export type { DiagnosticSnapshot, Regression } from './verify.ts'
