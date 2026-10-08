import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { posToLineCol } from './util.ts'

// Client for the native TypeScript language server (TypeScript 7+, `tsc --lsp`).
// Semantics (rename, references, definitions, diagnostics, file renames) come
// from the server. ripast owns candidate discovery, text edits, diffing, and
// verification policy.

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspTextEdit {
  range: LspRange
  newText: string
}

export interface LspDiagnostic {
  range: LspRange
  severity?: number
  code?: number | string
  message: string
}

export interface LspLocation {
  uri: string
  range: LspRange
}

/** A location resolved to a file path and character offsets in that file's current text. */
export interface SourceSite {
  path: string
  start: number
  end: number
  /** 1-based */
  line: number
  /** 1-based */
  col: number
}

export interface TsServer {
  /** Rename the symbol at `offset` in `path`. Returns absolute path -> edits against the current document text. */
  rename: (path: string, offset: number, newName: string) => Promise<Map<string, LspTextEdit[]>>
  /** Every reference to the symbol at `offset` in `path`, declaration included. */
  references: (path: string, offset: number) => Promise<SourceSite[]>
  /** Declaration sites of the symbol at `offset` in `path`. */
  definition: (path: string, offset: number) => Promise<SourceSite[]>
  /** Import rewrites the server would apply if `oldPath` moved to `newPath`. Keyed by absolute path. */
  willRenameFile: (oldPath: string, newPath: string) => Promise<Map<string, LspTextEdit[]>>
  /** Pull error diagnostics for `paths`. Files not yet open are opened with their on-disk text. */
  diagnostics: (paths: string[]) => Promise<Map<string, LspDiagnostic[]>>
  /** Open `path` with `text` (defaults to disk). Re-opening with new text updates the document. */
  open: (path: string, text?: string) => void
  /** Current text the server sees for `path`: the overlay if open, else disk. */
  textOf: (path: string) => string
  dispose: () => void
}

export interface TsServerOptions {
  /** Path to the native `tsc` binary. Defaults to the bundled `typescript-native` platform package. */
  binary?: string
  /** Configured project to load before serving refactor requests. */
  tsconfig?: string
}

const DEBUG = !!process.env.RIPAST_DEBUG

// ripast renames everywhere. By default the server keeps re-export names
// stable (`export { renamed as original }`) and leaves consumers untouched.
// Sent as initializationOptions (raw preference names) and as the answer to
// every workspace/configuration section (VS Code-style paths).
const PREFERENCES = {
  providePrefixAndSuffixTextForRename: false,
  preferences: { useAliasesForRenames: false },
}

export function resolveNativeTsc(): string {
  const override = process.env.RIPAST_NATIVE_TSC
  if (override)
    return override
  const platformPkg = `@typescript/typescript-${process.platform}-${process.arch}`
  let platformJson: string
  try {
    const pkgJson = createRequire(import.meta.url).resolve('typescript-native/package.json')
    platformJson = createRequire(pkgJson).resolve(`${platformPkg}/package.json`)
  }
  catch {
    throw new Error(`ripast: native TypeScript binary not found for ${process.platform}-${process.arch}. Install ${platformPkg}, or set RIPAST_NATIVE_TSC to a TypeScript 7 tsc binary.`)
  }
  const exe = join(dirname(platformJson), 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc')
  if (!existsSync(exe))
    throw new Error(`ripast: native TypeScript binary missing at ${exe}.`)
  return exe
}

interface Pending {
  resolve: (value: any) => void
  reject: (error: Error) => void
}

interface OpenDocument {
  version: number
  text: string
}

export async function startTsServer(cwd: string, opts: TsServerOptions = {}): Promise<TsServer> {
  const binary = opts.binary ?? resolveNativeTsc()
  const tsconfig = opts.tsconfig ? resolve(cwd, opts.tsconfig) : undefined
  const tsconfigText = tsconfig ? readFileSync(tsconfig, 'utf8') : undefined
  const preferences = tsconfig ? { ...PREFERENCES, customConfigFileName: basename(tsconfig) } : PREFERENCES
  const proc: ChildProcessWithoutNullStreams = spawn(binary, ['--lsp', '--stdio'], { cwd, stdio: 'pipe' })
  const pending = new Map<number, Pending>()
  const documents = new Map<string, OpenDocument>()
  const stderrTail: string[] = []
  let seq = 0
  let buffer = Buffer.alloc(0)
  let terminalError: Error | undefined

  const stop = (error: Error): void => {
    if (terminalError)
      return
    terminalError = error
    for (const entry of pending.values())
      entry.reject(error)
    pending.clear()
    // Cancel queued writes before terminating the reader on every platform.
    proc.stdin.destroy()
    proc.kill()
  }

  const write = (message: object): void => {
    if (terminalError)
      return
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    proc.stdin.write(body)
  }

  const stderrHint = (): string => stderrTail.length ? `: ${stderrTail.join(' ').trim()}` : ''

  const request = (method: string, params: unknown): Promise<any> => {
    if (terminalError)
      return Promise.reject(terminalError)
    const id = ++seq
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      write({ jsonrpc: '2.0', id, method, params })
    })
  }

  const notify = (method: string, params: unknown): void => {
    write({ jsonrpc: '2.0', method, params })
  }

  const onMessage = (message: any): void => {
    if (message.id !== undefined && message.method) {
      // Server -> client request. We hold no editor state beyond preferences.
      const result = message.method === 'workspace/configuration'
        ? (message.params?.items ?? []).map(() => preferences)
        : null
      write({ jsonrpc: '2.0', id: message.id, result })
      return
    }
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (!entry)
        return
      pending.delete(message.id)
      if (message.error)
        entry.reject(new Error(`ripast: TypeScript server error ${message.error.code}: ${message.error.message}`))
      else
        entry.resolve(message.result)
    }
  }

  proc.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1)
        return
      const header = buffer.subarray(0, headerEnd).toString('utf8')
      const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1] ?? 0)
      const start = headerEnd + 4
      if (buffer.length < start + length)
        return
      const body = buffer.subarray(start, start + length).toString('utf8')
      buffer = buffer.subarray(start + length)
      onMessage(JSON.parse(body))
    }
  })
  proc.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    if (DEBUG)
      process.stderr.write(`[ts-server] ${text}`)
    stderrTail.push(text)
    if (stderrTail.length > 5)
      stderrTail.shift()
  })
  proc.on('exit', (code) => {
    stop(new Error(`ripast: TypeScript server exited with code ${code}${stderrHint()}`))
  })
  proc.on('error', (error) => {
    stop(new Error(`ripast: could not start TypeScript server at ${binary}: ${error.message}`))
  })
  proc.stdin.on('error', (error) => {
    // A queued write can fail after disposal. Its requests already have the terminal error.
    stop(new Error(`ripast: TypeScript server input failed: ${error.message}${stderrHint()}`))
  })

  await request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(cwd).href,
    workspaceFolders: [{ uri: pathToFileURL(cwd).href, name: 'ripast' }],
    initializationOptions: preferences,
    capabilities: {
      workspace: {
        workspaceEdit: { documentChanges: true },
        configuration: true,
        fileOperations: { willRename: true },
      },
      textDocument: {
        rename: { prepareSupport: false },
        diagnostic: { dynamicRegistration: false },
      },
    },
  })
  notify('initialized', {})
  // The server pulls preferences through workspace/configuration while handling
  // `initialized`, and processes messages in order, so later requests see them.

  const textOf = (path: string): string => documents.get(path)?.text ?? readFileSync(path, 'utf8')

  const open = (path: string, text?: string): void => {
    const existing = documents.get(path)
    if (!existing) {
      const content = text ?? readFileSync(path, 'utf8')
      documents.set(path, { version: 1, text: content })
      notify('textDocument/didOpen', {
        textDocument: { uri: uriOf(path), languageId: languageIdOf(path), version: 1, text: content },
      })
      return
    }
    // Already open and no new text: keep the current overlay. Re-reading disk
    // here would silently undo an in-memory change.
    if (text === undefined || existing.text === text)
      return
    existing.version++
    existing.text = text
    notify('textDocument/didChange', {
      textDocument: { uri: uriOf(path), version: existing.version },
      contentChanges: [{ text }],
    })
  }

  const positionOf = (path: string, offset: number): LspPosition => {
    const { line, col } = posToLineCol(textOf(path), offset)
    return { line: line - 1, character: col - 1 }
  }

  const toSites = (locations: LspLocation[] | null | undefined): SourceSite[] => {
    const texts = new Map<string, string>()
    const out: SourceSite[] = []
    for (const location of locations ?? []) {
      if (!location.uri.startsWith('file:'))
        continue
      const path = resolve(cwd, relative(cwd, pathOf(location.uri)))
      let text = texts.get(path)
      if (text === undefined) {
        try {
          text = textOf(path)
        }
        catch {
          continue
        }
        texts.set(path, text)
      }
      out.push({
        path,
        start: offsetOfPosition(text, location.range.start),
        end: offsetOfPosition(text, location.range.end),
        line: location.range.start.line + 1,
        col: location.range.start.character + 1,
      })
    }
    return out
  }

  if (tsconfig) {
    // Pulling config diagnostics loads its project, even when the source sits outside the config directory.
    open(tsconfig, tsconfigText)
    await request('textDocument/diagnostic', { textDocument: { uri: uriOf(tsconfig) } }).catch((error) => {
      stop(error)
      throw error
    })
  }

  return {
    async rename(path, offset, newName) {
      open(path)
      const edit = await request('textDocument/rename', {
        textDocument: { uri: uriOf(path) },
        position: positionOf(path, offset),
        newName,
      })
      return workspaceEditByPath(edit, cwd)
    },
    async references(path, offset) {
      open(path)
      const locations = await request('textDocument/references', {
        textDocument: { uri: uriOf(path) },
        position: positionOf(path, offset),
        context: { includeDeclaration: true },
      })
      return toSites(locations)
    },
    async definition(path, offset) {
      open(path)
      const result = await request('textDocument/definition', {
        textDocument: { uri: uriOf(path) },
        position: positionOf(path, offset),
      })
      const locations: LspLocation[] = Array.isArray(result)
        ? result.map((r: any) => r.targetUri ? { uri: r.targetUri, range: r.targetSelectionRange ?? r.targetRange } : r)
        : result ? [result] : []
      return toSites(locations)
    },
    async willRenameFile(oldPath, newPath) {
      open(oldPath)
      const edit = await request('workspace/willRenameFiles', {
        files: [{ oldUri: uriOf(oldPath), newUri: uriOf(newPath) }],
      })
      return workspaceEditByPath(edit, cwd)
    },
    async diagnostics(paths) {
      const out = new Map<string, LspDiagnostic[]>()
      await Promise.all(paths.map(async (path) => {
        open(path)
        const report = await request('textDocument/diagnostic', { textDocument: { uri: uriOf(path) } })
        const items = ((report?.items ?? []) as LspDiagnostic[]).filter(d => (d.severity ?? 1) === 1)
        out.set(path, items)
      }))
      return out
    },
    open,
    textOf,
    dispose() {
      stop(new Error('ripast: TypeScript server disposed.'))
    },
  }
}

export function uriOf(path: string): string {
  return pathToFileURL(path).href
}

export function pathOf(uri: string): string {
  return fileURLToPath(uri)
}

function languageIdOf(path: string): string {
  if (path.endsWith('.json'))
    return 'json'
  if (path.endsWith('.tsx'))
    return 'typescriptreact'
  if (path.endsWith('.jsx'))
    return 'javascriptreact'
  if (/\.[cm]?js$/.test(path))
    return 'javascript'
  return 'typescript'
}

function workspaceEditByPath(edit: any, cwd: string): Map<string, LspTextEdit[]> {
  const byPath = new Map<string, LspTextEdit[]>()
  const add = (uri: string, edits: LspTextEdit[]): void => {
    const path = resolve(cwd, relative(cwd, pathOf(uri)))
    byPath.set(path, [...(byPath.get(path) ?? []), ...edits])
  }
  for (const [uri, edits] of Object.entries<LspTextEdit[]>(edit?.changes ?? {}))
    add(uri, edits)
  for (const change of edit?.documentChanges ?? []) {
    if (change.textDocument)
      add(change.textDocument.uri, change.edits)
  }
  return byPath
}

function lineStartsOf(text: string): number[] {
  const lineStarts: number[] = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10)
      lineStarts.push(i + 1)
  }
  return lineStarts
}

/** Character offset of an LSP (UTF-16 line/character) position in `text`. */
export function offsetOfPosition(text: string, position: LspPosition): number {
  const lineStarts = lineStartsOf(text)
  return (lineStarts[position.line] ?? text.length) + position.character
}

/** Apply LSP edits (UTF-16 line/character ranges) to `text`. */
export function applyLspEdits(text: string, edits: LspTextEdit[]): string {
  if (!edits.length)
    return text
  const lineStarts = lineStartsOf(text)
  const offsetOf = (pos: LspPosition): number => (lineStarts[pos.line] ?? text.length) + pos.character
  const sorted = [...edits].sort((a, b) => offsetOf(b.range.start) - offsetOf(a.range.start))
  let out = text
  for (const edit of sorted)
    out = out.slice(0, offsetOf(edit.range.start)) + edit.newText + out.slice(offsetOf(edit.range.end))
  return out
}
