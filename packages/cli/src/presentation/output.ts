import { isAbsolute, relative, sep } from 'node:path'

export interface OutputSelection {
  limit?: number
  offset?: number
  file?: string
}

export interface OutputPage<T> {
  total: number
  matched: number
  shown: number
  omitted: number
  offset: number
  results: T[]
}

/** Selection changes display only. Discovery and verification retain complete inputs. */
export function selectOutput<T>(items: readonly T[], options: OutputSelection = {}, file?: (item: T) => string): OutputPage<T> {
  const offset = options.offset ?? 0
  const limit = options.limit ?? items.length
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0)
    throw new Error('Output limit and offset must be non-negative integers.')
  const matched = options.file && file ? items.filter(item => file(item) === options.file) : [...items]
  const results = matched.slice(offset, offset + limit)
  return { total: items.length, matched: matched.length, shown: results.length, omitted: matched.length - results.length, offset, results }
}

export function outputPath(path: string, cwd: string): string {
  const rel = relative(cwd, path)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? path : rel.split(sep).join('/')
}

export function formatOutputPage(page: Omit<OutputPage<unknown>, 'results'>): string {
  return `total: ${page.total}, matched: ${page.matched}, shown: ${page.shown}, omitted: ${page.omitted}, offset: ${page.offset}`
}
