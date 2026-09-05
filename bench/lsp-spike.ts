// Spike: rename + verify over the native TypeScript 7.1 LSP, compared with ts-morph.
// Run: TSGO=/path/to/tsc pnpm exec tsx bench/lsp-spike.ts
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { runRename } from '@ripast/core'
import { makeBenchFixture } from './fixture.ts'

const TSGO = process.env.TSGO ?? resolve('/tmp/claude-1000/-home-harlan-pkg-ripast/752e6eb4-3253-49b6-9e2d-09728da406cb/scratchpad/ts7/node_modules/@typescript/typescript-linux-x64/lib/tsc')

interface Pending { resolve: (v: any) => void, reject: (e: Error) => void }

interface Client {
  request: (method: string, params: unknown) => Promise<any>
  notify: (method: string, params: unknown) => void
  diagnostics: Map<string, any[]>
  kill: () => void
  serverCapabilities: any
}

export const SETTINGS: Record<string, unknown> = process.env.RIPAST_LSP_SETTINGS ? JSON.parse(process.env.RIPAST_LSP_SETTINGS) : {}

function connect(cwd: string): Promise<Client> {
  const proc: ChildProcessWithoutNullStreams = spawn(TSGO, ['--lsp', '--stdio'], { cwd, stdio: 'pipe' })
  let seq = 0
  const pending = new Map<number, Pending>()
  const diagnostics = new Map<string, any[]>()
  let buf = Buffer.alloc(0)

  const write = (msg: object) => {
    const body = Buffer.from(JSON.stringify(msg), 'utf8')
    proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`)
    proc.stdin.write(body)
  }

  const onMessage = (msg: any) => {
    if (msg.id !== undefined && msg.method) {
      // server -> client request: answer minimally
      let result: unknown = null
      if (msg.method === 'workspace/configuration')
        result = (msg.params?.items ?? []).map((it: any) => (it?.section && SETTINGS[it.section] !== undefined) ? SETTINGS[it.section] : SETTINGS)
      if (msg.method === 'client/registerCapability' || msg.method === 'window/workDoneProgress/create')
        result = null
      write({ jsonrpc: '2.0', id: msg.id, result })
      return
    }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (!p)
        return
      pending.delete(msg.id)
      if (msg.error)
        p.reject(new Error(`${msg.error.code}: ${msg.error.message}`))
      else p.resolve(msg.result)
      return
    }
    if (msg.method === 'textDocument/publishDiagnostics')
      diagnostics.set(msg.params.uri, msg.params.diagnostics)
  }

  proc.stdout.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    for (;;) {
      const headerEnd = buf.indexOf('\r\n\r\n')
      if (headerEnd === -1)
        return
      const header = buf.subarray(0, headerEnd).toString('utf8')
      const len = Number(/Content-Length: (\d+)/i.exec(header)?.[1] ?? 0)
      const start = headerEnd + 4
      if (buf.length < start + len)
        return
      const body = buf.subarray(start, start + len).toString('utf8')
      buf = buf.subarray(start + len)
      onMessage(JSON.parse(body))
    }
  })
  proc.stderr.on('data', (d: Buffer) => process.stderr.write(`[tsgo] ${d}`))

  const client: Client = {
    diagnostics,
    serverCapabilities: null,
    request(method, params) {
      const id = ++seq
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        write({ jsonrpc: '2.0', id, method, params })
      })
    },
    notify(method, params) {
      write({ jsonrpc: '2.0', method, params })
    },
    kill: () => proc.kill(),
  }

  return client.request('initialize', {
    processId: process.pid,
    initializationOptions: SETTINGS,
    rootUri: pathToFileURL(cwd).href,
    workspaceFolders: [{ uri: pathToFileURL(cwd).href, name: 'root' }],
    capabilities: {
      workspace: { workspaceEdit: { documentChanges: true }, diagnostics: {}, configuration: true },
      textDocument: {
        rename: { prepareSupport: false },
        diagnostic: { dynamicRegistration: false },
        publishDiagnostics: {},
      },
    },
  }).then((init) => {
    client.serverCapabilities = init.capabilities
    client.notify('initialized', {})
    return client
  })
}

function uriOf(abs: string): string {
  return pathToFileURL(abs).href
}

function openFile(client: Client, abs: string, text?: string): string {
  const uri = uriOf(abs)
  client.notify('textDocument/didOpen', {
    textDocument: { uri, languageId: 'typescript', version: 1, text: text ?? readFileSync(abs, 'utf8') },
  })
  return uri
}

function applyEdits(text: string, edits: { range: { start: { line: number, character: number }, end: { line: number, character: number } }, newText: string }[]): string {
  const lines = text.split('\n')
  const offsets: number[] = []
  let acc = 0
  for (const l of lines) {
    offsets.push(acc)
    acc += l.length + 1
  }
  const toOff = (p: { line: number, character: number }) => offsets[p.line] + p.character
  const sorted = [...edits].sort((a, b) => toOff(b.range.start) - toOff(a.range.start))
  let out = text
  for (const e of sorted)
    out = out.slice(0, toOff(e.range.start)) + e.newText + out.slice(toOff(e.range.end))
  return out
}

function collectEdits(edit: any): Map<string, any[]> {
  const byUri = new Map<string, any[]>()
  if (edit?.changes) {
    for (const [uri, edits] of Object.entries<any[]>(edit.changes))
      byUri.set(uri, [...(byUri.get(uri) ?? []), ...edits])
  }
  for (const dc of edit?.documentChanges ?? []) {
    if (dc.textDocument)
      byUri.set(dc.textDocument.uri, [...(byUri.get(dc.textDocument.uri) ?? []), ...dc.edits])
  }
  return byUri
}

async function lspRename(client: Client, abs: string, symbol: string, to: string) {
  const text = readFileSync(abs, 'utf8')
  const uri = openFile(client, abs, text)
  const lineIdx = text.split('\n').findIndex(l => l.includes(`function ${symbol}`) || l.includes(`const ${symbol}`))
  const character = text.split('\n')[lineIdx].indexOf(symbol)
  const t0 = performance.now()
  const edit = await client.request('textDocument/rename', {
    textDocument: { uri },
    position: { line: lineIdx, character },
    newName: to,
  })
  const ms = performance.now() - t0
  return { edits: collectEdits(edit), ms }
}

async function pullDiagnostics(client: Client, uris: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  await Promise.all(uris.map(async (uri) => {
    const r = await client.request('textDocument/diagnostic', { textDocument: { uri } })
    out.set(uri, (r?.items ?? []).filter((d: any) => d.severity === 1).length)
  }))
  return out
}

function ms(n: number): string {
  return `${n.toFixed(1)}ms`
}

async function lspScenario(label: string, cwd: string, declFile: string, symbol: string, to: string) {
  console.log(`\n== LSP ${label}`)
  const tSpawn = performance.now()
  const client = await connect(cwd)
  const tInit = performance.now()
  console.log(`  spawn+initialize        ${ms(tInit - tSpawn)}`)
  const caps = client.serverCapabilities
  console.log(`  caps: rename=${!!caps.renameProvider} diagnostic=${!!caps.diagnosticProvider} references=${!!caps.referencesProvider} codeAction=${!!caps.codeActionProvider} willRename=${!!caps.workspace?.fileOperations?.willRename}`)

  const abs = join(cwd, declFile)
  const cold = await lspRename(client, abs, symbol, to)
  console.log(`  rename (cold)           ${ms(cold.ms)}  files=${cold.edits.size} edits=${[...cold.edits.values()].reduce((a, b) => a + b.length, 0)}`)
  const warm = await lspRename(client, abs, symbol, to)
  console.log(`  rename (warm)           ${ms(warm.ms)}  files=${warm.edits.size}`)

  // verify: diagnostics before, apply in-memory, diagnostics after
  const uris = [...cold.edits.keys()]
  const tD0 = performance.now()
  for (const uri of uris) {
    if (uri !== uriOf(abs))
      openFile(client, new URL(uri).pathname)
  }
  const before = await pullDiagnostics(client, uris)
  const tD1 = performance.now()
  console.log(`  diagnostics before      ${ms(tD1 - tD0)}  (${uris.length} files, errors=${[...before.values()].reduce((a, b) => a + b, 0)})`)
  let version = 2
  for (const uri of uris) {
    const path = new URL(uri).pathname
    const next = applyEdits(readFileSync(path, 'utf8'), cold.edits.get(uri)!)
    client.notify('textDocument/didChange', { textDocument: { uri, version: version++ }, contentChanges: [{ text: next }] })
  }
  const tD2 = performance.now()
  const after = await pullDiagnostics(client, uris)
  const tD3 = performance.now()
  const regressions = uris.filter(u => (after.get(u) ?? 0) > (before.get(u) ?? 0)).length
  console.log(`  diagnostics after       ${ms(tD3 - tD2)}  regressions=${regressions}`)
  console.log(`  total (excl. spawn)     ${ms(tD3 - tInit)}`)
  console.log(`  total (incl. spawn)     ${ms(tD3 - tSpawn)}`)
  client.kill()
  return cold.edits
}

async function tsMorphScenario(label: string, cwd: string, symbol: string, to: string, verify: boolean) {
  const t0 = performance.now()
  const result = await runRename(symbol, to, { cwd, verify, vue: false })
  const t1 = performance.now()
  console.log(`== ts-morph ${label} verify=${verify}  ${ms(t1 - t0)}  files=${result.changes.length}`)
  return new Set(result.changes.map(c => uriOf(c.path)))
}

async function main() {
  const fixture = makeBenchFixture({ files: 500, importersPerSymbol: 160 })
  try {
    const lspFiles = await lspScenario('bench fixture (500 files)', fixture.dir, 'src/hot.ts', 'hotSymbol', 'hotSymbolRenamed')
    const tm1 = await tsMorphScenario('bench fixture', fixture.dir, 'hotSymbol', 'hotSymbolRenamed', false)
    const tm2 = await tsMorphScenario('bench fixture', fixture.dir, 'hotSymbol', 'hotSymbolRenamed', true)
    const onlyLsp = [...lspFiles.keys()].filter(u => !tm2.has(u))
    const onlyTm = [...tm2].filter(u => !lspFiles.has(u))
    console.log(`  parity: lsp-only=${onlyLsp.length} tsmorph-only=${onlyTm.length}`)
    void tm1
  }
  finally {
    fixture.cleanup()
  }

  const repo = resolve(import.meta.dirname, '..')
  const lspRepo = await lspScenario('ripast repo', repo, 'packages/core/src/rename.ts', 'runRename', 'runRename2')
  const tmRepo = await tsMorphScenario('ripast repo', repo, 'runRename', 'runRename2', true)
  const rel = (u: string) => new URL(u).pathname.replace(`${repo}/`, '')
  console.log(`  lsp-only: ${[...lspRepo.keys()].filter(u => !tmRepo.has(u)).map(rel).join(', ') || 'none'}`)
  console.log(`  tsmorph-only: ${[...tmRepo].filter(u => !lspRepo.has(u)).map(rel).join(', ') || 'none'}`)
}

export { collectEdits, connect, lspRename, openFile, uriOf }

if (process.argv[1] === import.meta.filename) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
