import type { SourceFile } from 'ts-morph'
import type { VerifyMode } from './project.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, relative, resolve } from 'node:path'
import process from 'node:process'
import { Project } from 'ts-morph'
import { loadAdapter } from './adapter.ts'
import { findTsconfig, resolveVerifyMode } from './project.ts'
import { mergeFileChanges, rgFiles } from './util.ts'
import { findRegressions, snapshotDiagnostics } from './verify.ts'
import { hyphenateVueName, rewriteTemplateReferences } from './vue-template.ts'

export interface RenameFileOptions {
  cwd?: string
  tsconfig?: string
  verify?: boolean | VerifyMode
}

const TS_LIKE_RE = /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/

export interface RenameFileResult {
  changes: FileChange[]
  fileMove: { from: string, to: string }
  /**
   * Updated content for the moved file itself (its own relative imports
   * rewritten for the new path). Apply this to `fileMove.to` after the rename.
   */
  selfChange: { before: string, after: string } | null
  scanned: number
  regressions: Regression[]
  warnings: string[]
}

export async function runRenameFile(oldPath: string, newPath: string, opts: RenameFileOptions = {}): Promise<RenameFileResult> {
  const cwd = opts.cwd ?? process.cwd()
  const oldAbs = resolve(cwd, oldPath)
  const inferredNewPath = extname(newPath) ? newPath : `${newPath}${extname(oldPath)}`
  const newAbs = resolve(cwd, inferredNewPath)

  if (!existsSync(oldAbs)) {
    const looksSmushed = /\s/.test(oldPath)
    const hint = looksSmushed
      ? ` (path contains whitespace; if you meant two arguments, quote each path separately: rename-file "<old>" "<new>")`
      : ''
    throw new Error(`ripast rename-file: source "${oldPath}" does not exist${hint}`)
  }
  if (existsSync(newAbs))
    throw new Error(`ripast rename-file: target "${newPath}" already exists`)

  const tsconfigPath = opts.tsconfig ? resolve(cwd, opts.tsconfig) : findTsconfig(cwd)
  if (!tsconfigPath)
    throw new Error('ripast rename-file: no tsconfig.json found; required for cross-file import rewriting')

  const vueAdapter = await loadAdapter('vue')
  const warnings: string[] = []
  let consumerChanges: FileChange[]

  if (vueAdapter) {
    consumerChanges = await vueAdapter.applyFileRenameEdits(tsconfigPath, cwd, oldAbs, newAbs)
    const templateChanges = applyComponentTemplateRenameFallback(cwd, oldAbs, newAbs, consumerChanges)
    mergeFileChanges(consumerChanges, templateChanges)
    if (vueAdapter.finalizeFileRename) {
      const finalize = await vueAdapter.finalizeFileRename(cwd, oldAbs, newAbs, consumerChanges)
      mergeFileChanges(consumerChanges, finalize.changes)
      warnings.push(...finalize.warnings)
    }
  }
  else {
    // No Vue adapter available (e.g. `npx @ripast/cli` without @ripast/vue
    // installed). A pure-TS file rename does not need it: ts-morph rewrites
    // every importing TS file on its own.
    if (oldAbs.endsWith('.vue') || newAbs.endsWith('.vue'))
      throw new Error('ripast rename-file: renaming .vue files requires the Vue adapter (install @ripast/vue)')
    consumerChanges = tsOnlyFileRename(tsconfigPath, cwd, oldAbs, newAbs)
    const vueConsumers = rgFiles(basename(oldAbs, extname(oldAbs)), { cwd, glob: '*.vue' })
    if (vueConsumers.length)
      warnings.push(`${vueConsumers.length} .vue file(s) reference this name and were not checked; install @ripast/vue to rewrite .vue import sites`)
  }

  const selfChangeRaw = consumerChanges.find(c => c.path === oldAbs || c.path === newAbs)
  const selfChange = selfChangeRaw && selfChangeRaw.after !== selfChangeRaw.before
    ? { before: selfChangeRaw.before, after: selfChangeRaw.after }
    : null
  const consumerNoSelf = consumerChanges.filter(c => c.path !== oldAbs && c.path !== newAbs && !vueAdapter?.isGeneratedPath?.(cwd, c.path))

  const verifyMode = resolveVerifyMode(opts.verify)
  const regressions: Regression[] = []
  if (verifyMode !== 'none') {
    if (vueAdapter && consumerNoSelf.some(c => c.path.endsWith('.vue')))
      regressions.push(...await vueAdapter.regressions(tsconfigPath, cwd, consumerNoSelf))
    regressions.push(...tsVerifyRenameFile(tsconfigPath, oldAbs, newAbs, consumerNoSelf, selfChange, verifyMode))
  }

  return {
    changes: consumerNoSelf,
    fileMove: { from: oldAbs, to: newAbs },
    selfChange,
    scanned: consumerNoSelf.length + 1,
    regressions,
    warnings,
  }
}

// Pure-TS file rename used when no framework adapter is loaded. ts-morph's
// SourceFile.move rewrites the moved file's own relative imports and every
// importing file's module specifier. Returns the moved file's change too
// (path === newAbs) so the caller's self-change detection still works.
function tsOnlyFileRename(tsconfigPath: string, cwd: string, oldAbs: string, newAbs: string): FileChange[] {
  const project = new Project({ tsConfigFilePath: tsconfigPath })
  const oldSF = project.getSourceFile(oldAbs) ?? project.addSourceFileAtPath(oldAbs)
  const originals = new Map<string, string>()
  for (const sf of project.getSourceFiles())
    originals.set(sf.getFilePath(), sf.getFullText())
  oldSF.move(newAbs)
  const out: FileChange[] = []
  for (const sf of project.getSourceFiles()) {
    const path = sf.getFilePath()
    const before = originals.get(path === newAbs ? oldAbs : path)
    const after = sf.getFullText()
    if (before == null || before === after)
      continue
    out.push({ path, rel: relative(cwd, path), before, after })
  }
  return out
}

function tsVerifyRenameFile(
  tsconfigPath: string,
  oldAbs: string,
  newAbs: string,
  consumerChanges: FileChange[],
  selfChange: { before: string, after: string } | null,
  verifyMode: VerifyMode,
): Regression[] {
  const consumerTsChanges = consumerChanges.filter(c => TS_LIKE_RE.test(c.path))
  const moveIsTs = TS_LIKE_RE.test(oldAbs) && TS_LIKE_RE.test(newAbs)
  if (!moveIsTs && !consumerTsChanges.length)
    return []

  const project = new Project({ tsConfigFilePath: tsconfigPath })
  const oldSF = project.getSourceFile(oldAbs) ?? project.addSourceFileAtPathIfExists(oldAbs)

  const touched: SourceFile[] = []
  if (oldSF)
    touched.push(oldSF)
  for (const c of consumerTsChanges) {
    const sf = project.getSourceFile(c.path) ?? project.addSourceFileAtPathIfExists(c.path)
    if (sf)
      touched.push(sf)
  }

  const baselineFiles = verifyMode === 'project' ? project.getSourceFiles() : touched
  const baseline = snapshotDiagnostics(project, baselineFiles)

  for (const c of consumerTsChanges) {
    const sf = project.getSourceFile(c.path)
    if (sf)
      sf.replaceWithText(c.after)
  }

  let newSF: SourceFile | null = null
  if (moveIsTs) {
    const movedText = selfChange?.after ?? oldSF?.getFullText() ?? readFileSync(oldAbs, 'utf8')
    if (oldSF)
      oldSF.delete()
    newSF = project.createSourceFile(newAbs, movedText, { overwrite: true })
  }

  const postFiles = verifyMode === 'project'
    ? project.getSourceFiles()
    : [...(newSF ? [newSF] : []), ...consumerTsChanges.map(c => project.getSourceFile(c.path)).filter((sf): sf is SourceFile => !!sf)]

  return findRegressions(baseline, project, postFiles)
}

function applyComponentTemplateRenameFallback(cwd: string, oldAbs: string, newAbs: string, changes: FileChange[]): FileChange[] {
  if (!oldAbs.endsWith('.vue') || !newAbs.endsWith('.vue'))
    return []
  const oldName = basename(oldAbs, '.vue')
  const newName = basename(newAbs, '.vue')
  if (oldName === newName)
    return []
  const byPath = new Map(changes.map(change => [change.path, change]))
  const candidates = new Set([
    ...rgFiles(oldName, { cwd, glob: '*.vue' }),
    ...rgFiles(hyphenateVueName(oldName), { cwd, glob: '*.vue' }),
  ])
  const out: FileChange[] = []
  for (const path of candidates) {
    const before = byPath.get(path)?.before ?? readFileSync(path, 'utf8')
    const baseAfter = byPath.get(path)?.after ?? before
    const after = rewriteTemplateReferences(baseAfter, oldName, newName)
    if (after === baseAfter)
      continue
    out.push({
      path,
      rel: relative(cwd, path),
      before,
      after,
    })
  }
  return out
}
