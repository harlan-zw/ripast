import type { OutputPage, OutputSelection } from './output.ts'
import { Buffer } from 'node:buffer'
import { DEFAULT_PAGE_BYTES, selectOutput } from './output.ts'

export type EvidenceScalar = string | number | boolean | null
export type EvidenceInspection
  = | ({ _tag: 'Collection', path: string, unit?: 'text' } & OutputPage<unknown>)
    | ({ _tag: 'Object', path: string, values: Record<string, EvidenceScalar>, omittedValues: { path: string, bytes: number }[], collections: { path: string, total: number }[], objects: string[] } & Omit<OutputPage<unknown>, 'results'>)
    | { _tag: 'Value', path: string, value: EvidenceScalar }

export type EvidenceResult
  = | { _tag: 'Ok', value: EvidenceInspection }
    | { _tag: 'Err', message: string }

type PointerResult = { _tag: 'Ok', tokens: string[] } | { _tag: 'Err', message: string }
type EvidenceChild
  = | { _tag: 'Scalar', key: string, value: EvidenceScalar }
    | { _tag: 'OmittedScalar', path: string, bytes: number }
    | { _tag: 'Collection', path: string, total: number }
    | { _tag: 'Object', path: string }

function inspectObjectPage(path: string, page: OutputPage<EvidenceChild>): Extract<EvidenceInspection, { _tag: 'Object' }> {
  const { results, ...counts } = page
  const values: [string, EvidenceScalar][] = []
  const omittedValues: { path: string, bytes: number }[] = []
  const collections: { path: string, total: number }[] = []
  const objects: string[] = []
  for (const child of results) {
    if (child._tag === 'Scalar')
      values.push([child.key, child.value])
    else if (child._tag === 'OmittedScalar')
      omittedValues.push({ path: child.path, bytes: child.bytes })
    else if (child._tag === 'Collection')
      collections.push({ path: child.path, total: child.total })
    else
      objects.push(child.path)
  }
  return { _tag: 'Object', path, ...counts, values: Object.fromEntries(values), omittedValues, collections, objects }
}

/** RFC 6901 pointers identify arbitrary JSON keys without ambiguous dot paths. */
export function parseEvidencePointer(path: string): PointerResult {
  if (path === '')
    return { _tag: 'Ok', tokens: [] }
  if (!path.startsWith('/'))
    return { _tag: 'Err', message: 'JSON Pointer must be empty or start with /.' }
  const tokens = path.slice(1).split('/')
  if (tokens.some(token => /~(?:[^01]|$)/.test(token)))
    return { _tag: 'Err', message: 'JSON Pointer escapes must use ~0 for ~ or ~1 for /.' }
  return { _tag: 'Ok', tokens: tokens.map(token => token.replace(/~[01]/g, escape => escape === '~0' ? '~' : '/')) }
}

function childPointer(path: string, key: string): string {
  return `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
}

function isScalar(value: unknown): value is EvidenceScalar {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}

function sourceFragments(text: string): { line: number, part: number, text: string }[] {
  const rows: { line: number, part: number, text: string }[] = []
  let line = 1
  let part = 1
  let offset = 0
  let fragment = ''
  let bytes = 0
  const flush = () => {
    if (!fragment)
      return
    rows.push({ line, part, text: fragment })
    fragment = ''
    bytes = 0
    part++
  }
  for (const codePoint of text) {
    const size = Buffer.byteLength(codePoint)
    if (bytes + size > 512)
      flush()
    fragment += codePoint
    bytes += size
    offset += codePoint.length
    if (codePoint === '\n' || (codePoint === '\r' && text[offset] !== '\n') || codePoint === '\u2028' || codePoint === '\u2029') {
      flush()
      line++
      part = 1
    }
  }
  flush()
  return rows
}

/** Inspect immediate children or page a collection without changing saved evidence. */
export function inspectEvidence(input: unknown, path = '', options: OutputSelection<unknown> = {}): EvidenceResult {
  const pointer = parseEvidencePointer(path)
  if (pointer._tag === 'Err')
    return pointer
  let value = input
  for (const token of pointer.tokens) {
    if (Array.isArray(value)) {
      const index = Number(token)
      if (!/^(?:0|[1-9]\d*)$/.test(token) || !Number.isSafeInteger(index) || index >= value.length)
        return { _tag: 'Err', message: `JSON Pointer array index does not exist: ${token}.` }
      value = value[index]
    }
    else if (value !== null && typeof value === 'object') {
      if (!Object.hasOwn(value, token))
        return { _tag: 'Err', message: `JSON Pointer object key does not exist: ${token}.` }
      value = (value as Record<string, unknown>)[token]
    }
    else {
      return { _tag: 'Err', message: 'JSON Pointer cannot continue through a scalar value.' }
    }
  }
  if (Array.isArray(value)) {
    const page = selectOutput(value, {
      ...options,
      pageBytes: options.pageBytes ?? DEFAULT_PAGE_BYTES,
      render: options.render ?? (page => JSON.stringify({ _tag: 'Collection', path, ...page })),
    })
    return { _tag: 'Ok', value: { _tag: 'Collection', path, ...page } }
  }
  if (typeof value === 'string' && Buffer.byteLength(value) > 256) {
    const page = selectOutput(sourceFragments(value), {
      ...options,
      pageBytes: options.pageBytes ?? DEFAULT_PAGE_BYTES,
      render: options.render ?? (page => JSON.stringify({ _tag: 'Collection', path, unit: 'text', ...page })),
    })
    return { _tag: 'Ok', value: { _tag: 'Collection', path, unit: 'text', ...page } }
  }
  if (isScalar(value))
    return { _tag: 'Ok', value: { _tag: 'Value', path, value } }
  if (value !== null && typeof value === 'object') {
    const children: EvidenceChild[] = []
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && Buffer.byteLength(child) > 256)
        children.push({ _tag: 'OmittedScalar', path: childPointer(path, key), bytes: Buffer.byteLength(child) })
      else if (isScalar(child))
        children.push({ _tag: 'Scalar', key, value: child })
      else if (Array.isArray(child))
        children.push({ _tag: 'Collection', path: childPointer(path, key), total: child.length })
      else if (child !== null && typeof child === 'object')
        children.push({ _tag: 'Object', path: childPointer(path, key) })
      else
        return { _tag: 'Err', message: 'Evidence must contain JSON values.' }
    }
    const page = selectOutput(children, {
      limit: options.limit,
      offset: options.offset,
      pageBytes: options.pageBytes ?? DEFAULT_PAGE_BYTES,
      render: page => JSON.stringify(inspectObjectPage(path, page)),
    })
    return { _tag: 'Ok', value: inspectObjectPage(path, page) }
  }
  return { _tag: 'Err', message: 'Evidence must contain JSON values.' }
}
