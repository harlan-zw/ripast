import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import process from 'node:process'
import { createPatch } from 'diff'
import { parseSync } from 'oxc-parser'

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

export function rgFiles(pattern: string, opts: { glob?: string | string[], cwd?: string, fixedStrings?: boolean, listAll?: boolean } = {}): string[] {
  const cwd = opts.cwd ?? process.cwd()
  const globs = opts.glob ? (Array.isArray(opts.glob) ? opts.glob : [opts.glob]) : EXTS.map(e => `*${e}`)
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
    args.push(pattern, '.')
  }
  const r = spawnSync('rg', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0 && r.status !== 1)
    throw new Error(`rg failed: ${r.stderr}`)
  return r.stdout.split('\n').filter(Boolean).map((p: string) => resolve(cwd, p))
}

/**
 * Batch multiple fixed-string patterns into a single rg invocation via `-e <pat>`.
 * Returns the union of matching file paths. Empty `patterns` returns `[]` without spawning rg.
 */
export function rgFilesMany(patterns: string[], opts: { glob?: string | string[], cwd?: string } = {}): string[] {
  if (!patterns.length)
    return []
  const cwd = opts.cwd ?? process.cwd()
  const globs = opts.glob ? (Array.isArray(opts.glob) ? opts.glob : [opts.glob]) : EXTS.map(e => `*${e}`)
  const args: string[] = ['--files-with-matches', '--hidden', '--no-messages', '--fixed-strings']
  for (const g of globs) args.push('-g', g)
  for (const p of patterns) args.push('-e', p)
  args.push('.')
  const r = spawnSync('rg', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0 && r.status !== 1)
    throw new Error(`rg failed: ${r.stderr}`)
  return r.stdout.split('\n').filter(Boolean).map((p: string) => resolve(cwd, p))
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
  const staged: { tmp: string, target: string }[] = []
  try {
    for (const c of changes) {
      mkdirSync(dirname(c.path), { recursive: true })
      const tmp = `${c.path}.ripast-tmp-${process.pid}`
      writeFileSync(tmp, c.after)
      staged.push({ tmp, target: c.path })
    }
    for (const { tmp, target } of staged)
      renameSync(tmp, target)
  }
  catch (err) {
    for (const { tmp } of staged) {
      try {
        unlinkSync(tmp)
      }
      catch {}
    }
    throw err
  }
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
