import type { Readable } from 'node:stream'
import type { EvidenceInspection, OutputPage } from './presentation/index.ts'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { inspectEvidence } from './presentation/index.ts'

type Request
  = | { _tag: 'Next' }
    | { _tag: 'Previous' }
    | { _tag: 'Select', path: string, offset: number }
    | { _tag: 'Close' }

type Parsed<T> = { _tag: 'Ok', value: T } | { _tag: 'Err', message: string }

function parseJson(text: string): Parsed<unknown> {
  // JSON syntax errors are expected input failures at this boundary.
  try {
    return { _tag: 'Ok', value: JSON.parse(text) }
  }
  catch {
    return { _tag: 'Err', message: 'Input must contain valid JSON.' }
  }
}

export function parsePageRequest(text: string): Parsed<Request> {
  if (Buffer.byteLength(text) > 4096)
    return { _tag: 'Err', message: 'Page requests must not exceed 4096 bytes.' }
  const parsed = parseJson(text)
  if (parsed._tag === 'Err')
    return parsed
  if (!parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value))
    return { _tag: 'Err', message: 'Page requests must be JSON objects.' }
  const request = parsed.value as Record<string, unknown>
  if (request._tag === 'Next' || request._tag === 'Previous' || request._tag === 'Close')
    return { _tag: 'Ok', value: { _tag: request._tag } }
  if (request._tag === 'Select' && typeof request.path === 'string') {
    const offset = request.offset ?? 0
    if (typeof offset === 'number' && Number.isSafeInteger(offset) && offset >= 0)
      return { _tag: 'Ok', value: { _tag: 'Select', path: request.path, offset } }
  }
  return { _tag: 'Err', message: 'Use Next, Previous, Select with a path and optional non-negative offset, or Close.' }
}

export interface EvidencePagerOptions {
  input: string
  path: string
  offset: number
  limit: number
  pageBytes: number
  session: boolean
  fields?: string[]
}

interface Dependencies {
  stdin: Readable
  read: (path: string) => string
  emit: (value: unknown, error?: boolean) => void
  render: (value: unknown) => string
}

function selectFields(page: OutputPage<unknown>, fields: string[] | undefined): Parsed<OutputPage<unknown>> {
  if (!fields)
    return { _tag: 'Ok', value: page }
  const results: unknown[] = []
  for (const row of page.results) {
    if (!row || typeof row !== 'object' || Array.isArray(row))
      return { _tag: 'Err', message: 'Field selection requires object results.' }
    const object = row as Record<string, unknown>
    for (const field of fields) {
      if (!Object.hasOwn(object, field))
        return { _tag: 'Err', message: `Unknown result field: ${field}.` }
    }
    results.push(Object.fromEntries(fields.map(field => [field, object[field]])))
  }
  return { _tag: 'Ok', value: { ...page, results } }
}

/** Read evidence once. Navigation never calls the original operation. */
export async function runEvidencePager(options: EvidencePagerOptions, dependencies: Dependencies): Promise<{ _tag: 'Complete' | 'Refused' }> {
  if (options.session && options.input === '-')
    throw new Error('Session navigation requires --input <file>. Stdin receives page requests.')
  let text: string
  if (options.input === '-') {
    const chunks: Buffer[] = []
    for await (const chunk of dependencies.stdin)
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    text = Buffer.concat(chunks).toString('utf8')
  }
  else {
    text = dependencies.read(options.input)
  }
  const parsed = parseJson(text)
  if (parsed._tag === 'Err') {
    dependencies.emit({ message: parsed.message }, true)
    return { _tag: 'Refused' }
  }
  const source = { input: options.input, sha256: createHash('sha256').update(text).digest('hex') }
  let state = { path: options.path, offset: options.offset, history: [] as number[] }
  let current: EvidenceInspection | undefined
  const inspect = (path: string, offset: number): boolean => {
    const result = inspectEvidence(parsed.value, path, {
      limit: options.limit,
      offset,
      pageBytes: options.pageBytes,
      render: (page) => {
        const selected = selectFields(page, options.fields)
        return dependencies.render(selected._tag === 'Err' ? { source, message: selected.message } : { source, view: { _tag: 'Collection', path, ...selected.value } })
      },
    })
    if (result._tag === 'Err') {
      dependencies.emit({ source, message: result.message }, true)
      return false
    }
    if (result.value._tag === 'Collection') {
      const selected = selectFields(result.value, options.fields)
      if (selected._tag === 'Err') {
        dependencies.emit({ source, message: selected.message }, true)
        return false
      }
      current = { ...result.value, ...selected.value }
    }
    else {
      current = result.value
    }
    dependencies.emit({ source, view: current })
    return true
  }
  if (!inspect(state.path, state.offset))
    return { _tag: 'Refused' }
  if (!options.session)
    return { _tag: 'Complete' }
  const lines = createInterface({ input: dependencies.stdin, crlfDelay: Infinity })
  try {
    for await (const line of lines) {
      const request = parsePageRequest(line)
      if (request._tag === 'Err') {
        dependencies.emit({ source, message: request.message }, true)
        continue
      }
      const value = request.value
      if (value._tag === 'Close') {
        dependencies.emit({ source, _tag: 'Closed' })
        break
      }
      if (value._tag === 'Select') {
        if (inspect(value.path, value.offset))
          state = { path: value.path, offset: value.offset, history: [] }
        continue
      }
      if (value._tag === 'Next') {
        const nextOffset = current && 'nextOffset' in current ? current.nextOffset : undefined
        if (nextOffset === undefined) {
          dependencies.emit({ source, message: 'No next page exists.' }, true)
          continue
        }
        if (inspect(state.path, nextOffset))
          state = { ...state, offset: nextOffset, history: [...state.history, state.offset] }
        continue
      }
      const previous = state.history.at(-1)
      if (previous === undefined) {
        dependencies.emit({ source, message: 'No previous page exists.' }, true)
        continue
      }
      if (inspect(state.path, previous))
        state = { ...state, offset: previous, history: state.history.slice(0, -1) }
    }
  }
  finally {
    lines.close()
    dependencies.stdin.pause()
  }
  return { _tag: 'Complete' }
}
