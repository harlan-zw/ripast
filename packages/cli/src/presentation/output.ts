import { Buffer } from 'node:buffer'
import { isAbsolute, relative, sep } from 'node:path'

export interface OutputSelection<T = unknown> {
  limit?: number
  offset?: number
  file?: string
  pageBytes?: number
  render?: (page: OutputPage<T>) => string
}

export interface OutputPage<T> {
  total: number
  matched: number
  shown: number
  omitted: number
  offset: number
  nextOffset?: number
  results: T[]
}

/** Selection changes display only. Discovery and verification retain complete inputs. */
export function selectOutput<T>(items: readonly T[], options: OutputSelection<T> = {}, file?: (item: T) => string): OutputPage<T> {
  const offset = options.offset ?? 0
  const limit = options.limit ?? items.length
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0)
    throw new Error('Output limit and offset must be non-negative integers.')
  if (options.pageBytes !== undefined && (!Number.isSafeInteger(options.pageBytes) || options.pageBytes < 1024))
    throw new Error('Output page budget must be an integer of at least 1024 bytes.')
  const matched = options.file && file ? items.filter(item => file(item) === options.file) : [...items]
  const results = matched.slice(offset, offset + limit)
  const page = (results: T[]): OutputPage<T> => ({ total: items.length, matched: matched.length, shown: results.length, omitted: matched.length - results.length, offset, ...(results.length && offset + results.length < matched.length ? { nextOffset: offset + results.length } : {}), results })
  if (options.pageBytes === undefined)
    return page(results)
  const render = options.render ?? JSON.stringify
  // Keep one atomic result even if it exceeds the target. The hard guard handles it.
  let shown = Math.min(1, results.length)
  for (let count = 2; count <= results.length; count++) {
    if (Buffer.byteLength(render(page(results.slice(0, count)))) > options.pageBytes)
      break
    shown = count
  }
  return page(results.slice(0, shown))
}

export function outputPath(path: string, cwd: string): string {
  const rel = relative(cwd, path)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? path : rel.split(sep).join('/')
}

export function formatOutputPage(page: Omit<OutputPage<unknown>, 'results'>): string {
  return `total: ${page.total}, matched: ${page.matched}, shown: ${page.shown}, omitted: ${page.omitted}, offset: ${page.offset}${page.nextOffset === undefined ? '' : `, nextOffset: ${page.nextOffset}`}`
}

export const DEFAULT_OUTPUT_BYTES = 32 * 1024
export const DEFAULT_PAGE_BYTES = 4 * 1024

export function parsePageBytes(value: unknown, compact: boolean): number | undefined {
  const pageBytes = value == null ? compact ? DEFAULT_PAGE_BYTES : undefined : Number(value)
  if (pageBytes !== undefined && (!Number.isSafeInteger(pageBytes) || pageBytes < 1024))
    throw new Error('Option --page-bytes requires an integer of at least 1024 bytes.')
  return pageBytes
}

/** Parse the display budget before operations that can write project files. */
export function parseOutputBytes(value: unknown, compact: boolean): number | undefined {
  const maxBytes = value == null ? compact ? DEFAULT_OUTPUT_BYTES : undefined : Number(value)
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1024))
    throw new Error('Option --max-bytes requires an integer of at least 1024 bytes.')
  return maxBytes
}

/** A structured result stays complete or uses the caller's explicit omission result. */
export function renderBoundedOutput<T>(value: T, options: {
  maxBytes?: number
  render: (value: T) => string
  omitted: (bytes: number) => string
}): string {
  const maxBytes = parseOutputBytes(options.maxBytes, false)
  const rendered = options.render(value)
  const bytes = Buffer.byteLength(rendered)
  if (maxBytes === undefined || bytes <= maxBytes)
    return rendered
  const fallback = options.omitted(bytes)
  if (Buffer.byteLength(fallback) > maxBytes)
    throw new Error('The output fallback exceeds --max-bytes. Increase the output budget.')
  return fallback
}

export interface TextOutput {
  write: (text: string) => boolean
  end: () => void
}

/** One budget covers all text writes in a command, including diffs. */
export function createTextOutput(options: { maxBytes?: number, write: (text: string) => unknown }): TextOutput {
  const maxBytes = parseOutputBytes(options.maxBytes, false)
  let state: { _tag: 'Open', bytes: number, retained: number, chunks: Buffer[] } | { _tag: 'Closed' } = { _tag: 'Open', bytes: 0, retained: 0, chunks: [] }
  return {
    write(text) {
      if (state._tag === 'Closed')
        throw new Error('Cannot write after output closes.')
      if (maxBytes === undefined) {
        options.write(text)
        return true
      }
      const chunk = Buffer.from(text)
      state.bytes += chunk.length
      const remaining = maxBytes - state.retained
      if (remaining > 0) {
        const retained = Buffer.from(chunk.subarray(0, remaining))
        state.chunks.push(retained)
        state.retained += retained.length
      }
      return true
    },
    end() {
      if (state._tag === 'Closed')
        return
      const open = state
      state = { _tag: 'Closed' }
      if (maxBytes === undefined)
        return
      const prefix = Buffer.concat(open.chunks)
      if (open.bytes <= maxBytes) {
        options.write(prefix.toString('utf8'))
        return
      }
      const notice = `\nOutput omitted: ${open.bytes} bytes exceed --max-bytes ${maxBytes}.\nUse --limit, --offset, --file, or increase --max-bytes.\nUse --json --artifact <new-file.json> to save complete evidence.\n`
      const available = prefix.subarray(0, maxBytes - Buffer.byteLength(notice))
      // Keep complete lines so UTF-8 characters and individual findings stay intact.
      const end = available.lastIndexOf(10)
      options.write(`${end < 0 ? '' : available.subarray(0, end + 1).toString('utf8')}${notice}`)
    },
  }
}
