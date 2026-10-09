import type { EngineServices } from './engine.ts'
import type { ProfileSink } from './profile.ts'
import type { VerifyMode } from './project.ts'
import type { LspTextEdit, TsServer } from './ts-server.ts'
import type { FileChange } from './util.ts'
import type { Verification } from './verification.ts'
import type { Regression } from './verify.ts'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { dirname, extname, relative, resolve } from 'node:path'
import process from 'node:process'
import { computeSpecifier } from './imports.ts'
import { timed, timedAsync } from './profile.ts'
import { assertSourceSupport, findTsconfig, projectScriptFiles, resolveVerifyMode } from './project.ts'
import { applyLspEdits, offsetOfPosition, startTsServer } from './ts-server.ts'
import { isCaseOnlyFileRename, mergeFileChanges } from './util.ts'
import { createVerification } from './verification.ts'
import { findExtensionRegressions, findRegressions } from './verify.ts'

export interface RenameFileOptions {
  engine?: EngineServices
  profile?: ProfileSink
  cwd?: string
  /** Configured project used for import rewrites and verification. */
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
  verification: Verification
  warnings: string[]
}

export async function runRenameFile(oldPath: string, newPath: string, opts: RenameFileOptions = {}): Promise<RenameFileResult> {
  const cwd = opts.cwd ?? process.cwd()
  const engine = opts.engine
  assertSourceSupport(cwd, engine)
  engine?.assertOperation({ operation: 'renameFile', from: oldPath, to: newPath }, cwd)
  const profile = opts.profile
  const oldAbs = resolve(cwd, oldPath)
  const inferredNewPath = extname(newPath) ? newPath : `${newPath}${extname(oldPath)}`
  const newAbs = resolve(cwd, inferredNewPath)

  if (!existsSync(oldAbs)) {
    const looksSmushed = /\s/.test(oldPath)
    const hint = looksSmushed
      ? ` (path contains whitespace; if you meant two arguments, quote each path separately: rename-file "<old>" "<new>")`
      : ''
    throw new Error(`ripide rename-file: source "${oldPath}" does not exist${hint}`)
  }
  if (lstatSync(oldAbs).isSymbolicLink())
    throw new Error(`ripide rename-file: source "${oldPath}" is a symbolic link. Rename its target file instead.`)
  // Inspect the entry itself: existsSync follows symlinks and misses dangling targets.
  const target = lstatSync(newAbs, { throwIfNoEntry: false })
  if (target && !isCaseOnlyFileRename(oldAbs, newAbs))
    throw new Error(`ripide rename-file: target "${newPath}" already exists`)

  const tsconfigPath = timed(profile, 'find tsconfig', () => opts.tsconfig ? resolve(cwd, opts.tsconfig) : findTsconfig(cwd))
  if (!tsconfigPath)
    throw new Error('ripide rename-file: no tsconfig.json found; required for cross-file import rewriting')

  const verifyMode = resolveVerifyMode(opts.verify)
  const adapter = engine?.adapter ?? null
  const warnings: string[] = []
  const server = !adapter || verifyMode !== 'none' ? await timedAsync(profile, 'server start', () => startTsServer(cwd, { tsconfig: tsconfigPath })) : null
  try {
    let consumerChanges: FileChange[]
    if (adapter) {
      consumerChanges = await timedAsync(profile, 'file rename transform', () => adapter.applyFileRenameEdits(tsconfigPath, cwd, oldAbs, newAbs))
      if (adapter.finalizeFileRename) {
        const finalize = await adapter.finalizeFileRename(cwd, oldAbs, newAbs, consumerChanges)
        mergeFileChanges(consumerChanges, finalize.changes)
        warnings.push(...finalize.warnings)
      }
    }
    else {
      consumerChanges = await timedAsync(profile, 'file rename transform', () => tsOnlyFileRename(server!, cwd, oldAbs, newAbs))
    }

    const selfChangeRaw = consumerChanges.find(c => c.path === oldAbs || c.path === newAbs)
    const selfChange = selfChangeRaw && selfChangeRaw.after !== selfChangeRaw.before
      ? { before: selfChangeRaw.before, after: selfChangeRaw.after }
      : null
    const consumerNoSelf = consumerChanges.filter(c => c.path !== oldAbs && c.path !== newAbs
      && !adapter?.isGeneratedPath?.(cwd, c.path))

    const verification = createVerification(verifyMode, true)
    const regressions: Regression[] = []
    if (verifyMode !== 'none') {
      const extensionChanges = [...consumerNoSelf, {
        path: newAbs,
        rel: relative(cwd, newAbs),
        before: '',
        after: selfChange?.after ?? readFileSync(oldAbs, 'utf8'),
      }]
      if (verifyMode === 'project') {
        regressions.push(...await timedAsync(profile, 'extension verify', () => findExtensionRegressions(cwd, extensionChanges, tsconfigPath, engine, verification.extension)))
      }
      else if (adapter && consumerNoSelf.some(c => engine?.owns(c.path))) {
        regressions.push(...await timedAsync(profile, 'extension verify', () => adapter.regressions(tsconfigPath, cwd, extensionChanges, verification.extension(adapter.name))))
      }
      regressions.push(...await timedAsync(profile, 'verify', () => verifyFileRename(server!, cwd, oldAbs, newAbs, consumerNoSelf, selfChange, verifyMode, (consumer, specifier) => adapter?.isPlannedImportTarget?.(cwd, consumer, specifier, newAbs) ?? false, verification)))
    }

    return {
      changes: consumerNoSelf,
      fileMove: { from: oldAbs, to: newAbs },
      selfChange,
      scanned: consumerNoSelf.length + 1,
      regressions,
      verification: verification.result(),
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
// wrote `./aa.js` for an import that read `./a.ts`). ripide keeps the style
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

export async function verifyFileRename(
  server: TsServer,
  cwd: string,
  oldAbs: string,
  newAbs: string,
  consumerChanges: FileChange[],
  selfChange: { before: string, after: string } | null,
  verifyMode: VerifyMode,
  isPlannedImportTarget: (consumer: string, specifier: string) => boolean,
  verification: ReturnType<typeof createVerification>,
): Promise<Regression[]> {
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
  const regressions = await findRegressions(server, changes, files, verification.typescript)
  const kept = regressions.filter(r => r.file !== oldAbs
    && !isUnresolvedNewPath(r, newAbs)
    && !isUnresolvedRenamedSpecifier(r, newAbs, renamedSpecifiers)
    && !(r.code === CANNOT_FIND_MODULE_CODE && consumerTsChanges.some(change => change.path === r.file)
      && isPlannedImportTarget(r.file, MODULE_IN_MESSAGE_RE.exec(r.message)?.[1] ?? '')))
  verification.ignore('typescript', regressions.length - kept.length)
  return kept
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
