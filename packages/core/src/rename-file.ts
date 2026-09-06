import type { VerifyMode } from './project.ts'
import type { LspTextEdit, TsServer } from './ts-server.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, relative, resolve } from 'node:path'
import process from 'node:process'
import { loadAdapter } from './adapter.ts'
import { findTsconfig, projectScriptFiles, resolveVerifyMode } from './project.ts'
import { applyLspEdits, offsetOfPosition, startTsServer } from './ts-server.ts'
import { mergeFileChanges, rgFiles } from './util.ts'
import { findRegressions } from './verify.ts'
import { hyphenateVueName, rewriteTemplateReferences } from './vue-template.ts'

export interface RenameFileOptions {
  cwd?: string
  /** tsconfig for the Vue adapter. The TypeScript server discovers its own project from the workspace. */
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

  const verifyMode = resolveVerifyMode(opts.verify)
  const vueAdapter = await loadAdapter('vue')
  const warnings: string[] = []
  const server = !vueAdapter || verifyMode !== 'none' ? await startTsServer(cwd) : null
  try {
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
      // installed). A pure-TS file rename does not need it: the TypeScript
      // server rewrites every importing file on its own.
      if (oldAbs.endsWith('.vue') || newAbs.endsWith('.vue'))
        throw new Error('ripast rename-file: renaming .vue files requires the Vue adapter (install @ripast/vue)')
      consumerChanges = await tsOnlyFileRename(server!, cwd, oldAbs, newAbs)
      const vueConsumers = rgFiles(basename(oldAbs, extname(oldAbs)), { cwd, glob: '*.vue' })
      if (vueConsumers.length)
        warnings.push(`${vueConsumers.length} .vue file(s) reference this name and were not checked; install @ripast/vue to rewrite .vue import sites`)
    }

    const selfChangeRaw = consumerChanges.find(c => c.path === oldAbs || c.path === newAbs)
    const selfChange = selfChangeRaw && selfChangeRaw.after !== selfChangeRaw.before
      ? { before: selfChangeRaw.before, after: selfChangeRaw.after }
      : null
    const consumerNoSelf = consumerChanges.filter(c => c.path !== oldAbs && c.path !== newAbs && !vueAdapter?.isGeneratedPath?.(cwd, c.path))

    const regressions: Regression[] = []
    if (verifyMode !== 'none') {
      if (vueAdapter && consumerNoSelf.some(c => c.path.endsWith('.vue')))
        regressions.push(...await vueAdapter.regressions(tsconfigPath, cwd, consumerNoSelf))
      regressions.push(...await verifyFileRename(server!, cwd, oldAbs, newAbs, consumerNoSelf, selfChange, verifyMode))
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
  finally {
    server?.dispose()
  }
}

// Pure-TS file rename used when no framework adapter is loaded. The server's
// willRenameFiles rewrites every importing file's module specifier and the
// moved file's own relative imports. The moved file's change is returned under
// its new path so the caller's self-change detection still works.
async function tsOnlyFileRename(server: TsServer, cwd: string, oldAbs: string, newAbs: string): Promise<FileChange[]> {
  const edits = await server.willRenameFile(oldAbs, newAbs)
  const out: FileChange[] = []
  for (const [path, fileEdits] of edits) {
    const before = server.textOf(path)
    const after = applyLspEdits(before, fileEdits.map(edit => keepSpecifierStyle(before, edit)))
    if (after === before)
      continue
    const outPath = path === oldAbs ? newAbs : path
    out.push({ path: outPath, rel: relative(cwd, outPath), before, after })
  }
  return out
}

const SPECIFIER_RE = /^(['"]?)(\.{1,2}\/.*?)\1$/
const MODULE_EXT_RE = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/

// The server picks module specifier endings from its own preferences (it
// wrote `./aa.js` for an import that read `./a.ts`). ripast keeps the style
// the file already used: same extension, or none. The server edits the string
// contents, sometimes with the quotes and sometimes without.
function keepSpecifierStyle(text: string, edit: LspTextEdit): LspTextEdit {
  const replaced = text.slice(offsetOfPosition(text, edit.range.start), offsetOfPosition(text, edit.range.end))
  const oldMatch = SPECIFIER_RE.exec(replaced)
  const newMatch = SPECIFIER_RE.exec(edit.newText)
  if (!oldMatch || !newMatch)
    return edit
  const oldExt = MODULE_EXT_RE.exec(oldMatch[2])?.[0] ?? ''
  const stripped = newMatch[2].replace(MODULE_EXT_RE, '')
  return { ...edit, newText: `${newMatch[1]}${stripped}${oldExt}${newMatch[1]}` }
}

async function verifyFileRename(
  server: TsServer,
  cwd: string,
  oldAbs: string,
  newAbs: string,
  consumerChanges: FileChange[],
  selfChange: { before: string, after: string } | null,
  verifyMode: VerifyMode,
): Promise<Regression[]> {
  const consumerTsChanges = consumerChanges.filter(c => TS_LIKE_RE.test(c.path))
  const moveIsTs = TS_LIKE_RE.test(oldAbs) && TS_LIKE_RE.test(newAbs)
  if (!moveIsTs && !consumerTsChanges.length)
    return []

  const changes: FileChange[] = [...consumerTsChanges]
  if (moveIsTs) {
    const oldText = readFileSync(oldAbs, 'utf8')
    // Model the move as two overlays: the old path empties out, the new path
    // appears with the post-move content. Nothing touches disk. The server
    // checks the new file's own content in memory, but module resolution
    // from consumers only sees disk, so their "cannot find module" for the
    // new path is expected and filtered below. Everything else stays.
    changes.push({ path: oldAbs, rel: relative(cwd, oldAbs), before: oldText, after: '' })
    changes.push({ path: newAbs, rel: relative(cwd, newAbs), before: '', after: selfChange?.after ?? oldText })
  }
  const files = verifyMode === 'project'
    ? projectScriptFiles(cwd)
    : [...(moveIsTs ? [newAbs] : []), ...consumerTsChanges.map(c => c.path)]
  const regressions = await findRegressions(server, changes, files)
  return regressions.filter(r => r.file !== oldAbs && !isUnresolvedNewPath(r, newAbs))
}

const CANNOT_FIND_MODULE_CODE = 2307
const MODULE_IN_MESSAGE_RE = /Cannot find module '([^']+)'/

function isUnresolvedNewPath(regression: Regression, newAbs: string): boolean {
  if (regression.code !== CANNOT_FIND_MODULE_CODE)
    return false
  const specifier = MODULE_IN_MESSAGE_RE.exec(regression.message)?.[1]
  if (!specifier || !specifier.startsWith('.'))
    return false
  const base = resolve(dirname(regression.file), specifier)
  const target = newAbs.replace(MODULE_EXT_RE, '')
  return base === newAbs || base === target || base.replace(MODULE_EXT_RE, '') === target
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
