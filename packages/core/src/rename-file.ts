import type { ExtensionOptions } from './adapter.ts'
import type { VerifyMode } from './project.ts'
import type { LspTextEdit, TsServer } from './ts-server.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, relative, resolve } from 'node:path'
import process from 'node:process'
import { composeAdapters } from './adapter.ts'
import { assertOperationSupport } from './capabilities.ts'
import { computeSpecifier } from './imports.ts'
import { findTsconfig, projectScriptFiles, resolveVerifyMode } from './project.ts'
import { applyLspEdits, offsetOfPosition, startTsServer } from './ts-server.ts'
import { mergeFileChanges } from './util.ts'
import { findExtensionRegressions, findRegressions } from './verify.ts'

export interface RenameFileOptions extends ExtensionOptions {
  cwd?: string
  /** Configured project used for import rewrites and verification. */
  tsconfig?: string
  verify?: boolean | VerifyMode
}
const TS_LIKE_RE = /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/
export interface RenameFileResult {
  changes: FileChange[]
  sourceBefore: string
  fileMove: {
    from: string
    to: string
  }
  /**
   * Updated content for the moved file itself (its own relative imports
   * rewritten for the new path). Apply this to `fileMove.to` after the rename.
   */
  selfChange: {
    before: string
    after: string
  } | null
  scanned: number
  regressions: Regression[]
  warnings: string[]
}
export async function runRenameFile(oldPath: string, newPath: string, opts: RenameFileOptions = {}): Promise<RenameFileResult> {
  const cwd = opts.cwd ?? process.cwd()
  assertOperationSupport('rename-file', cwd, opts.extensions)
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
  if (lstatSync(oldAbs).isSymbolicLink())
    throw new Error(`ripast rename-file: source "${oldPath}" is a symbolic link. Rename its target file instead.`)
    // Inspect the entry itself: existsSync follows symlinks and misses dangling targets.
  const target = lstatSync(newAbs, { throwIfNoEntry: false })
  const source = lstatSync(oldAbs)
  const caseOnlyRename = oldAbs !== newAbs
    && dirname(oldAbs) === dirname(newAbs)
    && basename(oldAbs).toLowerCase() === basename(newAbs).toLowerCase()
    && target?.isFile()
    && source.dev === target.dev && source.ino === target.ino
    && !readdirSync(dirname(newAbs)).includes(basename(newAbs))
  if (target && !caseOnlyRename)
    throw new Error(`ripast rename-file: target "${newPath}" already exists`)
  const tsconfigPath = opts.tsconfig ? resolve(cwd, opts.tsconfig) : findTsconfig(cwd)
  if (!tsconfigPath)
    throw new Error('ripast rename-file: no tsconfig.json found; required for cross-file import rewriting')
  const sourceBefore = readFileSync(oldAbs, 'utf8')
  const verifyMode = resolveVerifyMode(opts.verify)
  const adapter = composeAdapters(opts.extensions)
  const warnings: string[] = []
  const server = await startTsServer(cwd, { tsconfig: tsconfigPath })
  try {
    let consumerChanges: FileChange[]
    if (adapter) {
      consumerChanges = await tsOnlyFileRename(server, cwd, oldAbs, newAbs)
      mergeFileChanges(consumerChanges, await adapter.applyFileRenameEdits(tsconfigPath, cwd, oldAbs, newAbs))
      const templateChanges = adapter.templateRename?.(cwd, oldAbs, newAbs, consumerChanges) ?? []
      mergeFileChanges(consumerChanges, templateChanges)
      if (adapter.finalizeFileRename) {
        const finalize = await adapter.finalizeFileRename(cwd, oldAbs, newAbs, consumerChanges)
        mergeFileChanges(consumerChanges, finalize.changes)
        warnings.push(...finalize.warnings)
      }
    }
    else {
      consumerChanges = await tsOnlyFileRename(server!, cwd, oldAbs, newAbs)
    }
    const selfChangeRaw = consumerChanges.find(c => c.path === oldAbs || c.path === newAbs)
    const selfChange = selfChangeRaw && selfChangeRaw.after !== selfChangeRaw.before
      ? { before: selfChangeRaw.before, after: selfChangeRaw.after }
      : null
    const consumerNoSelf = consumerChanges.filter(c => c.path !== oldAbs && c.path !== newAbs && !/\.jsonc?$/.test(c.path)
      && !adapter?.isGeneratedPath?.(cwd, c.path))
    const regressions: Regression[] = []
    if (verifyMode !== 'none') {
      const extensionChanges = [...consumerNoSelf, {
        path: newAbs,
        rel: relative(cwd, newAbs),
        before: '',
        after: selfChange?.after ?? readFileSync(oldAbs, 'utf8'),
      }]
      if (verifyMode === 'project') {
        regressions.push(...await findExtensionRegressions(cwd, extensionChanges, tsconfigPath, opts.extensions))
      }
      else if (adapter && consumerNoSelf.some(c => opts.extensions?.some(extension => extension.suffixes.some(suffix => c.path.endsWith(suffix))))) {
        regressions.push(...await adapter.regressions(tsconfigPath, cwd, extensionChanges))
      }
      regressions.push(...await verifyFileRename(server!, cwd, oldAbs, newAbs, consumerNoSelf, selfChange, verifyMode, (consumer, specifier) => adapter?.isPlannedImportTarget?.(cwd, consumer, specifier, newAbs) ?? false))
    }
    return {
      changes: consumerNoSelf,
      sourceBefore,
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
    const after = applyLspEdits(before, fileEdits.map(edit => keepSpecifierStyle(before, edit, path, oldAbs, newAbs)))
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
function keepSpecifierStyle(text: string, edit: LspTextEdit, path: string, oldAbs: string, newAbs: string): LspTextEdit {
  const replaced = text.slice(offsetOfPosition(text, edit.range.start), offsetOfPosition(text, edit.range.end))
  const oldMatch = SPECIFIER_RE.exec(replaced)
  const newMatch = SPECIFIER_RE.exec(edit.newText)
  if (!oldMatch || !newMatch)
    return edit
  const oldTarget = resolve(dirname(path), oldMatch[2]).replace(MODULE_EXT_RE, '')
  if (oldTarget === oldAbs.replace(MODULE_EXT_RE, ''))
    return { ...edit, newText: `${newMatch[1]}${computeSpecifier(path === oldAbs ? newAbs : path, newAbs, oldMatch[2])}${newMatch[1]}` }
  const oldExt = MODULE_EXT_RE.exec(oldMatch[2])?.[0] ?? ''
  const stripped = newMatch[2].replace(MODULE_EXT_RE, '')
  return { ...edit, newText: `${newMatch[1]}${stripped}${oldExt}${newMatch[1]}` }
}
async function verifyFileRename(server: TsServer, cwd: string, oldAbs: string, newAbs: string, consumerChanges: FileChange[], selfChange: {
  before: string
  after: string
} | null, verifyMode: VerifyMode, isPlannedImportTarget: (consumer: string, specifier: string) => boolean): Promise<Regression[]> {
  const consumerTsChanges = consumerChanges.filter(c => TS_LIKE_RE.test(c.path))
  const moveIsTs = TS_LIKE_RE.test(oldAbs) && TS_LIKE_RE.test(newAbs)
  if (!moveIsTs && !consumerTsChanges.length)
    return []
  const changes: FileChange[] = [...consumerTsChanges]
  // willRenameFiles resolves the original imports through the configured project.
  // Keep its exact consumer replacements so aliases need no second resolver.
  const renamedSpecifiers = moveIsTs
    ? await server.willRenameFile(oldAbs, newAbs)
    : new Map<string, LspTextEdit[]>()
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
  return regressions.filter(r => r.file !== oldAbs
    && !isUnresolvedNewPath(r, newAbs)
    && !isUnresolvedRenamedSpecifier(r, newAbs, renamedSpecifiers)
    && !(r.code === CANNOT_FIND_MODULE_CODE && consumerTsChanges.some(change => change.path === r.file)
      && isPlannedImportTarget(r.file, MODULE_IN_MESSAGE_RE.exec(r.message)?.[1] ?? '')))
}
const CANNOT_FIND_MODULE_CODE = 2307
const MODULE_IN_MESSAGE_RE = /Cannot find module '([^']+)'/
function isUnresolvedRenamedSpecifier(regression: Regression, newAbs: string, edits: Map<string, LspTextEdit[]>): boolean {
  if (regression.code !== CANNOT_FIND_MODULE_CODE || regression.file === newAbs)
    return false
  const specifier = MODULE_IN_MESSAGE_RE.exec(regression.message)?.[1]
  if (!specifier)
    return false
  return edits.get(regression.file)?.some(edit => edit.newText.replace(/^(['"])(.*)\1$/, '$2') === specifier) ?? false
}
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
