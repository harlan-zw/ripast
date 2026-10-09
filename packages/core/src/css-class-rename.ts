import type { RenameMap } from './css-class-token.ts'
import type { FileChange } from './util.ts'
import type { Verification } from './verification.ts'
import process from 'node:process'
import { readCssClassSourceFilesForMap, rewriteCssClassTokensInFile } from './css-class-source.ts'

export interface CssClassRenameOptions {
  cwd?: string
  glob?: string | string[]
}

export interface CssClassRenameResult {
  changes: FileChange[]
  scanned: number
  verification: Verification
  regressions: never[]
}

export { rewriteClassString, rewriteToken } from './css-class-token.ts'
export type { RenameMap } from './css-class-token.ts'

export async function runCssClassRename(map: RenameMap, opts: CssClassRenameOptions = {}): Promise<CssClassRenameResult> {
  const cwd = opts.cwd ?? process.cwd()
  const changes: FileChange[] = []
  const files = readCssClassSourceFilesForMap(map, { cwd, glob: opts.glob })
  for (const file of files) {
    const after = rewriteCssClassTokensInFile(file, map)
    if (after !== file.source)
      changes.push({ path: file.abs, rel: file.rel, before: file.source, after })
  }
  return { changes, scanned: files.length, regressions: [], verification: { _tag: 'Skipped', reason: changes.length ? 'not-applicable' : 'no-changes' } }
}
