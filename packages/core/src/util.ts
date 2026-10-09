import type { EngineServices } from './engine.ts'
import type { RenameFileResult } from './rename-file.ts'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { createPatch } from 'diff'
import { parseSync } from 'oxc-parser'
import picomatch from 'picomatch'
import { searchFiles } from './file-search.ts'

export interface ParsedFile {
  path: string
  rel: string
  fullSource: string
  scriptSource: string
  scriptStart: number
  scriptEnd: number
  program: any | null
  isSfc: boolean
}

export interface FileChange {
  path: string
  rel: string
  before: string
  after: string
}

export interface TextEdit {
  start: number
  end: number
  replacement: string
}

export function mergeFileChanges(target: FileChange[], incoming: FileChange[]): void {
  for (const change of incoming) {
    const existing = target.find(c => c.path === change.path)
    if (existing)
      existing.after = change.after
    else
      target.push(change)
  }
}

export function applyTextEdits(source: string, edits: TextEdit[]): string {
  if (!edits.length)
    return source
  edits.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const edit of edits) {
    if (edit.start < cursor)
      continue
    out += source.slice(cursor, edit.start) + edit.replacement
    cursor = edit.end
  }
  out += source.slice(cursor)
  return out
}

const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

// Meta-project directories that aren't real source even when not in .gitignore.
// `.git` is already excluded by ripgrep's built-in rules; the rest are workflow
// caches that frequently leak into open-ended scans (claude worktrees, skilld
// snapshots, etc.).
const DEFAULT_EXCLUDES = ['!.claude/worktrees/**', '!**/.claude/worktrees/**']

function discoverySelection(userGlobs: string[]) {
  // Only a literal directory segment opts into dependencies. Broad source globs do not.
  const normalizedGlobs = userGlobs.map((glob) => {
    for (;;) {
      const normalized = glob.replace(/(?<!\\)\{([^{}]*)\}/g, (match, body: string) => body.includes(',') ? match : body)
      if (normalized === glob)
        return glob
      glob = normalized
    }
  })
  const dependencyGlobs = normalizedGlobs.filter(glob => glob.startsWith('!') || /(?:^|\/)node_modules(?:\/|$)/.test(glob))
  const explicitDependencies = dependencyGlobs.some(glob => !glob.startsWith('!'))
  const globs = [...userGlobs, ...DEFAULT_EXCLUDES, ...explicitDependencies ? [] : ['!node_modules/**', '!**/node_modules/**']]
  const rules = explicitDependencies
    ? dependencyGlobs.map((glob) => {
        const excluded = glob.startsWith('!')
        const pattern = excluded ? glob.slice(1) : glob
        return { excluded, matches: picomatch(pattern.replace(/^\//, ''), { dot: true, nonegate: true, noext: true, strictSlashes: true, basename: !pattern.includes('/') }) }
      })
    : []
  const select = (paths: string[], cwd: string) => paths.filter((path) => {
    const rel = relative(cwd, path).replace(/\\/g, '/')
    if (!rel.split('/').includes('node_modules'))
      return true
    let included = false
    for (const rule of rules) {
      if (rule.matches(rel))
        included = !rule.excluded
    }
    return included
  })
  return { globs, select }
}

function runRipgrep(args: string[], cwd: string, fallback: () => string[]): string[] {
  const result = spawnSync('rg', ['--null', ...args], { cwd, encoding: 'utf8' })
  if (result.error) {
    if ('code' in result.error && result.error.code === 'ENOENT' && existsSync(cwd)) {
      process.stderr.write('ripast: rg was not found on PATH. Using Node file search; it may be slower.\n')
      return fallback()
    }
    throw new Error(`Could not start rg: ${result.error.message}`, { cause: result.error })
  }
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`rg failed: ${result.stderr}`)
  return result.stdout.split('\0').filter(Boolean).map(p => resolve(cwd, p))
}

export function rgFiles(pattern: string, opts: { glob?: string | string[], cwd?: string, fixedStrings?: boolean, listAll?: boolean, engine?: EngineServices } = {}): string[] {
  const cwd = opts.cwd ?? process.cwd()
  const userGlobs = opts.glob ? (Array.isArray(opts.glob) ? opts.glob : [opts.glob]) : [...EXTS, ...opts.engine?.suffixes ?? []].map(e => `*${e}`)
  const { globs, select } = discoverySelection(userGlobs)
  const args: string[] = []
  if (opts.listAll) {
    args.push('--files', '--hidden', '--no-messages')
    for (const g of globs) args.push('-g', g)
    args.push('.')
  }
  else {
    args.push('--files-with-matches', '--hidden', '--no-messages')
    if (opts.fixedStrings !== false)
      args.push('--fixed-strings')
    for (const g of globs)
      args.push('-g', g)
    args.push('--', pattern, '.')
  }
  return select(runRipgrep(args, cwd, () => {
    if (!opts.listAll && opts.fixedStrings === false)
      throw new Error('Regex searches require ripgrep. Install it: https://github.com/BurntSushi/ripgrep#installation')
    return searchFiles(cwd, globs, opts.listAll ? { _tag: 'Files' } : { _tag: 'Text', patterns: [pattern] })
  }), cwd)
}

/**
 * Batch multiple fixed-string patterns into a single rg invocation via `-e <pat>`.
 * Returns the union of matching file paths. Empty `patterns` returns `[]` without spawning rg.
 */
export function rgFilesMany(patterns: string[], opts: { glob?: string | string[], cwd?: string, engine?: EngineServices } = {}): string[] {
  if (!patterns.length)
    return []
  const cwd = opts.cwd ?? process.cwd()
  const userGlobs = opts.glob ? (Array.isArray(opts.glob) ? opts.glob : [opts.glob]) : [...EXTS, ...opts.engine?.suffixes ?? []].map(e => `*${e}`)
  const { globs, select } = discoverySelection(userGlobs)
  const args: string[] = ['--files-with-matches', '--hidden', '--no-messages', '--fixed-strings']
  for (const g of globs) args.push('-g', g)
  for (const p of patterns) args.push('-e', p)
  args.push('.')
  return select(runRipgrep(args, cwd, () => searchFiles(cwd, globs, { _tag: 'Text', patterns })), cwd)
}

export function parseFile(path: string, cwd: string = process.cwd(), engine?: Pick<EngineServices, 'parse'>): ParsedFile {
  return parseSourceFile(path, readFileSync(path, 'utf8'), cwd, engine)
}

export function parseSourceFile(path: string, source: string, cwd: string = process.cwd(), engine?: Pick<EngineServices, 'parse'>): ParsedFile {
  const rel = relative(cwd, path)
  const region = engine?.parse(path, source, cwd)
  const scriptSource = region?._tag === 'Script' ? region.source : source
  const scriptStart = region?._tag === 'Script' ? region.start : 0
  const scriptEnd = scriptStart + scriptSource.length
  const { program, errors } = region?._tag === 'Authored' ? { program: region.program, errors: [] } : parseSync(region?.filename ?? path, scriptSource)
  if (errors?.length)
    process.stderr.write(`parse warnings in ${rel}: ${errors.length}\n`)
  return { path, rel, fullSource: source, scriptSource, scriptStart, scriptEnd, program, isSfc: Boolean(region) }
}

export function spliceScript(file: ParsedFile, newScript: string): string {
  if (!file.isSfc)
    return newScript
  return file.fullSource.slice(0, file.scriptStart) + newScript + file.fullSource.slice(file.scriptEnd)
}

export function writeChanges(changes: FileChange[]): void {
  const targets = new Map<string, FileChange>()
  for (const change of changes) {
    const target = existsSync(change.path) ? realpathSync(change.path) : resolve(change.path)
    const existing = targets.get(target)
    if (existing && (existing.before !== change.before || existing.after !== change.after))
      throw new Error(`Conflicting changes for ${change.rel}`)
    targets.set(target, change)
    const before = existsSync(target) ? readFileSync(target, 'utf8') : ''
    if (before !== change.before)
      throw new Error(`File changed since planning: ${change.rel}. Run the command again.`)
  }

  const staged: { directory: string, tmp: string, target: string, backup: string | null }[] = []
  const committed: typeof staged = []
  try {
    for (const [target, change] of targets) {
      mkdirSync(dirname(target), { recursive: true })
      const directory = mkdtempSync(join(dirname(target), '.ripast-tmp-'))
      const tmp = join(directory, 'after')
      const backup = existsSync(target) ? join(directory, 'before') : null
      staged.push({ directory, tmp, target, backup })
      writeFileSync(tmp, change.after)
      if (backup) {
        const mode = statSync(target).mode
        chmodSync(tmp, mode)
        writeFileSync(backup, change.before)
        chmodSync(backup, mode)
      }
    }
    for (const entry of staged) {
      renameSync(entry.tmp, entry.target)
      committed.push(entry)
    }
  }
  catch (err) {
    const failures: unknown[] = [err]
    for (const { target, backup } of committed.reverse()) {
      try {
        if (backup)
          renameSync(backup, target)
        else
          unlinkSync(target)
      }
      catch (restoreError) {
        failures.push(restoreError)
      }
    }
    // Keep backups available if the filesystem also prevents restoration.
    if (failures.length > 1)
      throw new AggregateError(failures, 'Could not restore every file. Original files remain in .ripast-tmp- directories.')
    for (const { directory } of staged)
      rmSync(directory, { recursive: true, force: true })
    throw err
  }
  for (const { directory } of staged)
    rmSync(directory, { recursive: true, force: true })
}

export function printDiffs(changes: FileChange[], out: NodeJS.WritableStream = process.stdout): void {
  for (const c of changes) {
    const patch = createPatch(c.rel, c.before, c.after, '', '', { context: 2 })
    out.write(patch)
  }
}

export interface ChangeSummary {
  files: number
  linesAdded: number
  linesRemoved: number
}

export function summarize(changes: FileChange[]): ChangeSummary {
  let added = 0
  let removed = 0
  for (const c of changes) {
    const diff = diffLineCounts(c.before, c.after)
    added += diff.added
    removed += diff.removed
  }
  return { files: changes.length, linesAdded: added, linesRemoved: removed }
}

function diffLineCounts(before: string, after: string): { added: number, removed: number } {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const beforeBag = new Map<string, number>()
  for (const l of beforeLines) beforeBag.set(l, (beforeBag.get(l) ?? 0) + 1)
  const afterBag = new Map<string, number>()
  for (const l of afterLines) afterBag.set(l, (afterBag.get(l) ?? 0) + 1)
  let removed = 0
  for (const [l, n] of beforeBag.entries()) {
    const a = afterBag.get(l) ?? 0
    if (n > a)
      removed += n - a
  }
  let added = 0
  for (const [l, n] of afterBag.entries()) {
    const b = beforeBag.get(l) ?? 0
    if (n > b)
      added += n - b
  }
  return { added, removed }
}

export function posToLineCol(source: string, pos: number): { line: number, col: number } {
  let line = 1
  let col = 1
  for (let i = 0; i < pos && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++
      col = 1
    }
    else { col++ }
  }
  return { line, col }
}

/** One transaction boundary for a planned file move and all consumer changes. */
export function writeFileRename(result: RenameFileResult, expectedSource = readFileSync(result.fileMove.from, 'utf8')): void {
  if (result.regressions.length)
    throw new Error('Verification failed; file rename was refused')
  if (readFileSync(result.fileMove.from, 'utf8') !== expectedSource)
    throw new Error('Source changed since planning; file rename was refused')
  if (existsSync(result.fileMove.to))
    throw new Error('File rename target already exists')
  const self = result.selfChange ? [{ path: result.fileMove.to, rel: result.fileMove.to, ...result.selfChange }] : []
  // Validate consumers before moving. writeChanges repeats validation before committing.
  for (const change of result.changes) {
    const current = existsSync(change.path) ? readFileSync(change.path, 'utf8') : ''
    if (current !== change.before)
      throw new Error(`File changed since planning: ${change.rel}`)
  }
  mkdirSync(dirname(result.fileMove.to), { recursive: true })
  renameSync(result.fileMove.from, result.fileMove.to)
  try {
    writeChanges([...self, ...result.changes])
  }
  catch (error) {
    try {
      renameSync(result.fileMove.to, result.fileMove.from)
    }
    catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'File rename failed; source restoration failed')
    }
    throw error
  }
}
