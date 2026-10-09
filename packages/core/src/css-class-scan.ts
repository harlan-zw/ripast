import process from 'node:process'
import { readCssClassSourceFiles, visitCssClassTokensInFile } from './css-class-source.ts'

export interface CssClassScanOptions {
  cwd?: string
  glob?: string | string[]
  pattern?: string[]
  sort?: CssClassScanSort
}

export interface CssClassFileScanOptions extends Omit<CssClassScanOptions, 'sort'> {
  sort?: CssClassFileScanSort
}

export interface CssClassScanHit {
  token: string
  count: number
  files: string[]
}

export interface CssClassFileScanHit {
  file: string
  unique: number
  count: number
  tokens: string[]
}

export type CssClassScanSort = 'count-desc' | 'count-asc' | 'token'
export type CssClassFileScanSort = 'unique-desc' | 'unique-asc' | 'count-desc' | 'count-asc' | 'file'

export function runCssClassScan(opts: CssClassScanOptions = {}): CssClassScanHit[] {
  const cwd = opts.cwd ?? process.cwd()
  const match = compileGlobs(opts.pattern)
  const counts = new Map<string, { count: number, files: Set<string> }>()
  for (const file of readCssClassSourceFiles({ cwd, glob: opts.glob })) {
    const seen = new Map<string, number>()
    const onToken = (bare: string): void => {
      if (!match(bare))
        return
      seen.set(bare, (seen.get(bare) ?? 0) + 1)
    }
    visitCssClassTokensInFile(file, onToken)
    for (const [tok, n] of seen) {
      const entry = counts.get(tok) ?? { count: 0, files: new Set<string>() }
      entry.count += n
      entry.files.add(file.rel)
      counts.set(tok, entry)
    }
  }
  const hits: CssClassScanHit[] = Array.from(counts, ([token, v]) => ({
    token,
    count: v.count,
    files: [...v.files].sort(),
  }))
  hits.sort(resolveSort(opts.sort))
  return hits
}

export function runCssClassFileScan(opts: CssClassFileScanOptions = {}): CssClassFileScanHit[] {
  const cwd = opts.cwd ?? process.cwd()
  const match = compileGlobs(opts.pattern)
  const hits: CssClassFileScanHit[] = []
  for (const file of readCssClassSourceFiles({ cwd, glob: opts.glob })) {
    const seen = new Map<string, number>()
    const onToken = (bare: string): void => {
      if (!match(bare))
        return
      seen.set(bare, (seen.get(bare) ?? 0) + 1)
    }
    visitCssClassTokensInFile(file, onToken)
    if (!seen.size)
      continue
    const tokens = [...seen.keys()].sort(compareToken)
    hits.push({
      file: file.rel,
      unique: tokens.length,
      count: [...seen.values()].reduce((sum, n) => sum + n, 0),
      tokens,
    })
  }
  hits.sort(resolveFileSort(opts.sort))
  return hits
}

function resolveSort(sort: CssClassScanSort = 'count-desc'): (a: CssClassScanHit, b: CssClassScanHit) => number {
  if (sort === 'count-asc')
    return (a, b) => a.count - b.count || a.files.length - b.files.length || compareToken(a.token, b.token)
  if (sort === 'token')
    return (a, b) => compareToken(a.token, b.token)
  return (a, b) => b.count - a.count || compareToken(a.token, b.token)
}

function compareToken(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function resolveFileSort(sort: CssClassFileScanSort = 'unique-desc'): (a: CssClassFileScanHit, b: CssClassFileScanHit) => number {
  if (sort === 'unique-asc')
    return (a, b) => a.unique - b.unique || a.count - b.count || compareToken(a.file, b.file)
  if (sort === 'count-desc')
    return (a, b) => b.count - a.count || b.unique - a.unique || compareToken(a.file, b.file)
  if (sort === 'count-asc')
    return (a, b) => a.count - b.count || a.unique - b.unique || compareToken(a.file, b.file)
  if (sort === 'file')
    return (a, b) => compareToken(a.file, b.file)
  return (a, b) => b.unique - a.unique || b.count - a.count || compareToken(a.file, b.file)
}

function compileGlobs(patterns: string[] | undefined): (s: string) => boolean {
  if (!patterns || !patterns.length)
    return () => true
  const matchers = patterns.map((p) => {
    if (!p.includes('*'))
      return (s: string) => s === p
    const re = new RegExp(`^${p.split('*').map(escapeRe).join('.*')}$`)
    return (s: string) => re.test(s)
  })
  return s => matchers.some(m => m(s))
}

const RE_META_RE = /[.+?^${}()|[\]\\]/g

function escapeRe(s: string): string {
  return s.replace(RE_META_RE, '\\$&')
}

export function formatScanHits(hits: CssClassScanHit[], json: boolean): string {
  if (json)
    return JSON.stringify(hits, null, 2)
  if (!hits.length)
    return 'no class tokens found'
  const width = Math.max(...hits.map(h => h.token.length))
  const lines: string[] = []
  for (const h of hits)
    lines.push(`${h.token.padEnd(width)}  ${String(h.count).padStart(5)}  (${h.files.length} file${h.files.length === 1 ? '' : 's'})`)
  lines.push('')
  lines.push(`${hits.length} unique tokens across ${new Set(hits.flatMap(h => h.files)).size} files`)
  return lines.join('\n')
}

export function formatAgentScanHits(hits: CssClassScanHit[], limit: number = 40, offset = 0, file?: string): string {
  const total = hits.length
  hits = file ? hits.filter(hit => hit.files.includes(file)) : hits
  if (!hits.length)
    return 'class-scan tokens=0 files=0'
  const shown = hits.slice(offset, offset + limit)
  const lines = [`class-scan tokens=${hits.length} files=${new Set(hits.flatMap(h => h.files)).size} top=${shown.length} total=${total} omitted=${hits.length - shown.length} offset=${offset} format=token=count/files`]
  const chunkSize = 8
  for (let i = 0; i < shown.length; i += chunkSize)
    lines.push(shown.slice(i, i + chunkSize).map(h => `${h.token}=${h.count}/${h.files.length}`).join(' '))
  if (hits.length > shown.length)
    lines.push(`+${hits.length - shown.length} more`)
  return lines.join('\n')
}

export function formatFileScanHits(hits: CssClassFileScanHit[], json: boolean): string {
  if (json)
    return JSON.stringify(hits, null, 2)
  if (!hits.length)
    return 'no class tokens found'
  const width = Math.max(...hits.map(h => h.file.length))
  const lines: string[] = []
  for (const h of hits)
    lines.push(`${h.file.padEnd(width)}  ${String(h.unique).padStart(5)} unique  ${String(h.count).padStart(5)} total`)
  lines.push('')
  lines.push(`${hits.length} files with class tokens`)
  return lines.join('\n')
}

export function formatAgentFileScanHits(hits: CssClassFileScanHit[], limit: number = 40, offset = 0, file?: string): string {
  const total = hits.length
  hits = file ? hits.filter(hit => hit.file === file) : hits
  if (!hits.length)
    return 'class-files files=0'
  const shown = hits.slice(offset, offset + limit)
  const lines = [`class-files files=${hits.length} top=${shown.length} total=${total} omitted=${hits.length - shown.length} offset=${offset} format=file=unique/total`]
  for (const h of shown)
    lines.push(`${h.file}=${h.unique}/${h.count}`)
  if (hits.length > shown.length)
    lines.push(`+${hits.length - shown.length} more`)
  return lines.join('\n')
}
