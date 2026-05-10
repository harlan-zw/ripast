import type { FileChange } from '../util.ts'
import type { Regression } from '../verify.ts'

export interface RenameSite {
  filePath: string
  source: string
  pos: number
}

export interface TemplateExpression {
  code: string
  offsetInSource: number
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
}
