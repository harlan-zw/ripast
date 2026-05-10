import process from 'node:process'
import { readCssClassSourceFiles, visitCssClassTokensInFile } from './css-class-source.ts'

export interface CssClassScanOptions {
  cwd?: string
  glob?: string | string[]
  pattern?: string[]
}

export interface CssClassScanHit {
  token: string
  count: number
  files: string[]
}

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
  hits.sort((a, b) => b.count - a.count || (a.token < b.token ? -1 : 1))
  return hits
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

export function formatAgentScanHits(hits: CssClassScanHit[], limit: number = 40): string {
  if (!hits.length)
    return 'class scan\nno class tokens found'
  const shown = hits.slice(0, limit)
  const lines = ['class scan']
  lines.push(`${hits.length} unique tokens across ${new Set(hits.flatMap(h => h.files)).size} files`)
  lines.push(`top ${shown.length}:`)
  for (const h of shown)
    lines.push(`  ${h.token}: ${h.count} (${h.files.length} file${h.files.length === 1 ? '' : 's'})`)
  if (hits.length > shown.length)
    lines.push(`  ... ${hits.length - shown.length} more`)
  return lines.join('\n')
}
