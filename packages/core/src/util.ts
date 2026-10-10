import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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

const EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue']

// Meta-project directories that aren't real source even when not in .gitignore.
// Git excludes `.git` from tracked files; the rest are workflow
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

type CandidateSearch = { _tag: 'Files' } | { _tag: 'Text', patterns: string[] } | { _tag: 'Regex', pattern: string }

function selectCandidateFiles(paths: string[], cwd: string, globs: string[]): string[] {
  const rules = globs.map((glob) => {
    const excluded = glob.startsWith('!')
    let pattern = excluded ? glob.slice(1) : glob
    for (;;) {
      const next = pattern.replace(/(?<!\\)\{([^{}]*)\}/g, (match, body: string) => body.includes(',') ? match : body)
      if (next === pattern)
        break
      pattern = next
    }
    return { excluded, matches: picomatch(pattern.replace(/^\//, ''), { dot: true, nonegate: true, noext: true, strictSlashes: true, basename: !pattern.includes('/') }) }
  })
  const hasIncludes = rules.some(rule => !rule.excluded)
  return paths.filter((path) => {
    if (!existsSync(path) || !lstatSync(path).isFile())
      return false
    const rel = relative(cwd, path).replace(/\\/g, '/')
    const segments = rel.split('/')
    const ancestors = segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join('/'))
    let selected = !hasIncludes
    for (const rule of rules) {
      if (rule.matches(rel) || ancestors.some(directory => rule.matches(directory)))
        selected = !rule.excluded
    }
    return selected
  })
}

function runGitSearch(search: CandidateSearch, cwd: string, globs: string[]): string[] {
  const fallback = (): string[] => {
    if (search._tag === 'Regex')
      throw new Error('Regex searches require ripgrep, or Git and a Git working tree.')
    return searchFiles(cwd, globs, search)
  }
  const args = ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.']
  const result = spawnSync('git', ['--no-pager', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })
  if (result.error) {
    if ('code' in result.error && result.error.code === 'ENOENT' && existsSync(cwd)) {
      process.stderr.write('ripast: Git was not found on PATH. Using Node file search; it may be slower.\n')
      return fallback()
    }
    throw new Error(`Could not start Git: ${result.error.message}`, { cause: result.error })
  }
  if (result.status === 128 && /not a git repository/i.test(result.stderr))
    return fallback()
  if (result.status !== 0)
    throw new Error(`Git search failed: ${result.stderr}`)
  const paths = [...new Set(result.stdout.split('\0').filter(Boolean).map(p => resolve(cwd, p)))]
  const selected = selectCandidateFiles(paths, cwd, globs)
  if (search._tag === 'Files')
    return selected
  if (search._tag === 'Text') {
    return selected.filter((path) => {
      const content = readFileSync(path)
      return !content.includes(0) && search.patterns.some(pattern => content.includes(pattern))
    })
  }
  const matches: string[] = []
  // Bound argument size when regex search passes selected paths to Git.
  for (let index = 0; index < Math.max(selected.length, 1); index += 64) {
    const batch = selected.slice(index, index + 64).map(path => `./${relative(cwd, path)}`)
    // An empty selection still compiles the regex, with every indexed path excluded.
    const scope = batch.length ? ['--no-index', '--no-exclude-standard'] : []
    const paths = batch.length ? batch : [':(exclude)**']
    const result = spawnSync('git', ['--no-pager', '-c', 'grep.fullName=false', 'grep', ...scope, '--no-color', '--no-textconv', '-I', '-l', '-z', '-E', '-e', search.pattern, '--', ...paths], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } })
    if (result.error)
      throw new Error(`Could not start Git: ${result.error.message}`, { cause: result.error })
    if (result.status !== 0 && result.status !== 1)
      throw new Error(`Git search failed: ${result.stderr}`)
    matches.push(...result.stdout.split('\0').filter(Boolean).map(path => resolve(cwd, path)))
  }
  return matches
}

function runSearch(search: CandidateSearch, cwd: string, globs: string[]): string[] {
  const args = search._tag === 'Files'
    ? ['--files']
    : ['--files-with-matches', ...(search._tag === 'Regex' ? [] : ['--fixed-strings'])]
  args.push('--null', '--hidden', '--no-messages')
  for (const glob of globs)
    args.push('-g', glob)
  if (search._tag !== 'Files') {
    for (const pattern of search._tag === 'Regex' ? [search.pattern] : search.patterns)
      args.push('-e', pattern)
  }
  args.push('--', '.')
  const result = spawnSync('rg', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) {
    if ('code' in result.error && result.error.code === 'ENOENT' && existsSync(cwd))
      return runGitSearch(search, cwd, globs)
    throw new Error(`Could not start rg: ${result.error.message}`, { cause: result.error })
  }
  if (result.status !== 0 && result.status !== 1)
    throw new Error(`rg failed: ${result.stderr}`)
  return result.stdout.split('\0').filter(Boolean).map(path => resolve(cwd, path))
}

export function findFiles(pattern: string, opts: { glob?: string | string[], cwd?: string, fixedStrings?: boolean, listAll?: boolean } = {}): string[] {
  const cwd = opts.cwd ?? process.cwd()
  const userGlobs = opts.glob ? (Array.isArray(opts.glob) ? opts.glob : [opts.glob]) : EXTS.map(e => `*${e}`)
  const { globs, select } = discoverySelection(userGlobs)
  const search: CandidateSearch = opts.listAll
    ? { _tag: 'Files' }
    : opts.fixedStrings === false ? { _tag: 'Regex', pattern } : { _tag: 'Text', patterns: [pattern] }
  return select(runSearch(search, cwd, globs), cwd)
}

/**
 * Batch fixed-string patterns into one search with `-e <pattern>`.
 * Empty patterns return no files without starting a search tool.
 */
export function findFilesMany(patterns: string[], opts: { glob?: string | string[], cwd?: string } = {}): string[] {
  if (!patterns.length)
    return []
  const cwd = opts.cwd ?? process.cwd()
  const userGlobs = opts.glob ? (Array.isArray(opts.glob) ? opts.glob : [opts.glob]) : EXTS.map(e => `*${e}`)
  const { globs, select } = discoverySelection(userGlobs)
  return select(runSearch({ _tag: 'Text', patterns }, cwd, globs), cwd)
}

const SFC_SCRIPT_RE = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi
const SFC_SRC_ATTR_RE = /\bsrc\s*=/

function extractScript(source: string): { start: number, end: number, code: string } | null {
  const blocks: { start: number, end: number, code: string, hasSrc: boolean }[] = []
  for (const m of source.matchAll(SFC_SCRIPT_RE)) {
    const tagStart = m.index ?? 0
    const tagEnd = source.indexOf('>', tagStart) + 1
    const attrs = source.slice(tagStart, tagEnd)
    const hasSrc = SFC_SRC_ATTR_RE.test(attrs)
    const code = m[1]
    const start = tagEnd
    const end = start + code.length
    blocks.push({ start, end, code, hasSrc })
  }
  const usable = blocks.filter(b => !b.hasSrc)
  if (!usable.length)
    return null
  return usable.reduce((a, b) => (b.code.length > a.code.length ? b : a))
}

export function parseFile(path: string, cwd: string = process.cwd()): ParsedFile {
  const source = readFileSync(path, 'utf8')
  return parseSourceFile(path, source, cwd)
}

export function parseSourceFile(path: string, source: string, cwd: string = process.cwd()): ParsedFile {
  const rel = relative(cwd, path)
  if (path.endsWith('.vue')) {
    const block = extractScript(source)
    if (!block)
      return { path, rel, fullSource: source, scriptSource: '', scriptStart: 0, scriptEnd: 0, program: null, isSfc: true }
    const { program, errors } = parseSync(`${path}.ts`, block.code)
    if (errors?.length)
      process.stderr.write(`parse warnings in ${rel}: ${errors.length}\n`)
    return { path, rel, fullSource: source, scriptSource: block.code, scriptStart: block.start, scriptEnd: block.end, program, isSfc: true }
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
