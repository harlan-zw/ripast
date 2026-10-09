import type { FrameworkAdapter } from './adapter.ts'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
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
export function rgFiles(pattern: string, opts: {
  glob?: string | string[]
  cwd?: string
  fixedStrings?: boolean
  listAll?: boolean
  extensions?: readonly FrameworkAdapter[]
} = {}): string[] {
  const cwd = opts.cwd ?? process.cwd()
  const userGlobs = opts.glob ? (Array.isArray(opts.glob) ? opts.glob : [opts.glob]) : [...EXTS, ...opts.extensions?.flatMap(extension => [...extension.suffixes]) ?? []].map(e => `*${e}`)
  const { globs, select } = discoverySelection(userGlobs)
  const args: string[] = []
  if (opts.listAll) {
    args.push('--files', '--hidden', '--no-messages')
    for (const g of globs)
      args.push('-g', g)
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
export function rgFilesMany(patterns: string[], opts: {
  glob?: string | string[]
  cwd?: string
  extensions?: readonly FrameworkAdapter[]
} = {}): string[] {
  if (!patterns.length)
    return []
  const cwd = opts.cwd ?? process.cwd()
  const userGlobs = opts.glob ? (Array.isArray(opts.glob) ? opts.glob : [opts.glob]) : [...EXTS, ...opts.extensions?.flatMap(extension => [...extension.suffixes]) ?? []].map(e => `*${e}`)
  const { globs, select } = discoverySelection(userGlobs)
  const args: string[] = ['--files-with-matches', '--hidden', '--no-messages', '--fixed-strings']
  for (const g of globs)
    args.push('-g', g)
  for (const p of patterns)
    args.push('-e', p)
  args.push('.')
  return select(runRipgrep(args, cwd, () => searchFiles(cwd, globs, { _tag: 'Text', patterns })), cwd)
}
export function parseFile(path: string, cwd: string = process.cwd(), extensions: readonly FrameworkAdapter[] = []): ParsedFile {
  const source = readFileSync(path, 'utf8')
  return parseSourceFile(path, source, cwd, extensions)
}
export function parseSourceFile(path: string, source: string, cwd: string = process.cwd(), extensions: readonly FrameworkAdapter[] = []): ParsedFile {
  const rel = relative(cwd, path)
  const extension = extensions.find(extension => extension.suffixes.some(suffix => path.endsWith(suffix)))
  if (extension) {
    if (!extension.parse)
      throw new Error(`Extension cannot parse ${path}`)
    return { ...extension.parse(path, source), path, rel, fullSource: source }
  }
  const { program, errors } = parseSync(path, source)
  if (errors?.length)
    process.stderr.write(`parse warnings in ${rel}: ${errors.length}\n`)
  return { path, rel, fullSource: source, scriptSource: source, scriptStart: 0, scriptEnd: source.length, program, isSfc: false }
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
  const staged: {
    directory: string
    tmp: string
    target: string
    backup: string | null
  }[] = []
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
function diffLineCounts(before: string, after: string): {
  added: number
  removed: number
} {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const beforeBag = new Map<string, number>()
  for (const l of beforeLines)
    beforeBag.set(l, (beforeBag.get(l) ?? 0) + 1)
  const afterBag = new Map<string, number>()
  for (const l of afterLines)
    afterBag.set(l, (afterBag.get(l) ?? 0) + 1)
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
export function posToLineCol(source: string, pos: number): {
  line: number
  col: number
} {
  let line = 1
  let col = 1
  for (let i = 0; i < pos && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) {
      line++
      col = 1
    }
    else {
      col++
    }
  }
  return { line, col }
}
export type CommitPlan = {
  _tag: 'Changes'
  changes: FileChange[]
} | {
  _tag: 'FileRename'
  changes: FileChange[]
  from: string
  to: string
  before: string
  after: string
}
/** Commit source relocation and consumer edits together, with rollback on failure. */
export function commitChanges(plan: CommitPlan): void {
  if (plan._tag === 'Changes') {
    writeChanges(plan.changes)
    return
  }
  if (readFileSync(plan.from, 'utf8') !== plan.before)
    throw new Error(`File changed since planning: ${plan.from}`)
  if (existsSync(plan.to)) {
    const fromStat = statSync(plan.from)
    const toStat = statSync(plan.to)
    const caseOnly = dirname(plan.from) === dirname(plan.to)
      && basename(plan.from).toLowerCase() === basename(plan.to).toLowerCase()
      && fromStat.dev === toStat.dev && fromStat.ino === toStat.ino
      && !readdirSync(dirname(plan.to)).includes(basename(plan.to))
    if (!caseOnly)
      throw new Error(`File rename target already exists: ${plan.to}`)
  }
  // Validate consumers before the first source relocation.
  for (const change of plan.changes) {
    const before = existsSync(change.path) ? readFileSync(change.path, 'utf8') : ''
    if (before !== change.before)
      throw new Error(`File changed since planning: ${change.path}`)
  }
  mkdirSync(dirname(plan.to), { recursive: true })
  renameSync(plan.from, plan.to)
  try {
    writeChanges([{ path: plan.to, rel: plan.to, before: plan.before, after: plan.after }, ...plan.changes])
  }
  catch (error) {
    try {
      renameSync(plan.to, plan.from)
    }
    catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'File rename failed. Restoring the source path also failed.')
    }
    throw error
  }
}
