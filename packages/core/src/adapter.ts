// Adapter SDK entry. @ripast/<framework> packages import from here.
export type { FrameworkName } from './adapters/resolve.ts'
export { detectFrameworks, loadAdapter, resetAdapterCache } from './adapters/resolve.ts'
export type { FrameworkAdapter, RenameSite, TemplateExpression } from './adapters/types.ts'
export { posToLineCol, rgFiles } from './util.ts'
export type { FileChange } from './util.ts'
export type { Regression } from './verify.ts'
export { extractTemplateExpressions, rewriteTemplateReferences } from './vue-template.ts'
