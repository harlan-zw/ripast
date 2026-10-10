import type { CommandDef } from 'citty'
import type { ExportFilter, ProfileSink, Verification, VerifyMode } from 'ripide-api'
import type { JsonResult, JsonTag } from './json.ts'
import type { OutputPage, TextOutput } from './presentation/index.ts'
import type { InlineTestError } from './test-result.ts'
import { Buffer } from 'node:buffer'
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs, renderUsage, runCommand } from 'citty'
import {
  buildChangeManifest,
  buildComponentDetail,
  buildComponentInventory,
  buildDeclarationTree,
  buildDoctorFixes,
  buildScanGraph,
  buildUnusedDeclarations,
  getChangedFiles,
  getDoctorCheckNames,
  resolveVerifyMode,
  runCssClassFileScan,
  runCssClassRename,
  runCssClassScan,
  runDoctor,
  scan,
  writeChanges,
} from 'ripide-api'
import { agent, isAgent } from 'std-env'
import { runCheck } from './check.ts'
import { defineStrictCommand as defineCommand } from './command.ts'
import { createCliEngine, discoverCliAdapters, loadVueOperations } from './engine.ts'
import { runEvidencePager } from './evidence-pager.ts'
import { jsonResult, mutationTag } from './json.ts'
import {
  compactVerification,
  createTextOutput,
  formatAgentDeclarationTree,
  formatAgentDoctorReport,
  formatAgentFileScanHits,
  formatAgentHits,
  formatAgentInventory,
  formatAgentScanHits,
  formatDeclarationTree,
  formatDetail,
  formatDoctorReport,
  formatFileScanHits,
  formatHits,
  formatInventory,
  formatOutputPage,
  formatScanGraph,
  formatScanHits,
  formatUnusedDeclarations,
  formatVerification,
  outputPath,
  parseOutputBytes,
  parsePageBytes,
  printDiffs,
  renderBoundedOutput,
  selectDoctorFindings,
  selectOutput,
  summarize,
} from './presentation/index.ts'
import { MAX_TEST_SOURCE_BYTES } from './test-result.ts'

export type { JsonResult, JsonTag } from './json.ts'

const globArg = { type: 'string' as const, description: 'File glob(s), comma-separated. Prefix with ! to exclude (e.g. "*.ts,!.nuxt/**,!**/*.d.ts"). Defaults to *.ts,*.tsx,*.vue,...' }

function splitGlobs(value: string): string[] {
  const globs: string[] = []
  let start = 0
  let braces = 0
  let characterClass = false
  let escaped = false
  for (let index = 0; index < value.length; index++) {
    const character = value[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (character === '[') {
      characterClass = true
    }
    else if (character === ']') {
      characterClass = false
    }
    else if (!characterClass) {
      if (character === '{') {
        braces++
      }
      else if (character === '}') {
        braces--
      }
      else if (character === ',' && braces === 0) {
        globs.push(value.slice(start, index))
        start = index + 1
      }
    }
  }
  globs.push(value.slice(start))
  return globs
}
const applyArg = { type: 'boolean' as const, default: false, description: 'Write changes. Default prints a unified diff.' }
const verifyModeArg = { type: 'string' as const, description: 'Verification mode: touched, project, or none. Defaults to touched.' }
const vueArg = { type: 'boolean' as const, default: true, description: 'Enable Vue support. Use --no-vue for projects without authored Vue files.' }
const jsonArg = { type: 'boolean' as const, default: false, description: 'Emit machine-readable JSON (suppresses diff/summary text).' }
const profileArg = { type: 'string' as const, description: 'Output profile: auto, agent, or full. Auto detects agents for text. JSON auto uses the compact agent profile.' }

const outputArgs = {
  'timings': { type: 'boolean' as const, default: false, description: 'Emit phase durations as stderr JSON lines.' },
  'limit': { type: 'string' as const, description: 'Maximum displayed results. Agent default: 40. Does not restrict discovery or verification.' },
  'max-bytes': { type: 'string' as const, description: 'Maximum stdout bytes. Agent default: 32768. Minimum: 1024. Does not restrict operations or artifacts.' },
  'page-bytes': { type: 'string' as const, description: 'Target bytes per result page. Agent default: 4096. Minimum: 1024. Keeps at least one result.' },
  'offset': { type: 'string' as const, description: 'Skip displayed results. Repeat with a later offset to retrieve omitted results.' },
  'file': { type: 'string' as const, description: 'Display results for this project-relative file only.' },
  'code': { type: 'string' as const, description: 'Display diagnostics with this numeric TypeScript code.' },
  'fields': { type: 'string' as const, description: 'Requires --json. Comma-separated result fields for JSON discovery output.' },
  'minify': { type: 'boolean' as const, default: false, description: 'Requires --json. Emit JSON without indentation.' },
  'artifact': { type: 'string' as const, description: 'Requires --json. Create a new JSON evidence file. Mutations save plans and verification receipts before apply. Stdout reports the apply outcome.' },
}

type OutputArgs = Record<string, unknown> & { textOutput?: TextOutput }
function textSink(args: OutputArgs): { write: (text: string) => unknown } {
  return args.textOutput ?? process.stdout
}
function writeText(args: OutputArgs, text: string): void {
  textSink(args).write(text)
}
function phaseSink(args: OutputArgs): ProfileSink | undefined {
  return args.timings ? event => process.stderr.write(`${JSON.stringify(event)}\n`) : undefined
}
function selection(args: OutputArgs, agentProfile: boolean, defaultLimit = 40) {
  return { limit: args.limit == null ? agentProfile ? defaultLimit : undefined : Number(args.limit), offset: args.offset == null ? 0 : Number(args.offset), file: args.file as string | undefined, pageBytes: parsePageBytes(args['page-bytes'], agentProfile) }
}
function agentFilePage<T extends { rel: string }>(changes: readonly T[], args: OutputArgs): OutputPage<T> {
  return selectOutput(changes, {
    ...selection(args, true),
    render: page => `${formatOutputPage(page)}\n${page.results.map(change => `  ${change.rel}`).join('\n')}`,
  }, change => change.rel)
}
function selectedFields(items: unknown[], args: OutputArgs) {
  if (!args.fields)
    return items
  const fields = String(args.fields).split(',')
  return items.map((item) => {
    if (!item || typeof item !== 'object')
      throw new Error('Field selection requires object results.')
    const data = item as Record<string, unknown>
    for (const field of fields) {
      if (!Object.hasOwn(data, field))
        throw new Error(`Unknown result field: ${field}.`)
    }
    return Object.fromEntries(fields.map(field => [field, data[field]]))
  })
}
function canonicalDestination(path: string): string {
  let parent = dirname(resolve(path))
  const parts = [basename(path)]
  while (!existsSync(parent)) {
    parts.unshift(basename(parent))
    const next = dirname(parent)
    if (next === parent)
      throw new Error(`Cannot resolve artifact parent: ${path}.`)
    parent = next
  }
  const canonical = join(realpathSync(parent), ...parts)
  return process.platform === 'win32' || process.platform === 'darwin' ? canonical.toLowerCase() : canonical
}
function rejectArtifactCollision(args: OutputArgs, protectedPaths: string[] = []): void {
  if (!args.artifact)
    return
  const path = resolve(String(args.artifact))
  if (lstatSync(path, { throwIfNoEntry: false }))
    throw new Error('Artifact path already exists. Choose a new evidence file outside the change paths.')
  const artifact = canonicalDestination(path)
  if (protectedPaths.some(path => canonicalDestination(path) === artifact))
    throw new Error('Artifact path matches a change path. Choose a separate evidence file.')
}
function saveArtifact(args: OutputArgs, full: unknown, protectedPaths: string[] = []): void {
  if (args.artifact) {
    rejectArtifactCollision(args, protectedPaths)
    writeFileSync(resolve(String(args.artifact)), `${JSON.stringify(full, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
}
function serializeJson(value: unknown, args: OutputArgs): string {
  const compact = resolveProfile(args.profile, !!args.json).agentProfile
  return `${JSON.stringify(value, null, args.minify || compact ? undefined : 2)}\n`
}
function omittedJson(tag: JsonTag, command: string, base: string, args: OutputArgs, bytes: number, maxBytes: number | undefined): JsonResult {
  return jsonResult(tag, command, base, {
    output: { _tag: 'Omitted', bytes, maxBytes, ...(args.artifact ? { artifact: resolve(String(args.artifact)) } : {}) },
    next: command === 'page'
      ? 'Use --fields, select a deeper --path, or increase --max-bytes. Read saved evidence without repeating its operation.'
      : 'Use --limit, --offset, --file, --fields, or increase --max-bytes. Save complete evidence with --json --artifact <new-file.json>.',
  })
}
function preflightJsonOutput(args: OutputArgs, maxBytes: number | undefined): void {
  if (!args.json || maxBytes === undefined)
    return
  // Reserve the longest outcome tag and byte count before an operation can apply.
  const fallback = omittedJson('Refused', String(args.command), process.cwd(), args, Number.MAX_SAFE_INTEGER, maxBytes)
  const required = Buffer.byteLength(serializeJson(fallback, args))
  if (required > maxBytes)
    throw new Error(`Output metadata requires at least ${required} bytes. Increase --max-bytes.`)
}
function emitJson(payload: unknown, args: OutputArgs, full = payload, artifact: 'save' | 'saved' = 'save', tag: JsonTag = 'Result'): void {
  if (artifact === 'save')
    saveArtifact(args, full)
  const result = jsonResult(tag, String(args.command ?? 'ripide'), process.cwd(), payload)
  const compact = resolveProfile(args.profile, !!args.json).agentProfile
  const maxBytes = parseOutputBytes(args['max-bytes'], compact)
  process.stdout.write(renderBoundedOutput(result, {
    maxBytes,
    render: value => serializeJson(value, args),
    omitted: bytes => serializeJson(omittedJson(tag, result.command, result.base, args, bytes, maxBytes), args),
  }))
}
function discoveryJson<T>(results: T[], args: OutputArgs, file?: (item: T) => string, full: unknown = results) {
  const agentProfile = resolveProfile(args.profile, !!args.json).agentProfile
  if (!agentProfile && args.limit == null && args.offset == null && args.file == null && args.fields == null && args['page-bytes'] == null) {
    emitJson(full, args, full)
    return
  }
  const page = selectOutput(results, { ...selection(args, agentProfile), render: page => serializeJson(jsonResult('Result', String(args.command), process.cwd(), { ...page, results: selectedFields(page.results, args) }), args) }, file)
  emitJson({ ...page, results: selectedFields(page.results, args) }, args, full)
}
function diagnostics(r: MutatingResult, args: OutputArgs, agentProfile: boolean) {
  const all = [...r.regressions].map(d => ({ ...d, file: agentProfile ? outputPath(d.file, process.cwd()) : d.file })).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col || a.code - b.code || a.message.localeCompare(b.message))
  const filtered = args.code == null ? all : all.filter(d => d.code === Number(args.code))
  return { ...selectOutput(filtered, selection(args, agentProfile, 20), d => agentProfile ? d.file : outputPath(d.file, process.cwd())), total: all.length }
}
function fullPageText(rendered: string, page: OutputPage<unknown>, unit: 'hits' | 'files' | 'findings', args: OutputArgs): string {
  if (args.limit == null && args.offset == null && args.file == null && args['page-bytes'] == null)
    return rendered
  const displayed = page.shown ? rendered.trimEnd() : `No ${unit} on this page.`
  return [`project total: ${page.total} ${unit}`, `displayed ${unit}:`, displayed, formatOutputPage(page)].join('\n')
}
function diagnosticText(r: MutatingResult, args: OutputArgs, agentProfile: boolean): string {
  const page = diagnostics(r, args, agentProfile)
  return [`regressions: ${r.regressions.length}`, ...page.results.map(d => `  ${d.file}:${d.line}:${d.col} TS${d.code} ${d.message}`), formatOutputPage(page), ...(page.omitted ? ['Retrieve more with --offset, --limit, --file, or --code.'] : [])].join('\n')
}

type OutputProfile = 'auto' | 'agent' | 'full'
type GraphFormat = 'mermaid' | 'dot'

function resolveProfile(raw: unknown, json = false): { profile: OutputProfile, agentProfile: boolean } {
  const profile = (raw as OutputProfile | undefined) ?? 'auto'
  if (profile !== 'auto' && profile !== 'agent' && profile !== 'full') {
    throw new Error(`ripide: --profile must be "auto", "agent", or "full".`)
  }
  return { profile, agentProfile: profile === 'agent' || (profile === 'auto' && (json || isAgent)) }
}

function resolveGraphFormat(raw: unknown): GraphFormat {
  if (raw !== 'mermaid' && raw !== 'dot') {
    throw new Error(`ripide scan: --graph must be "mermaid" or "dot".`)
  }
  return raw
}

function profileHeader(): string {
  return `# profile: agent${agent ? ` (${agent})` : ''}`
}

function resolveCliVerifyMode(verifyMode: unknown, defaultMode: VerifyMode = 'touched'): VerifyMode {
  if (verifyMode != null) {
    if (verifyMode !== 'none' && verifyMode !== 'touched' && verifyMode !== 'project') {
      throw new Error(`ripide: --verify-mode must be "none", "touched", or "project".`)
    }
    return verifyMode
  }
  return resolveVerifyMode(defaultMode)
}

// Recover from agent quoting bugs where two positional paths get smushed into
// `old`, leaving `new` empty (e.g. `rename-file "A.vue B.vue"` instead of two
// args). Splits on whitespace, comma, or `:` when the literal `old` is missing
// but the split halves resolve to a real source file + a non-existent target.
function recoverSmushedPair(oldArg: string, newArg: string): { old: string, new: string, warning?: string } {
  const cwd = process.cwd()
  const oldExists = !!oldArg && existsSync(resolve(cwd, oldArg))
  if (oldExists && newArg)
    return { old: oldArg, new: newArg }
  if (!oldArg)
    return { old: oldArg, new: newArg }
  const candidates: [string, string][] = []
  for (const sep of [/\s+/, /\s*,\s*/, /\s*:\s*/]) {
    const parts = oldArg.split(sep).filter(Boolean)
    if (parts.length === 2)
      candidates.push([parts[0]!, parts[1]!])
  }
  for (const [a, b] of candidates) {
    if (existsSync(resolve(cwd, a)) && !existsSync(resolve(cwd, b))) {
      return {
        old: a,
        new: b,
        warning: `recovered smushed positional args: treating "${oldArg}" as old="${a}" new="${b}". Quote each path separately next time.`,
      }
    }
  }
  return { old: oldArg, new: newArg }
}

function resolveExportFilter(raw: unknown): ExportFilter {
  if (raw !== 'all' && raw !== 'exported' && raw !== 'local') {
    throw new Error(`ripide: --exports must be "all", "exported", or "local".`)
  }
  return raw
}

const scanCmd = defineCommand({
  meta: { name: 'scan', description: 'Find candidate files and classify identifier occurrences with the AST.' },
  args: {
    pattern: { type: 'positional', required: true },
    glob: globArg,
    kind: { type: 'string', description: 'Filter to kind(s), comma-separated. Kinds: identifier-reference, identifier-binding, import-specifier, member-access, property, jsx, string-literal, label.' },
    graph: { type: 'string', description: 'Emit a dependency graph for hit files: mermaid or dot.' },
    profile: profileArg,
    ...outputArgs,
    json: { type: 'boolean', default: false },
  },
  async run({ args }) {
    const sdk = await createCliEngine(process.cwd(), args.vue !== false)
    const engine = sdk.services
    const { agentProfile } = resolveProfile(args.profile, !!args.json)
    const opts = {
      engine,
      profile: phaseSink(args),
      glob: args.glob ? splitGlobs(args.glob as string) : undefined,
      kinds: args.kind ? (args.kind as string).split(',') : undefined,
    }
    if (args.graph) {
      const graphFormat = resolveGraphFormat(args.graph)
      const graph = buildScanGraph(args.pattern as string, opts)
      graph.nodes.sort((a, b) => a.file.localeCompare(b.file))
      const page = selectOutput(graph.nodes, selection(args, agentProfile), node => node.file)
      const selected = new Set(page.results.map(node => node.file))
      const edges = graph.edges.filter(edge => selected.has(edge.from) && selected.has(edge.to))
      const prefix = graphFormat === 'dot' ? '// ' : '%% '
      const displayed = { ...graph, nodes: page.results, edges }
      writeText(args, renderBoundedOutput(displayed, {
        maxBytes: parseOutputBytes(args['max-bytes'], agentProfile),
        render: value => `${prefix}nodes: ${formatOutputPage(page)}, omitted edges: ${graph.edges.length - edges.length}\n${formatScanGraph(value, graphFormat)}\n`,
        omitted: bytes => `${prefix}Graph omitted: ${bytes} bytes exceed the output budget.\n${prefix}Use --limit, --file, or increase --max-bytes.\n${formatScanGraph({ ...graph, nodes: [], edges: [] }, graphFormat)}\n`,
      }))
      return
    }
    const hits = scan(args.pattern as string, opts).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col || a.kind.localeCompare(b.kind))
    if (args.json) {
      discoveryJson(hits, args, hit => hit.file)
      return
    }
    const page = selectOutput(hits, selection(args, agentProfile), hit => hit.file)
    if (agentProfile) {
      writeText(args, `${profileHeader()}\n${formatAgentHits(hits, selection(args, true))}\n`)
      return
    }
    writeText(args, `${fullPageText(formatHits(page.results, false), page, 'hits', args)}\n`)
  },
})

const renameCmd = defineCommand({
  meta: { name: 'rename', description: 'Scope-aware symbol rename via the native TypeScript server (handles type-only imports, shadowing, JSX).' },
  args: {
    from: { type: 'positional', required: true },
    to: { type: 'positional', required: true },
    tsconfig: { type: 'string' },
    glob: globArg,
    apply: applyArg,
    verifyMode: verifyModeArg,
    scope: { type: 'string', description: 'Restrict to a single file when multiple files declare the same name.' },
    all: { type: 'boolean', default: false, description: 'Rename declarations in every file that defines the name (bypasses ambiguity check).' },
    vue: vueArg,
    profile: profileArg,
    ...outputArgs,
    json: jsonArg,
  },
  async run({ args }) {
    const sdk = await createCliEngine(process.cwd(), args.vue !== false)
    const verifyMode = resolveCliVerifyMode(args.verifyMode)
    const r = await sdk.rename(args.from as string, args.to as string, {
      profile: phaseSink(args),
      tsconfig: args.tsconfig as string | undefined,
      glob: args.glob ? splitGlobs(args.glob as string) : undefined,
      verifyMode,
      scope: args.scope as string | undefined,
      allowMultiple: args.all as boolean,
    })
    emitResult(r, !!args.apply, !!args.json, resolveProfile(args.profile, !!args.json).agentProfile, args)
  },
})

const replaceCmd = defineCommand({
  meta: { name: 'replace', description: 'Replace an imported symbol with another project export; updates imports and call sites.' },
  args: {
    'from': { type: 'positional', required: true },
    'to': { type: 'positional', required: true },
    'glob': globArg,
    'target-scope': { type: 'string', description: 'Restrict target symbol resolution to a single file when multiple files export the same name.' },
    'source-scope': { type: 'string', description: 'Select the source export by provider file and preserve local aliases.' },
    'target-import': { type: 'string', description: 'Import specifier for the validated replacement, including framework aliases.' },
    'apply': applyArg,
    'verifyMode': { ...verifyModeArg, description: 'Verification mode: touched, project, or none. Defaults to project.' },
    'profile': profileArg,
    ...outputArgs,
    'json': jsonArg,
  },
  async run({ args }) {
    const sdk = await createCliEngine(process.cwd(), args.vue !== false)
    const verifyMode = resolveCliVerifyMode(args.verifyMode, 'project')
    const r = await sdk.replace(args.from as string, args.to as string, {
      profile: phaseSink(args),
      glob: args.glob ? splitGlobs(args.glob as string) : undefined,
      verifyMode,
      targetScope: args['target-scope'] as string | undefined,
      sourceScope: args['source-scope'] as string | undefined,
      targetImport: args['target-import'] as string | undefined,
    })
    emitResult(r, !!args.apply, !!args.json, resolveProfile(args.profile, !!args.json).agentProfile, args)
  },
})

const treeCmd = defineCommand({
  meta: { name: 'tree', description: 'Print a project declaration tree from top-level AST declarations, grouped by file.' },
  args: {
    glob: globArg,
    declarations: { type: 'boolean', default: false, description: 'Page individual declarations. Limit and offset count declarations instead of files.' },
    exports: { type: 'string', description: 'Declaration filter: all, exported, or local. Defaults to exported for detected agents, all otherwise.' },
    profile: profileArg,
    ...outputArgs,
    json: jsonArg,
  },
  async run({ args }) {
    const sdk = await createCliEngine(process.cwd(), args.vue !== false)
    const engine = sdk.services
    const { agentProfile } = resolveProfile(args.profile, !!args.json)
    const exportFilter = args.exports == null
      ? agentProfile ? 'exported' : 'all'
      : resolveExportFilter(args.exports)
    const tree = buildDeclarationTree({ engine, profile: phaseSink(args), glob: args.glob ? splitGlobs(args.glob as string) : undefined, exports: agentProfile ? 'all' : exportFilter })
    tree.files.sort((a, b) => a.file.localeCompare(b.file))
    const filtered = { files: tree.files.map(file => ({ ...file, declarations: file.declarations.filter(declaration => exportFilter === 'all' || (exportFilter === 'exported') === declaration.exported) })) }
    if (args.declarations) {
      const declarations = filtered.files.flatMap(file => [...file.declarations]
        .sort((a, b) => a.line - b.line || a.col - b.col || a.name.localeCompare(b.name))
        .map(declaration => ({ file: file.file, ...declaration })))
      if (args.json) {
        discoveryJson(declarations, { ...args, limit: args.limit ?? (agentProfile ? 40 : declarations.length) }, declaration => declaration.file, filtered)
        return
      }
      const page = selectOutput(declarations, selection(args, agentProfile), declaration => declaration.file)
      const lines = page.results.map(declaration => `${declaration.file}:${declaration.line}:${declaration.col} ${declaration.exported ? 'export' : 'local'} ${declaration.kind} ${declaration.signature ?? declaration.name}`)
      writeText(args, `${lines.join('\n')}\n${formatOutputPage(page)}\n`)
      return
    }
    if (args.json) {
      discoveryJson(filtered.files, args, file => file.file, filtered)
      return
    }
    const page = selectOutput(tree.files, selection(args, agentProfile), file => file.file)
    if (agentProfile) {
      writeText(args, `${profileHeader()}\n`)
      writeText(args, `${formatAgentDeclarationTree({ files: page.results }, exportFilter)}\n${formatOutputPage(page)}\n`)
      return
    }
    writeText(args, `${fullPageText(formatDeclarationTree({ files: page.results }, false), page, 'files', args)}\n`)
  },
})

const unusedCmd = defineCommand({
  meta: { name: 'unused', description: 'Find unreferenced top-level declarations.' },
  args: {
    glob: globArg,
    exports: { type: 'string', description: 'Declaration filter: all, exported, or local. Defaults to exported.' },
    profile: profileArg,
    ...outputArgs,
    json: jsonArg,
  },
  async run({ args }) {
    const sdk = await createCliEngine(process.cwd(), args.vue !== false)
    const engine = sdk.services
    const exportFilter = args.exports == null ? 'exported' : resolveExportFilter(args.exports)
    const unused = await buildUnusedDeclarations({ engine, profile: phaseSink(args), glob: args.glob ? splitGlobs(args.glob as string) : undefined, exports: exportFilter })
    const { agentProfile } = resolveProfile(args.profile, !!args.json)
    const declarations = unused.files.flatMap(file => file.declarations.map(declaration => ({ file: file.file, ...declaration })))
    if (args.json) {
      discoveryJson(declarations, args, declaration => declaration.file, unused)
      return
    }
    const page = selectOutput(declarations, selection(args, agentProfile), declaration => declaration.file)
    const files = [...new Set(page.results.map(d => d.file))].map(file => ({ file, declarations: page.results.filter(d => d.file === file) }))
    writeText(args, `${formatUnusedDeclarations({ ...unused, files }, false)}\n${formatOutputPage(page)}\n`)
  },
})

const moveCmd = defineCommand({
  meta: { name: 'move', description: 'Move a top-level exported symbol between files; rewrites import sites project-wide.' },
  args: {
    symbol: { type: 'positional', required: true },
    from: { type: 'string', required: true, description: 'Source file path.' },
    to: { type: 'string', required: true, description: 'Target file path (created if missing).' },
    tsconfig: { type: 'string' },
    apply: applyArg,
    verifyMode: verifyModeArg,
    vue: vueArg,
    profile: profileArg,
    ...outputArgs,
    json: jsonArg,
  },
  async run({ args }) {
    const sdk = await createCliEngine(process.cwd(), args.vue !== false)
    const verifyMode = resolveCliVerifyMode(args.verifyMode)
    const r = await sdk.move(args.symbol as string, args.from as string, args.to as string, {
      profile: phaseSink(args),
      tsconfig: args.tsconfig as string | undefined,
      verifyMode,
    })
    emitResult(r, !!args.apply, !!args.json, resolveProfile(args.profile, !!args.json).agentProfile, args)
  },
})

const deleteCmd = defineCommand({
  meta: { name: 'delete', description: 'Delete an unused top-level declaration from a file; refuses if references remain.' },
  args: {
    symbol: { type: 'positional', required: true },
    from: { type: 'string', required: true, description: 'Source file path.' },
    apply: applyArg,
    verifyMode: verifyModeArg,
    profile: profileArg,
    ...outputArgs,
    json: jsonArg,
  },
  async run({ args }) {
    const sdk = await createCliEngine(process.cwd(), args.vue !== false)
    const verifyMode = resolveCliVerifyMode(args.verifyMode)
    const r = await sdk.delete(args.symbol as string, args.from as string, {
      profile: phaseSink(args),
      verifyMode,
    })
    emitResult(r, !!args.apply, !!args.json, resolveProfile(args.profile, !!args.json).agentProfile, args)
  },
})

interface MutatingResult {
  changes: { path: string, rel: string, before: string, after: string }[]
  scanned: number
  verification: Verification
  regressions: { file: string, line: number, col: number, code: number, message: string }[]
  warnings?: string[]
}

function compactMutationResult(r: MutatingResult, manifest = buildChangeManifest(r.changes), args: OutputArgs = {}) {
  const { results: changes, ...changePage } = selectOutput(manifest.changes, selection(args, true), c => c[0])
  const { results: regressions, ...diagnosticPage } = diagnostics(r, args, true)
  return {
    verification: compactVerification(r.verification),
    ...(r.regressions.length ? { regressions, diagnosticPage } : {}),
    ...(r.warnings?.length ? { warnings: r.warnings } : {}),
    ...manifest,
    changes,
    changePage,
  }
}

function emitResult(r: MutatingResult, apply: boolean, json: boolean = false, agentProfile: boolean = false, args: OutputArgs = {}): void {
  const s = summarize(r.changes)
  const warnings = r.warnings ?? []
  if (json) {
    const blockedByRegression = apply && r.regressions.length > 0
    const wrote = apply && !blockedByRegression
    saveArtifact(args, r, r.changes.map(change => change.path))
    if (wrote)
      writeChanges(r.changes)
    const payload = agentProfile
      ? compactMutationResult(r, undefined, args)
      : {
          scanned: r.scanned,
          summary: s,
          verification: r.verification,
          regressions: diagnostics(r, args, false).results,
          warnings,
          changes: selectOutput(r.changes, selection(args, false), c => c.rel).results.map(c => ({ path: c.rel, absolutePath: c.path, before: c.before, after: c.after })),
          changePage: (() => {
            const { results, ...page } = selectOutput(r.changes, selection(args, false), c => c.rel)
            return page
          })(),

        }
    emitJson(payload, args, r, 'saved', mutationTag(apply, blockedByRegression, r.changes.length))
    if (blockedByRegression)
      process.exitCode = 1
    return
  }
  for (const w of warnings)
    process.stderr.write(`warning: ${w}\n`)
  if (agentProfile) {
    const blockedByRegression = apply && r.regressions.length > 0
    writeText(args, `${profileHeader()}\n`)
    writeText(args, `changes: ${r.changes.length}/${r.scanned} files, +${s.linesAdded} -${s.linesRemoved} lines\n`)
    writeText(args, `mode: ${apply ? (blockedByRegression ? 'blocked' : 'applied') : 'dry-run'}\n`)
    writeText(args, `${formatVerification(r.verification)}\n`)
    if (r.regressions.length)
      writeText(args, `${diagnosticText(r, args, true)}\n`)
    if (r.changes.length) {
      const page = agentFilePage(r.changes, args)
      writeText(args, `files: ${formatOutputPage(page)}\n`)
      for (const c of page.results)
        writeText(args, `  ${c.rel}\n`)
    }
    if (r.regressions.length) {
      if (apply) {
        process.stderr.write(`\nripide: refusing to apply. Fix the reported diagnostics, then retry.\n`)
        process.exitCode = 1
        return
      }
    }
    if (apply) {
      writeChanges(r.changes)
      writeText(args, `applied: true\n`)
    }
    else {
      writeText(args, `apply: pass --apply to write, or --profile full to see diff\n`)
    }
    return
  }
  writeText(args, `${formatVerification(r.verification)}\n`)
  if (r.regressions.length) {
    writeText(args, `${diagnosticText(r, args, false)}\n`)
    if (apply) {
      process.exitCode = 1
      return
    }
  }
  if (!apply) {
    writeText(args, `${s.files} file${s.files === 1 ? '' : 's'}, +${s.linesAdded} -${s.linesRemoved} lines\n\n`)
    printDiffs(selectOutput(r.changes, selection(args, false), c => c.rel).results, textSink(args))
  }
  if (apply) {
    writeChanges(r.changes)
    for (const c of r.changes) writeText(args, `wrote ${c.rel}\n`)
  }
  const suffix = apply ? '' : ' (dry run, pass --apply to write)'
  writeText(args, `\n${r.changes.length}/${r.scanned} files changed${suffix}\n`)
}

const renameFileCmd = defineCommand({
  meta: { name: 'rename-file', description: 'Rename a file and rewrite every import site (including .vue consumers and component-name refs).' },
  args: {
    old: { type: 'positional', required: true },
    new: { type: 'positional', required: true },
    tsconfig: { type: 'string' },
    apply: applyArg,
    verifyMode: verifyModeArg,
    vue: vueArg,
    profile: profileArg,
    ...outputArgs,
    json: jsonArg,
  },
  async run({ args }) {
    const sdk = await createCliEngine(process.cwd(), args.vue !== false)
    const verifyMode = resolveCliVerifyMode(args.verifyMode)
    const recovered = recoverSmushedPair(args.old as string, args.new as string)
    if (recovered.warning)
      process.stderr.write(`warning: ${recovered.warning}\n`)
    const r = await sdk.renameFile(recovered.old, recovered.new, {
      profile: phaseSink(args),
      tsconfig: args.tsconfig as string | undefined,
      verifyMode,
    })
    const apply = !!args.apply
    const json = !!args.json
    const { agentProfile } = resolveProfile(args.profile, !!args.json)
    const selfChangeDisplay = r.selfChange
      ? { path: r.fileMove.to, rel: relative(process.cwd(), r.fileMove.to), before: r.selfChange.before, after: r.selfChange.after }
      : null
    const displayChanges = selfChangeDisplay ? [selfChangeDisplay, ...r.changes] : r.changes
    const s = summarize(displayChanges)
    const blockedByRegression = apply && r.regressions.length > 0
    const wrote = apply && !blockedByRegression

    const manifest = agentProfile
      ? buildChangeManifest(r.changes, {
          from: relative(process.cwd(), r.fileMove.from),
          to: relative(process.cwd(), r.fileMove.to),
          before: r.selfChange?.before ?? '',
          after: r.selfChange?.after ?? '',
        })
      : undefined

    saveArtifact(args, r, [r.fileMove.from, r.fileMove.to, ...r.changes.map(change => change.path)])
    if (wrote)
      sdk.commit(r)

    if (json) {
      const payload = agentProfile
        ? compactMutationResult(r, manifest, args)
        : {
            scanned: r.scanned,
            summary: s,
            verification: r.verification,
            regressions: diagnostics(r, args, false).results,
            warnings: r.warnings,
            fileMove: r.fileMove,
            selfChange: r.selfChange,
            changes: selectOutput(r.changes, selection(args, false), c => c.rel).results.map(c => ({ path: c.rel, absolutePath: c.path, before: c.before, after: c.after })),
            changePage: (() => {
              const { results, ...page } = selectOutput(r.changes, selection(args, false), c => c.rel)
              return page
            })(),

          }
      emitJson(payload, args, r, 'saved', mutationTag(apply, blockedByRegression, r.changes.length + 1))
      if (blockedByRegression)
        process.exitCode = 1
      return
    }
    for (const w of r.warnings)
      process.stderr.write(`warning: ${w}\n`)
    if (agentProfile) {
      writeText(args, `${profileHeader()}\n`)
      writeText(args, `rename-file: ${recovered.old} -> ${recovered.new}\n`)
      writeText(args, `consumers: ${r.changes.length}/${r.scanned}, +${s.linesAdded} -${s.linesRemoved} lines\n`)
      if (selfChangeDisplay)
        writeText(args, `self: rewrote moved file's own relative imports\n`)
      writeText(args, `mode: ${apply ? (blockedByRegression ? 'blocked' : 'applied') : 'dry-run'}\n`)
      writeText(args, `${formatVerification(r.verification)}\n`)
      if (r.regressions.length)
        writeText(args, `${diagnosticText(r, args, true)}\n`)
      if (displayChanges.length) {
        const page = agentFilePage(displayChanges, args)
        writeText(args, `files: ${formatOutputPage(page)}\n`)
        for (const c of page.results)
          writeText(args, `  ${c.rel}${selfChangeDisplay && c === selfChangeDisplay ? ' (moved file, intra-file imports)' : ''}\n`)
      }
      if (r.regressions.length) {
        if (apply) {
          process.stderr.write(`\nripide: refusing to apply. Fix the reported diagnostics, then retry.\n`)
          process.exitCode = 1
          return
        }
      }
      if (!apply)
        writeText(args, `apply: pass --apply to write, or --profile full to see diff\n`)
      return
    }
    writeText(args, `${formatVerification(r.verification)}\n`)
    if (r.regressions.length) {
      writeText(args, `${diagnosticText(r, args, false)}\n`)
      if (apply) {
        process.exitCode = 1
        return
      }
    }
    if (!apply) {
      writeText(args, `rename ${args.old} -> ${args.new}\n`)
      printDiffs(selectOutput(displayChanges, selection(args, false), c => c.rel).results, textSink(args))
    }
    if (wrote) {
      for (const c of r.changes) writeText(args, `wrote ${c.rel}\n`)
      if (selfChangeDisplay)
        writeText(args, `wrote ${selfChangeDisplay.rel} (moved file, intra-file imports)\n`)
      writeText(args, `renamed ${args.old} -> ${args.new}\n`)
    }
    const suffix = apply ? '' : ' (dry run, pass --apply to write)'
    writeText(args, `\n${r.changes.length} consumer file(s) updated${suffix}\n`)
  },
})

const cssClassRenameCmd = defineCommand({
  meta: { name: 'css-class-rename', description: 'Rename CSS utility class token(s) across strings, Vue templates, and @apply. Pass a single "from to" pair, or --map <file.json> for bulk. No typecheck verify.' },
  args: {
    from: { type: 'positional', required: false },
    to: { type: 'positional', required: false },
    map: { type: 'string', description: 'Path to a JSON file with { "from": "to", ... } flat object. Mutually exclusive with from/to positionals.' },
    glob: globArg,
    apply: applyArg,
    profile: profileArg,
    ...outputArgs,
    json: jsonArg,
  },
  async run({ args }) {
    const sdk = await createCliEngine(process.cwd(), args.vue !== false)
    const engine = sdk.services
    const map = buildRenameMap(args.from as string | undefined, args.to as string | undefined, args.map as string | undefined)
    const r = await runCssClassRename(map, {
      engine,
      glob: args.glob ? splitGlobs(args.glob as string) : undefined,
    })
    emitResult(r, !!args.apply, !!args.json, resolveProfile(args.profile, !!args.json).agentProfile, args)
  },
})

function buildRenameMap(from: string | undefined, to: string | undefined, mapPath: string | undefined): Map<string, string> {
  const hasPair = from != null && to != null
  const hasMap = !!mapPath
  if (hasPair && hasMap) {
    throw new Error(`ripide css-class-rename: pass either "from to" positionals OR --map, not both.`)
  }
  if (!hasPair && !hasMap) {
    throw new Error(`ripide css-class-rename: missing input. Pass "from to" positionals or --map <file.json>.`)
  }
  if (hasPair)
    return new Map([[from, to]])
  const raw = readFileSync(resolve(process.cwd(), mapPath!), 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch (err) {
    throw new Error(`ripide css-class-rename: --map file is not valid JSON (${(err as Error).message}).`)
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`ripide css-class-rename: --map must be a flat JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}.`)
  }
  const entries: [string, string][] = []
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      throw new TypeError(`ripide css-class-rename: --map value for "${k}" is not a string.`)
    }
    if (!k) {
      throw new Error(`ripide css-class-rename: --map has an empty key.`)
    }
    entries.push([k, String(v)])
  }
  if (!entries.length) {
    throw new Error(`ripide css-class-rename: --map is empty.`)
  }
  return new Map(entries)
}

const cssClassScanCmd = defineCommand({
  meta: { name: 'css-class-scan', description: 'Tokenize every class site (strings, Vue class attrs, @apply) and emit sortable token or file frequency lists. Use --sort count-asc for rare tokens or --by file for files introducing the most unique classes.' },
  args: {
    pattern: { type: 'string', description: 'Comma-separated globs matched against the bare token (e.g. "bg-*,text-*"). Default: all tokens.' },
    glob: globArg,
    by: { type: 'string', description: 'Group by token or file. Default: token.' },
    sort: { type: 'string', description: 'Sort order. Token: count-desc, count-asc, token. File: unique-desc, unique-asc, count-desc, count-asc, file.' },
    profile: profileArg,
    ...outputArgs,
    json: jsonArg,
  },
  async run({ args }) {
    const sdk = await createCliEngine(process.cwd(), args.vue !== false)
    const engine = sdk.services
    const { agentProfile } = resolveProfile(args.profile, !!args.json)
    const by = resolveCssClassScanGroup(args.by)
    const base = {
      glob: args.glob ? splitGlobs(args.glob as string) : undefined,
      pattern: args.pattern ? (args.pattern as string).split(',') : undefined,
    }
    if (by === 'file') {
      const hits = runCssClassFileScan({ engine, ...base, sort: resolveCssClassFileScanSort(args.sort) })
      if (args.json) {
        const results = agentProfile ? hits.map(hit => ({ file: hit.file, count: hit.count, unique: hit.unique })) : hits
        discoveryJson(results, args, hit => hit.file, hits)
        return
      }
      if (agentProfile) {
        writeText(args, `${profileHeader()}\n${formatAgentFileScanHits(hits, args.limit == null ? 40 : Number(args.limit), Number(args.offset ?? 0), args.file as string | undefined, parsePageBytes(args['page-bytes'], true))}\n`)
        return
      }
      const page = selectOutput(hits, selection(args, false), hit => hit.file)
      writeText(args, `${formatFileScanHits(page.results, false)}\n${formatOutputPage(page)}\n`)
      return
    }
    const hits = runCssClassScan({ engine, ...base, sort: resolveCssClassScanSort(args.sort) })
    if (args.json) {
      if (!agentProfile && args.limit == null && args.offset == null && args.file == null && args.fields == null && args['page-bytes'] == null) {
        emitJson(hits, args, hits)
        return
      }
      const page = selectOutput(hits, selection(args, agentProfile), hit => args.file && hit.files.includes(String(args.file)) ? String(args.file) : '')
      const results = agentProfile ? page.results.map(hit => ({ token: hit.token, count: hit.count, files: hit.files.length })) : page.results
      emitJson({ ...page, results: selectedFields(results, args) }, args, hits)
      return
    }
    if (agentProfile) {
      writeText(args, `${profileHeader()}\n${formatAgentScanHits(hits, args.limit == null ? 40 : Number(args.limit), Number(args.offset ?? 0), args.file as string | undefined, parsePageBytes(args['page-bytes'], true))}\n`)
      return
    }
    const page = selectOutput(hits, selection(args, false), hit => args.file && hit.files.includes(String(args.file)) ? String(args.file) : '')
    writeText(args, `${formatScanHits(page.results, false)}\n${formatOutputPage(page)}\n`)
  },
})

function resolveCssClassScanGroup(raw: unknown): 'token' | 'file' {
  if (raw == null)
    return 'token'
  if (raw !== 'token' && raw !== 'file') {
    throw new Error(`ripide css-class-scan: --by must be "token" or "file".`)
  }
  return raw
}

function resolveCssClassScanSort(raw: unknown): 'count-desc' | 'count-asc' | 'token' {
  if (raw == null)
    return 'count-desc'
  if (raw !== 'count-desc' && raw !== 'count-asc' && raw !== 'token') {
    throw new Error(`ripide css-class-scan: --sort must be "count-desc", "count-asc", or "token".`)
  }
  return raw
}

function resolveCssClassFileScanSort(raw: unknown): 'unique-desc' | 'unique-asc' | 'count-desc' | 'count-asc' | 'file' {
  if (raw == null)
    return 'unique-desc'
  if (raw !== 'unique-desc' && raw !== 'unique-asc' && raw !== 'count-desc' && raw !== 'count-asc' && raw !== 'file') {
    throw new Error(`ripide css-class-scan: --sort with --by file must be "unique-desc", "unique-asc", "count-desc", "count-asc", or "file".`)
  }
  return raw
}

const scopeArg = { type: 'string' as const, description: 'Restrict to a single .vue file (skips file discovery).' }
const rootOnlyArg = { type: 'boolean' as const, default: false, description: 'Match only template-root elements (direct children of <template>); ignores nested matches.' }

const vueTemplateWrapCmd = defineCommand({
  meta: { name: 'vue-template-wrap', description: 'Wrap every matching element in a Vue <template> with a parent component. Selector: "Tag" or "Tag[attr]" / "Tag[attr=value]". Wrapper: tag name with optional inline attributes (e.g. "ProPageStates name=\\"lh\\"").' },
  args: {
    selector: { type: 'positional', required: true },
    wrapper: { type: 'positional', required: true },
    glob: globArg,
    scope: scopeArg,
    rootOnly: rootOnlyArg,
    apply: applyArg,
    profile: profileArg,
    ...outputArgs,
    json: jsonArg,
  },
  async run({ args }) {
    const { runVueTemplateWrap } = await loadVueOperations()
    const r = await runVueTemplateWrap(args.selector as string, args.wrapper as string, {
      glob: args.glob ? splitGlobs(args.glob as string) : undefined,
      scope: args.scope as string | undefined,
      rootOnly: args.rootOnly as boolean,
    })
    emitResult(r, !!args.apply, !!args.json, resolveProfile(args.profile, !!args.json).agentProfile, args)
  },
})

const vueTemplateUnwrapCmd = defineCommand({
  meta: { name: 'vue-template-unwrap', description: 'Remove every matching element in a Vue <template>, hoisting its children up one level. Inverse of vue-template-wrap.' },
  args: {
    selector: { type: 'positional', required: true },
    glob: globArg,
    scope: scopeArg,
    rootOnly: rootOnlyArg,
    apply: applyArg,
    profile: profileArg,
    ...outputArgs,
    json: jsonArg,
  },
  async run({ args }) {
    const { runVueTemplateUnwrap } = await loadVueOperations()
    const r = await runVueTemplateUnwrap(args.selector as string, {
      glob: args.glob ? splitGlobs(args.glob as string) : undefined,
      scope: args.scope as string | undefined,
      rootOnly: args.rootOnly as boolean,
    })
    emitResult(r, !!args.apply, !!args.json, resolveProfile(args.profile, !!args.json).agentProfile, args)
  },
})

const componentsCmd = defineCommand({
  meta: { name: 'components', description: 'Inventory Vue/Nuxt components (manifest-first, glob fallback); flag shadowed entries and duplicate-name groups. Pass a name positional for the focused view.' },
  args: {
    name: { type: 'positional', required: false, description: 'Component name. If given, prints file, aliases, usages, and same-name candidates.' },
    glob: globArg,
    source: { type: 'string', description: 'Discovery source: auto, manifest, or filesystem. Default: auto.' },
    dups: { type: 'boolean', default: false, description: 'Print only duplicate-name groups.' },
    profile: profileArg,
    ...outputArgs,
    json: jsonArg,
  },
  async run({ args }) {
    const sdk = await createCliEngine(process.cwd(), args.vue !== false)
    const engine = sdk.services
    const { agentProfile } = resolveProfile(args.profile, !!args.json)
    const opts = {
      engine,
      glob: args.glob ? splitGlobs(args.glob as string) : undefined,
      source: resolveComponentsSource(args.source),
    }
    if (args.name) {
      const detail = await buildComponentDetail(args.name as string, opts)
      if (!detail) {
        throw new Error(`No component named "${args.name}". Run components to list available names.`)
      }
      if (args.json) {
        const normalizeComponent = (c: typeof detail.component) => ({ ...c, file: outputPath(c.file, process.cwd()), ...(c.shadowedBy ? { shadowedBy: outputPath(c.shadowedBy, process.cwd()) } : {}) })
        const normalized = { ...detail, component: normalizeComponent(detail.component), candidates: detail.candidates.map(normalizeComponent), usages: detail.usages.map(u => ({ ...u, file: outputPath(u.file, process.cwd()) })) }
        const page = selectOutput(normalized.usages, selection(args, agentProfile, 50), usage => usage.rel)
        const candidates = selectOutput(normalized.candidates, selection(args, agentProfile, 50), candidate => candidate.rel)
        emitJson({ ...normalized, candidates: candidates.results, candidatePage: { ...candidates, results: undefined }, usages: selectedFields(page.results, args), usagePage: { ...page, results: undefined } }, args, detail)
        return
      }
      writeText(args, `${formatDetail(detail, selection(args, agentProfile, 50))}\n`)
      return
    }
    const inv = await buildComponentInventory(opts)
    if (args.json) {
      if (args.dups) {
        const duplicates = inv.duplicates.map((duplicate) => {
          const { results: entries, ...entryPage } = selectOutput(duplicate.entries, selection(args, agentProfile), entry => entry.rel)
          return { ...duplicate, entries: entries.map(entry => ({ ...entry, file: outputPath(entry.file, process.cwd()) })), entryPage }
        })
        discoveryJson(duplicates, args, undefined, inv)
      }
      else {
        discoveryJson(inv.components.map(c => ({ ...c, file: outputPath(c.file, process.cwd()), ...(c.shadowedBy ? { shadowedBy: outputPath(c.shadowedBy, process.cwd()) } : {}) })), args, c => c.rel, inv)
      }
      return
    }
    if (args.dups) {
      if (!inv.duplicates.length) {
        writeText(args, 'no duplicate-name groups\n')
        return
      }
      const page = selectOutput(inv.duplicates, selection(args, agentProfile))
      const lines: string[] = [formatOutputPage(page)]
      for (const dup of page.results) {
        lines.push(dup.name)
        const entries = selectOutput(dup.entries, selection(args, agentProfile), entry => entry.rel)
        for (const e of entries.results)
          lines.push(`  ${e.rel}${e.shadowed ? ' (shadowed)' : ''}`)
        lines.push(`  entries: ${formatOutputPage(entries)}`)
      }
      writeText(args, `${lines.join('\n')}\n`)
      return
    }
    if (agentProfile) {
      writeText(args, `${profileHeader()}\n${formatAgentInventory(inv, selection(args, true))}\n`)
      return
    }
    writeText(args, `${formatInventory(inv)}\n`)
  },
})

function resolveComponentsSource(raw: unknown): 'auto' | 'manifest' | 'filesystem' | undefined {
  if (raw == null)
    return undefined
  if (raw !== 'auto' && raw !== 'manifest' && raw !== 'filesystem') {
    throw new Error(`ripide components: --source must be "auto", "manifest", or "filesystem".`)
  }
  return raw
}

const doctorCmd = defineCommand({
  meta: { name: 'doctor', description: 'Health checks over the AST graph. Suppress per-file with `// ripide-doctor-ignore-file[: c1,c2]` or per-line with `// ripide-doctor-ignore-next-line[: c1,c2]`.' },
  args: {
    glob: globArg,
    checks: { type: 'string', description: 'Comma-separated subset: dangling-reexport, stale-reexport, stale-import, duplicate-export, orphan-file, orphan-test, inconsistent-import-path, circular-dep, phantom-component, shadowed-component, cross-realm-import, stale-nuxt-config-ref. Default: all (adapter checks run when their framework is detected).' },
    entry: { type: 'string', description: 'Comma-separated entry files exempt from orphan check (relative to cwd).' },
    fix: { type: 'boolean', default: false, description: 'Compute safe fixes for inconsistent-import-path and dangling-reexport findings.' },
    apply: applyArg,
    changed: { type: 'string', description: 'Report only findings on files changed vs git. No value = dirty working tree (staged+unstaged+untracked). With value (e.g. main, HEAD~1) = diff against that ref. Full project is still scanned so cross-file checks stay accurate.' },
    profile: profileArg,
    ...outputArgs,
    json: jsonArg,
  },
  async run({ args }) {
    const sdk = await createCliEngine(process.cwd(), args.vue !== false)
    const engine = sdk.services
    const { agentProfile } = resolveProfile(args.profile, !!args.json)
    const checks = args.checks ? (args.checks as string).split(',') : undefined
    if (checks) {
      const names = await getDoctorCheckNames({ engine, cwd: process.cwd() })
      for (const check of checks) {
        if (!names.includes(check))
          throw new Error(`Unknown doctor check: ${check}. Available checks: ${names.join(', ')}`)
      }
    }
    const entry = args.entry ? (args.entry as string).split(',') : undefined
    let changedFiles: string[] | undefined
    if (args.changed != null) {
      const ref = typeof args.changed === 'string' && args.changed !== '' && args.changed !== 'true' ? args.changed : undefined
      changedFiles = getChangedFiles({ cwd: process.cwd(), ref })
      if (!changedFiles.length) {
        if (args.json)
          discoveryJson([], args, undefined, { findings: [], filesScanned: 0 })
        else
          writeText(args, 'doctor: no changed files matched.\n')
        return
      }
    }
    const report = await runDoctor({ engine, profile: phaseSink(args), glob: args.glob ? splitGlobs(args.glob as string) : undefined, checks, entry, changedFiles })
    if (args.fix) {
      const fix = buildDoctorFixes(report, process.cwd())
      if (args.json) {
        saveArtifact(args, { report, fix }, fix.changes.map(change => change.path))
        if (args.apply && fix.changes.length)
          writeChanges(fix.changes)
        const full = {
          verification: fix.verification,
          findings: report.findings,
          filesScanned: report.filesScanned,
          fix: { files: fix.changes.length, fixed: fix.fixed, skipped: fix.skipped.length },
          changes: fix.changes.map(c => ({ path: c.rel, before: c.before, after: c.after })),
        }
        const { results: changes, ...changePage } = selectOutput(full.changes, selection(args, false), change => change.path)
        const { results: findings, ...findingPage } = selectOutput(report.findings, selection(args, false), finding => finding.file)
        const { results: fixed, ...fixedPage } = selectOutput(fix.fixed, selection(args, false), finding => finding.file)
        const fullOutput = { ...full, changes, changePage, findings, findingPage, fix: { ...full.fix, fixed }, fixedPage }
        const skippedPage = selectOutput(fix.skipped, selection(args, true, 50), finding => finding.file)
        emitJson(agentProfile
          ? {
              ...compactMutationResult({ changes: fix.changes, verification: fix.verification, regressions: [], scanned: report.filesScanned }, undefined, args),
              findings: skippedPage.results,
              findingPage: { ...skippedPage, results: undefined },
            }
          : fullOutput, args, full, 'saved', mutationTag(!!args.apply, false, fix.changes.length))
        if (fix.skipped.length)
          process.exitCode = 1
        return
      }
      if (agentProfile) {
        writeText(args, `${formatAgentDoctorReport({ ...report, findings: fix.skipped }, selection(args, true, 50))}\n`)
        emitResult({ ...fix, scanned: report.filesScanned, regressions: [] }, !!args.apply, false, true, args)
        if (fix.skipped.length)
          process.exitCode = 1
        return
      }
      if (fix.skipped.length) {
        const page = selectOutput(fix.skipped, selection(args, false), finding => finding.file)
        writeText(args, `${fullPageText(formatDoctorReport({ ...report, findings: page.results }, false), page, 'findings', args)}\n`)
      }
      const page = selectOutput(fix.changes, selection(args, false), change => change.rel)
      const s = summarize(fix.changes)
      writeText(args, `${formatVerification(fix.verification)}\n`)
      writeText(args, `doctor --fix: ${fix.fixed.length} fixable / ${fix.skipped.length} non-fixable findings\n`)
      writeText(args, `${fix.changes.length} file${fix.changes.length === 1 ? '' : 's'}, +${s.linesAdded} -${s.linesRemoved} lines\n\n`)
      if (!args.apply) {
        printDiffs(page.results, textSink(args))
        writeText(args, `\n(dry run, pass --apply to write)\n`)
      }
      else {
        writeChanges(fix.changes)
        for (const c of page.results) writeText(args, `wrote ${c.rel}\n`)
      }
      if (args.limit != null || args.offset != null || args.file != null || args['page-bytes'] != null)
        writeText(args, `files: ${formatOutputPage(page)}\n`)
      if (fix.skipped.length)
        process.exitCode = 1
      return
    }
    if (agentProfile && !args.json) {
      writeText(args, `${profileHeader()}\n${formatAgentDoctorReport(report, selection(args, true, 50))}\n`)
    }
    else if (args.json) {
      if (agentProfile) {
        const page = selectDoctorFindings(report, selection(args, true, 50))
        emitJson({ ...page, results: selectedFields(page.results, args), filesScanned: report.filesScanned }, args, report)
      }
      else {
        discoveryJson(report.findings, args, finding => finding.file, report)
      }
    }
    else {
      const page = selectOutput(report.findings, selection(args, false), finding => finding.file)
      writeText(args, `${fullPageText(formatDoctorReport({ ...report, findings: page.results }, false), page, 'findings', args)}\n`)
    }
    if (report.findings.length)
      process.exitCode = 1
  },
}, ['changed'])

function compactCheckError({ stack: _stack, ...error }: InlineTestError): InlineTestError {
  const diagnostics = error.message.split('\n').filter(line => /^\[[A-Z_]+\]/.test(line))
  return { ...error, message: (diagnostics.length ? diagnostics.slice(0, 3).join('\n') : error.message.split('\n')[0]).slice(0, 500) }
}

const checkCmd = defineCommand({
  meta: { name: 'check', description: 'Experimental. Run transient Vitest checks from stdin or list changes that need checks.' },
  args: {
    'symbol': { type: 'positional', required: false, description: 'Exported function to import automatically.' },
    'from': { type: 'string', description: 'Source file. Imports and mocks resolve beside this file. Required for ambiguous function names.' },
    'base': { type: 'string', description: 'Git baseline. Enables the change checklist and execution evidence.' },
    'config': { type: 'string', description: 'Vitest configuration file.' },
    'project': { type: 'string', description: 'Vitest project name.' },
    'timeout': { type: 'string', description: 'Execution deadline in milliseconds.', default: '30000' },
    'profile': profileArg,
    'max-bytes': outputArgs['max-bytes'],
    'json': { type: 'boolean', default: false },
    'minify': outputArgs.minify,
    'artifact': outputArgs.artifact,
  },
  async run({ args }) {
    const { agentProfile } = resolveProfile(args.profile, !!args.json)
    let source: string | undefined
    if (args.symbol || args.from) {
      if (process.stdin.isTTY)
        throw new Error('Pipe TypeScript tests through stdin.')
      const chunks: Buffer[] = []
      let bytes = 0
      for await (const chunk of process.stdin) {
        const buffer = Buffer.from(chunk)
        bytes += buffer.length
        if (bytes > MAX_TEST_SOURCE_BYTES)
          throw new Error('The test module exceeds the 1 MiB input limit.')
        chunks.push(buffer)
      }
      source = Buffer.concat(chunks).toString('utf8')
      if (!source.trim())
        throw new Error('Pipe TypeScript tests through stdin.')
    }
    const timeoutMs = Number(args.timeout)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
      throw new Error('Option --timeout requires a positive integer below 2147483648 milliseconds.')
    const report = await runCheck({ cwd: process.cwd(), symbol: args.symbol, from: args.from, base: args.base, source, config: args.config, project: args.project, timeoutMs })
    if (report._tag === 'Run' && report.result._tag !== 'Passed')
      process.exitCode = 1
    if (args.json) {
      const checklist = report.checklist
      const compactChecklist = checklist && {
        ...checklist,
        items: checklist.items.filter(item => item.status !== 'executed' || item.uncoveredBranches).map(({ body, target, ...item }) => ({
          ...item,
          ...(target ? { target: { file: target.file, symbol: target.symbol, line: target.line } } : {}),
        })),
      }
      const executedCoverage = report._tag === 'Run' ? report.result.coverage.filter(fn => fn.hits > 0) : []
      const compact = !agentProfile
        ? report
        : report._tag === 'Run'
          ? {
              ...report,
              ...(compactChecklist ? { checklist: compactChecklist } : {}),
              result: {
                ...report.result,
                ...(report.result._tag === 'Error' ? { message: compactCheckError({ message: report.result.message }).message } : {}),
                ...('errors' in report.result ? { errors: report.result.errors.map(compactCheckError) } : {}),
                tests: report.result.tests.filter(test => test.state !== 'passed').map(test => ({ ...test, errors: test.errors.map(compactCheckError) })),
                coverage: executedCoverage.slice(0, 20).map(fn => ({ file: fn.file, name: fn.name, line: fn.startLine, hits: fn.hits, uncoveredBranches: fn.branches.flatMap(branch => branch.hits).filter(hits => hits === 0).length })),
                coverageOmitted: Math.max(0, executedCoverage.length - 20),
              },
            }
          : { ...report, checklist: compactChecklist }
      emitJson(compact, args, report, 'save', report._tag === 'Run' && report.result._tag === 'Error' ? 'Error' : 'Result')
      return
    }
    if (report._tag === 'Run') {
      const result = report.result
      writeText(args, `${result._tag}: ${result.counts.passed} passed, ${result.counts.failed} failed, ${result.counts.skipped} skipped\n`)
      if (result._tag === 'Error')
        writeText(args, `${result.message}\n`)
      if (result._tag === 'TimedOut')
        writeText(args, `Execution exceeded ${result.timeoutMs} ms.\n`)
      for (const test of result.tests.filter(test => !agentProfile || test.state !== 'passed')) {
        writeText(args, `${test.state}: ${test.name}\n`)
        for (const error of test.errors) writeText(args, `${error.line ? `<stdin>:${error.line}: ` : ''}${error.message}\n`)
      }
      if (result.logs.stdout)
        process.stderr.write(result.logs.stdout)
      if (result.logs.stderr)
        process.stderr.write(result.logs.stderr)
    }
    const checklist = report.checklist
    if (checklist) {
      writeText(args, `Checks: ${checklist.counts.pending} pending, ${checklist.counts.executed} executed, ${checklist.counts.stale} stale\n`)
      for (const item of checklist.items.filter(item => !agentProfile || item.status !== 'executed' || item.uncoveredBranches)) {
        writeText(args, `${item.status} ${item.kind} ${item.file}:${item.line} ${item.symbol}${item.target ? ` -> ${item.target.file}:${item.target.symbol}` : ''}${item.uncoveredBranches ? ` (${item.uncoveredBranches} uncovered branches)` : ''}\n`)
      }
      writeText(args, 'Execution evidence requires assertion review. Integration and API contracts remain pending.\n')
    }
  },
})

const pageCmd = defineCommand({
  meta: { name: 'page', description: 'Inspect saved JSON evidence without repeating its operation. Session mode accepts NDJSON navigation requests.' },
  args: {
    'input': { type: 'string', required: true, description: 'Saved JSON evidence file. Use - to read one JSON document from stdin.' },
    'path': { type: 'string', default: '', description: 'JSON Pointer to inspect. Empty selects the root. Escape ~ as ~0 and / as ~1.' },
    'session': { type: 'boolean', default: false, description: 'Read Next, Previous, Select, and Close JSON requests from stdin. Requires an input file.' },
    'json': { type: 'boolean', default: true, description: 'Page responses always use JSON.' },
    'limit': outputArgs.limit,
    'offset': outputArgs.offset,
    'page-bytes': outputArgs['page-bytes'],
    'max-bytes': outputArgs['max-bytes'],
    'fields': outputArgs.fields,
    'minify': outputArgs.minify,
  },
  async run({ args }) {
    const input = args.input === '-' ? '-' : resolve(args.input)
    const outcome = await runEvidencePager({
      input,
      path: args.path,
      session: args.session,
      limit: args.limit == null ? 40 : Number(args.limit),
      offset: args.offset == null ? 0 : Number(args.offset),
      pageBytes: parsePageBytes(args['page-bytes'], true)!,
      ...(args.fields ? { fields: String(args.fields).split(',') } : {}),
    }, {
      stdin: process.stdin,
      read: path => readFileSync(path, 'utf8'),
      emit: (value, error) => {
        emitJson(value, args, value, 'saved', error ? 'Error' : 'Result')
      },
      render: value => serializeJson(jsonResult('Result', 'page', process.cwd(), value), args),
    })
    if (outcome._tag === 'Refused')
      process.exitCode = 1
  },
}, ['path'])

const command = defineCommand({
  meta: { name: 'ripide', description: 'AST-aware refactor primitives. Ripgrep-prefiltered, dry-run by default.' },
  subCommands: {
    'page': pageCmd,
    'scan': scanCmd,
    'check': checkCmd,
    'tree': treeCmd,
    'unused': unusedCmd,
    'doctor': doctorCmd,
    'rename': renameCmd,
    'replace': replaceCmd,
    'rename-file': renameFileCmd,
    'move': moveCmd,
    'delete': deleteCmd,
    'components': componentsCmd,
    'css-class-rename': cssClassRenameCmd,
    'css-class-scan': cssClassScanCmd,
    'vue-template-wrap': vueTemplateWrapCmd,
    'vue-template-unwrap': vueTemplateUnwrapCmd,
  },
})

function jsonRequested(rawArgs: string[]): boolean {
  if (rawArgs[0] === 'page')
    return true
  let requested = false
  for (const arg of rawArgs) {
    if (arg === '--')
      break
    if (arg === '--json' || arg === '--json=true')
      requested = true
    if (arg === '--no-json' || arg === '--json=false')
      requested = false
  }
  return requested
}

/** Parse and validate before an optional launcher resolves operation adapters. */
export async function runCli(rawArgs: string[], ensureAdapters?: (needed: readonly string[]) => boolean | void | Promise<boolean | void>): Promise<void> {
  const name = rawArgs[0]
  const commands = command.subCommands as Record<string, CommandDef>
  const selected = commands[name]
  if (rawArgs.includes('--help') || rawArgs.includes('-h') || rawArgs.length === 0 || rawArgs.every(arg => arg === '--json')) {
    const args: OutputArgs = { ...parseArgs(rawArgs, { 'profile': profileArg, 'max-bytes': outputArgs['max-bytes'], 'json': jsonArg }), command: selected ? name : 'ripide' }
    if (jsonRequested(rawArgs)) {
      emitJson({ usage: await renderUsage(selected ?? command) }, { ...args, json: true })
    }
    else {
      const output = createTextOutput({ maxBytes: parseOutputBytes(args['max-bytes'], resolveProfile(args.profile).agentProfile), write: text => process.stdout.write(text) })
      output.write(await renderUsage(selected ?? command))
      output.end()
    }
    return
  }
  if ((name === '--version' || name === '-v') && rawArgs.every(arg => ['--version', '-v', '--json'].includes(arg))) {
    const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
    if (jsonRequested(rawArgs))
      emitJson({ version }, { command: 'ripide', json: true })
    else
      process.stdout.write(`${version}\n`)
    return
  }
  const main = selected
    ? {
        ...selected,
        async run(context: Parameters<NonNullable<typeof selected.run>>[0]) {
          const commandArgs = context.args as OutputArgs
          commandArgs.command = name
          if (name === 'page')
            commandArgs.json = true
          const maxBytes = parseOutputBytes(context.args['max-bytes'], resolveProfile(context.args.profile, !!context.args.json).agentProfile)
          parsePageBytes(context.args['page-bytes'], resolveProfile(context.args.profile, !!context.args.json).agentProfile)
          preflightJsonOutput(context.args, maxBytes)
          const textOutput = createTextOutput({ maxBytes, write: text => process.stdout.write(text) })
          ;(context.args as OutputArgs).textOutput = textOutput
          const start = performance.now()
          try {
            const destinations = name === 'rename-file'
              ? [recoverSmushedPair(context.args.old as string, context.args.new as string).new]
              : name === 'move' ? [context.args.to as string] : []
            rejectArtifactCollision(context.args, destinations)
            const needsAdapter = ['rename', 'move', 'rename-file', 'replace', 'delete', 'doctor', 'components', 'scan', 'tree', 'unused', 'css-class-scan', 'css-class-rename', 'vue-template-wrap', 'vue-template-unwrap'].includes(name)
            if (needsAdapter && context.args.vue !== false && ensureAdapters && await ensureAdapters(discoverCliAdapters().adapters))
              return
            return await selected.run?.(context)
          }
          finally {
            textOutput.end()
            if (context.args.timings)
              process.stderr.write(`${JSON.stringify({ phase: `command ${name}`, ms: performance.now() - start })}\n`)
          }
        },
      }
    : command
  await runCommand(main, { rawArgs: selected ? rawArgs.slice(1) : rawArgs }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    const next = 'Run the command with --help. Fix the reported cause, then retry.'
    const cause = error instanceof Error && error.cause ? String(error.cause) : undefined
    if (jsonRequested(rawArgs)) {
      const parsed = parseArgs(rawArgs, { 'profile': profileArg, 'max-bytes': outputArgs['max-bytes'], 'minify': outputArgs.minify })
      const budget = Number(parsed['max-bytes'])
      const args: OutputArgs = {
        command: name ?? 'ripide',
        json: true,
        ...(Number.isSafeInteger(budget) && budget >= 1024 ? { 'max-bytes': String(budget) } : {}),
        ...(['auto', 'agent', 'full'].includes(String(parsed.profile)) ? { profile: parsed.profile } : {}),
        minify: parsed.minify,
      }
      const maxBytes = parseOutputBytes(args['max-bytes'], resolveProfile(args.profile, true).agentProfile)
      const required = Buffer.byteLength(serializeJson(omittedJson('Error', String(args.command), process.cwd(), args, Number.MAX_SAFE_INTEGER, maxBytes), args))
      // An invalid metadata budget cannot also bound a response that retains its base.
      if (maxBytes !== undefined && required > maxBytes)
        delete args['max-bytes']
      emitJson({ message, next, ...(cause ? { cause } : {}) }, args, undefined, 'saved', 'Error')
    }
    if (jsonRequested(rawArgs))
      process.stderr.write(`ripide: ${message}\n`)
    else
      process.stderr.write(`ripide: ${message}\n${next}\n`)
    process.exitCode = 1
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await runCli(process.argv.slice(2))
