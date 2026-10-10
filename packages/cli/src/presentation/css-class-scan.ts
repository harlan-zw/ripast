import type { CssClassFileScanHit, CssClassScanHit } from 'ripide-api'

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
  const lines = [`class-scan tokens=${hits.length} files=${new Set(hits.flatMap(h => h.files)).size} top=${shown.length} format=token=count/files total=${total} omitted=${hits.length - shown.length} offset=${offset}`]
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
