import type { ExportFilter, VerifyMode } from '@ripast/core'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import process from 'node:process'
import {
  buildComponentDetail,
  buildComponentInventory,
  buildDeclarationTree,
  buildDoctorFixes,
  buildScanGraph,
  buildUnusedDeclarations,
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
  formatRegressions,
  formatScanGraph,
  formatScanHits,
  formatUnusedDeclarations,
  getChangedFiles,
  printDiffs,
  resolveVerifyMode,
  runCssClassFileScan,
  runCssClassRename,
  runCssClassScan,
  runDelete,
  runDoctor,
  runMove,
  runRename,
  runRenameFile,
  runReplace,
  runVueTemplateUnwrap,
  runVueTemplateWrap,
  scan,
  summarize,
  writeChanges,
} from '@ripast/core'
import { defineCommand, runMain } from 'citty'
import { agent, isAgent } from 'std-env'

const globArg = { type: 'string' as const, description: 'File glob(s), comma-separated. Prefix with ! to exclude (e.g. "*.ts,!.nuxt/**,!**/*.d.ts"). Defaults to *.ts,*.tsx,*.vue,...  Respects .gitignore.' }
const applyArg = { type: 'boolean' as const, default: false, description: 'Write changes. Default prints a unified diff.' }
const verifyArg = { type: 'boolean' as const, default: true, description: 'Typecheck post-transform; refuse --apply on regression. Disable with --no-verify.' }
const verifyModeArg = { type: 'string' as const, description: 'Verification mode: touched, project, or none. Defaults to touched; --no-verify maps to none.' }
const vueArg = { type: 'boolean' as const, default: true, description: 'Enable Volar pass for .vue files. Disable with --no-vue to skip the Volar pass.' }
const jsonArg = { type: 'boolean' as const, default: false, description: 'Emit machine-readable JSON (suppresses diff/summary text).' }
const profileArg = { type: 'string' as const, description: 'Output profile: auto, agent, or full. Auto uses std-env isAgent.' }

type OutputProfile = 'auto' | 'agent' | 'full'
type GraphFormat = 'mermaid' | 'dot'

function resolveProfile(raw: unknown): { profile: OutputProfile, agentProfile: boolean } {
  const profile = (raw as OutputProfile | undefined) ?? 'auto'
  if (profile !== 'auto' && profile !== 'agent' && profile !== 'full') {
    process.stderr.write(`ripast: --profile must be "auto", "agent", or "full".\n`)
    process.exit(2)
  }
  return { profile, agentProfile: profile === 'agent' || (profile === 'auto' && isAgent) }
}

function resolveGraphFormat(raw: unknown): GraphFormat {
  if (raw !== 'mermaid' && raw !== 'dot') {
    process.stderr.write(`ripast scan: --graph must be "mermaid" or "dot".\n`)
    process.exit(2)
  }
  return raw
}

function profileHeader(): string {
  return `# profile: agent${agent ? ` (${agent})` : ''}`
}

function resolveCliVerifyMode(verify: unknown, verifyMode: unknown): VerifyMode {
  if (verifyMode != null) {
    if (verifyMode !== 'none' && verifyMode !== 'touched' && verifyMode !== 'project') {
      process.stderr.write(`ripast: --verify-mode must be "none", "touched", or "project".\n`)
      process.exit(2)
    }
    return verifyMode
  }
  return resolveVerifyMode(verify as boolean | undefined)
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
    process.stderr.write(`ripast: --exports must be "all", "exported", or "local".\n`)
    process.exit(2)
  }
  return raw
}

const scanCmd = defineCommand({
  meta: { name: 'scan', description: 'rg-prefilter + AST-classify occurrences of an identifier.' },
  args: {
    pattern: { type: 'positional', required: true },
    glob: globArg,
    kind: { type: 'string', description: 'Filter to kind(s), comma-separated. Kinds: identifier-reference, identifier-binding, import-specifier, member-access, property, jsx, string-literal.' },
    graph: { type: 'string', description: 'Emit a dependency graph for hit files: mermaid or dot.' },
    profile: profileArg,
    json: { type: 'boolean', default: false },
  },
  run({ args }) {
    const { agentProfile } = resolveProfile(args.profile)
    const opts = {
      glob: args.glob ? (args.glob as string).split(',') : undefined,
      kinds: args.kind ? (args.kind as string).split(',') : undefined,
    }
    if (args.graph) {
      const graphFormat = resolveGraphFormat(args.graph)
      process.stdout.write(`${formatScanGraph(buildScanGraph(args.pattern as string, opts), graphFormat)}\n`)
      return
    }
    const hits = scan(args.pattern as string, opts)
    if (agentProfile && !args.json) {
      process.stdout.write(`${profileHeader()}\n${formatAgentHits(hits)}\n`)
      return
    }
    process.stdout.write(`${formatHits(hits, args.json as boolean)}\n`)
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
    verify: verifyArg,
    verifyMode: verifyModeArg,
    scope: { type: 'string', description: 'Restrict to a single file when multiple files declare the same name.' },
    all: { type: 'boolean', default: false, description: 'Rename declarations in every file that defines the name (bypasses ambiguity check).' },
    vue: vueArg,
    profile: profileArg,
    json: jsonArg,
  },
  async run({ args }) {
    const verifyMode = resolveCliVerifyMode(args.verify, args.verifyMode)
    const r = await runRename(args.from as string, args.to as string, {
      tsconfig: args.tsconfig as string | undefined,
      glob: args.glob ? (args.glob as string).split(',') : undefined,
      verify: verifyMode,
      scope: args.scope as string | undefined,
      allowMultiple: args.all as boolean,
      vue: args.vue as boolean,
    })
    emitResult(r, !!args.apply, verifyMode !== 'none', !!args.json, resolveProfile(args.profile).agentProfile)
  },
})

const replaceCmd = defineCommand({
  meta: { name: 'replace', description: 'Replace an imported symbol with another project export; updates imports and call sites.' },
  args: {
    'from': { type: 'positional', required: true },
    'to': { type: 'positional', required: true },
    'tsconfig': { type: 'string' },
    'glob': globArg,
    'target-scope': { type: 'string', description: 'Restrict target symbol resolution to a single file when multiple files export the same name.' },
    'apply': applyArg,
    'verify': verifyArg,
    'verifyMode': verifyModeArg,
    'profile': profileArg,
    'json': jsonArg,
  },
  async run({ args }) {
    const verifyMode = resolveCliVerifyMode(args.verify, args.verifyMode)
    const r = await runReplace(args.from as string, args.to as string, {
      tsconfig: args.tsconfig as string | undefined,
      glob: args.glob ? (args.glob as string).split(',') : undefined,
      verify: verifyMode,
      targetScope: args['target-scope'] as string | undefined,
    })
    emitResult(r, !!args.apply, verifyMode !== 'none', !!args.json, resolveProfile(args.profile).agentProfile)
  },
})

const treeCmd = defineCommand({
  meta: { name: 'tree', description: 'Print a project declaration tree from top-level AST declarations, grouped by file.' },
  args: {
    glob: globArg,
    exports: { type: 'string', description: 'Declaration filter: all, exported, or local. Defaults to exported for detected agents, all otherwise.' },
    profile: profileArg,
    json: jsonArg,
  },
  run({ args }) {
    const { agentProfile } = resolveProfile(args.profile)
    const exportFilter = args.exports == null
      ? agentProfile ? 'exported' : 'all'
      : resolveExportFilter(args.exports)
    const tree = buildDeclarationTree({
      glob: args.glob ? (args.glob as string).split(',') : undefined,
      exports: agentProfile ? 'all' : exportFilter,
    })
    if (agentProfile && !args.json) {
      process.stdout.write(`${profileHeader()}\n`)
      process.stdout.write(`${formatAgentDeclarationTree(tree, exportFilter)}\n`)
      return
    }
    process.stdout.write(`${formatDeclarationTree(tree, !!args.json)}\n`)
  },
})

const unusedCmd = defineCommand({
  meta: { name: 'unused', description: 'Find unreferenced top-level declarations.' },
  args: {
    glob: globArg,
    exports: { type: 'string', description: 'Declaration filter: all, exported, or local. Defaults to exported (unused local declarations are already caught by tsc noUnusedLocals).' },
    tsconfig: { type: 'string' },
    json: jsonArg,
  },
  run({ args }) {
    const exportFilter = args.exports == null ? 'exported' : resolveExportFilter(args.exports)
    const unused = buildUnusedDeclarations({
      glob: args.glob ? (args.glob as string).split(',') : undefined,
      exports: exportFilter,
      tsconfig: args.tsconfig as string | undefined,
    })
    process.stdout.write(`${formatUnusedDeclarations(unused, !!args.json)}\n`)
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
    verify: verifyArg,
    verifyMode: verifyModeArg,
    vue: vueArg,
    profile: profileArg,
    json: jsonArg,
  },
  async run({ args }) {
    const verifyMode = resolveCliVerifyMode(args.verify, args.verifyMode)
    const r = await runMove(args.symbol as string, args.from as string, args.to as string, {
      tsconfig: args.tsconfig as string | undefined,
      verify: verifyMode,
      vue: args.vue as boolean,
    })
    emitResult(r, !!args.apply, verifyMode !== 'none', !!args.json, resolveProfile(args.profile).agentProfile)
  },
})

const deleteCmd = defineCommand({
  meta: { name: 'delete', description: 'Delete an unused top-level declaration from a file; refuses if references remain.' },
  args: {
    symbol: { type: 'positional', required: true },
    from: { type: 'string', required: true, description: 'Source file path.' },
    tsconfig: { type: 'string' },
    apply: applyArg,
    verify: verifyArg,
    verifyMode: verifyModeArg,
    profile: profileArg,
    json: jsonArg,
  },
  async run({ args }) {
    const verifyMode = resolveCliVerifyMode(args.verify, args.verifyMode)
    const r = await runDelete(args.symbol as string, args.from as string, {
      tsconfig: args.tsconfig as string | undefined,
      verify: verifyMode,
    })
    emitResult(r, !!args.apply, verifyMode !== 'none', !!args.json, resolveProfile(args.profile).agentProfile)
  },
})

interface MutatingResult {
  changes: { path: string, rel: string, before: string, after: string }[]
  scanned: number
  regressions: { file: string, line: number, col: number, code: number, message: string }[]
  warnings?: string[]
}

function emitResult(r: MutatingResult, apply: boolean, verify: boolean = false, json: boolean = false, agentProfile: boolean = false): void {
  const s = summarize(r.changes)
  const warnings = r.warnings ?? []
  if (json) {
    const blockedByRegression = verify && apply && r.regressions.length > 0
    const wrote = apply && !blockedByRegression
    if (wrote)
      writeChanges(r.changes)
    const payload = {
      applied: wrote,
      dryRun: !apply,
      blockedByRegression,
      scanned: r.scanned,
      summary: s,
      changes: r.changes.map(c => ({ path: c.rel, absolutePath: c.path, before: c.before, after: c.after })),
      regressions: r.regressions,
      warnings,
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
    if (blockedByRegression)
      process.exit(1)
    return
  }
  for (const w of warnings)
    process.stderr.write(`warning: ${w}\n`)
  if (agentProfile) {
    const blockedByRegression = verify && apply && r.regressions.length > 0
    process.stdout.write(`${profileHeader()}\n`)
    process.stdout.write(`changes: ${r.changes.length}/${r.scanned} files, +${s.linesAdded} -${s.linesRemoved} lines\n`)
    process.stdout.write(`mode: ${apply ? (blockedByRegression ? 'blocked' : 'applied') : 'dry-run'}\n`)
    if (r.changes.length) {
      process.stdout.write(`files:\n`)
      for (const c of r.changes)
        process.stdout.write(`  ${c.rel}\n`)
    }
    if (verify && r.regressions.length) {
      process.stdout.write(`regressions: ${r.regressions.length}\n`)
      for (const regression of r.regressions.slice(0, 20))
        process.stdout.write(`  ${regression.file}:${regression.line}:${regression.col} TS${regression.code} ${regression.message}\n`)
      if (r.regressions.length > 20)
        process.stdout.write(`  ... ${r.regressions.length - 20} more\n`)
      if (apply) {
        process.stderr.write(`\nripast: refusing to --apply; --no-verify to override.\n`)
        process.exit(1)
      }
    }
    if (apply) {
      writeChanges(r.changes)
      process.stdout.write(`applied: true\n`)
    }
    else {
      process.stdout.write(`apply: pass --apply to write, or --profile full to see diff\n`)
    }
    return
  }
  if (!apply) {
    process.stdout.write(`${s.files} file${s.files === 1 ? '' : 's'}, +${s.linesAdded} -${s.linesRemoved} lines\n\n`)
    printDiffs(r.changes)
  }
  if (verify && r.regressions.length) {
    process.stderr.write(`\n${formatRegressions(r.regressions, process.cwd())}\n`)
    if (apply) {
      process.stderr.write(`\nripast: refusing to --apply; --no-verify to override.\n`)
      process.exit(1)
    }
  }
  if (apply) {
    writeChanges(r.changes)
    for (const c of r.changes) process.stdout.write(`wrote ${c.rel}\n`)
  }
  const suffix = apply ? '' : ' (dry run, pass --apply to write)'
  process.stdout.write(`\n${r.changes.length}/${r.scanned} files changed${suffix}\n`)
}

const renameFileCmd = defineCommand({
  meta: { name: 'rename-file', description: 'Rename a file and rewrite every import site (including .vue consumers and component-name refs).' },
  args: {
    old: { type: 'positional', required: true },
    new: { type: 'positional', required: true },
    tsconfig: { type: 'string' },
    apply: applyArg,
    verify: verifyArg,
    verifyMode: verifyModeArg,
    profile: profileArg,
    json: jsonArg,
  },
  async run({ args }) {
    const verifyMode = resolveCliVerifyMode(args.verify, args.verifyMode)
    const recovered = recoverSmushedPair(args.old as string, args.new as string)
    if (recovered.warning)
      process.stderr.write(`warning: ${recovered.warning}\n`)
    const r = await runRenameFile(recovered.old, recovered.new, {
      tsconfig: args.tsconfig as string | undefined,
      verify: verifyMode,
    })
    const apply = !!args.apply
    const verify = verifyMode !== 'none'
    const json = !!args.json
    const { agentProfile } = resolveProfile(args.profile)
    const selfChangeDisplay = r.selfChange
      ? { path: r.fileMove.to, rel: relative(process.cwd(), r.fileMove.to), before: r.selfChange.before, after: r.selfChange.after }
      : null
    const displayChanges = selfChangeDisplay ? [selfChangeDisplay, ...r.changes] : r.changes
    const s = summarize(displayChanges)
    const blockedByRegression = verify && apply && r.regressions.length > 0
    const wrote = apply && !blockedByRegression

    if (wrote) {
      writeChanges(r.changes)
      mkdirSync(dirname(r.fileMove.to), { recursive: true })
      renameSync(r.fileMove.from, r.fileMove.to)
      if (selfChangeDisplay)
        writeChanges([selfChangeDisplay])
    }

    if (json) {
      process.stdout.write(`${JSON.stringify({
        applied: wrote,
        dryRun: !apply,
        blockedByRegression,
        scanned: r.scanned,
        summary: s,
        fileMove: r.fileMove,
        selfChange: r.selfChange,
        changes: r.changes.map(c => ({ path: c.rel, absolutePath: c.path, before: c.before, after: c.after })),
        regressions: r.regressions,
        warnings: r.warnings,
      })}\n`)
      if (blockedByRegression)
        process.exit(1)
      return
    }
    for (const w of r.warnings)
      process.stderr.write(`warning: ${w}\n`)
    if (agentProfile) {
      process.stdout.write(`${profileHeader()}\n`)
      process.stdout.write(`rename-file: ${recovered.old} -> ${recovered.new}\n`)
      process.stdout.write(`consumers: ${r.changes.length}/${r.scanned}, +${s.linesAdded} -${s.linesRemoved} lines\n`)
      if (selfChangeDisplay)
        process.stdout.write(`self: rewrote moved file's own relative imports\n`)
      process.stdout.write(`mode: ${apply ? (blockedByRegression ? 'blocked' : 'applied') : 'dry-run'}\n`)
      if (displayChanges.length) {
        process.stdout.write(`files:\n`)
        for (const c of displayChanges)
          process.stdout.write(`  ${c.rel}${selfChangeDisplay && c === selfChangeDisplay ? ' (moved file, intra-file imports)' : ''}\n`)
      }
      if (verify && r.regressions.length) {
        process.stdout.write(`regressions: ${r.regressions.length}\n`)
        if (apply) {
          process.stderr.write(`\nripast: refusing to --apply; --no-verify to override.\n`)
          process.exit(1)
        }
      }
      if (!apply)
        process.stdout.write(`apply: pass --apply to write, or --profile full to see diff\n`)
      return
    }
    if (!apply) {
      process.stdout.write(`rename ${args.old} -> ${args.new}\n`)
      const consumerCount = r.changes.length
      const selfSuffix = selfChangeDisplay ? ` (+ moved file's own imports)` : ''
      process.stdout.write(`${consumerCount} consumer file${consumerCount === 1 ? '' : 's'}${selfSuffix}, +${s.linesAdded} -${s.linesRemoved} lines\n\n`)
      printDiffs(displayChanges)
    }
    if (verify && r.regressions.length) {
      process.stderr.write(`\n${formatRegressions(r.regressions, process.cwd())}\n`)
      if (apply) {
        process.stderr.write(`\nripast: refusing to --apply; --no-verify to override.\n`)
        process.exit(1)
      }
    }
    if (wrote) {
      for (const c of r.changes) process.stdout.write(`wrote ${c.rel}\n`)
      if (selfChangeDisplay)
        process.stdout.write(`wrote ${selfChangeDisplay.rel} (moved file, intra-file imports)\n`)
      process.stdout.write(`renamed ${args.old} -> ${args.new}\n`)
    }
    const suffix = apply ? '' : ' (dry run, pass --apply to write)'
    process.stdout.write(`\n${r.changes.length} consumer file(s) updated${suffix}\n`)
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
    json: jsonArg,
  },
  async run({ args }) {
    const map = buildRenameMap(args.from as string | undefined, args.to as string | undefined, args.map as string | undefined)
    const r = await runCssClassRename(map, {
      glob: args.glob ? (args.glob as string).split(',') : undefined,
    })
    emitResult(r, !!args.apply, false, !!args.json, resolveProfile(args.profile).agentProfile)
  },
})

function buildRenameMap(from: string | undefined, to: string | undefined, mapPath: string | undefined): Map<string, string> {
  const hasPair = from != null && to != null
  const hasMap = !!mapPath
  if (hasPair && hasMap) {
    process.stderr.write(`ripast css-class-rename: pass either "from to" positionals OR --map, not both.\n`)
    process.exit(2)
  }
  if (!hasPair && !hasMap) {
    process.stderr.write(`ripast css-class-rename: missing input. Pass "from to" positionals or --map <file.json>.\n`)
    process.exit(2)
  }
  if (hasPair)
    return new Map([[from, to]])
  const raw = readFileSync(resolve(process.cwd(), mapPath!), 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch (err) {
    process.stderr.write(`ripast css-class-rename: --map file is not valid JSON (${(err as Error).message}).\n`)
    process.exit(2)
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    process.stderr.write(`ripast css-class-rename: --map must be a flat JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}.\n`)
    process.exit(2)
  }
  const entries: [string, string][] = []
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof v !== 'string') {
      process.stderr.write(`ripast css-class-rename: --map value for "${k}" is not a string.\n`)
      process.exit(2)
    }
    if (!k) {
      process.stderr.write(`ripast css-class-rename: --map has an empty key.\n`)
      process.exit(2)
    }
    entries.push([k, String(v)])
  }
  if (!entries.length) {
    process.stderr.write(`ripast css-class-rename: --map is empty.\n`)
    process.exit(2)
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
    json: jsonArg,
  },
  run({ args }) {
    const { agentProfile } = resolveProfile(args.profile)
    const by = resolveCssClassScanGroup(args.by)
    const base = {
      glob: args.glob ? (args.glob as string).split(',') : undefined,
      pattern: args.pattern ? (args.pattern as string).split(',') : undefined,
    }
    if (by === 'file') {
      const hits = runCssClassFileScan({ ...base, sort: resolveCssClassFileScanSort(args.sort) })
      if (agentProfile && !args.json) {
        process.stdout.write(`${profileHeader()}\n${formatAgentFileScanHits(hits)}\n`)
        return
      }
      process.stdout.write(`${formatFileScanHits(hits, !!args.json)}\n`)
      return
    }
    const hits = runCssClassScan({ ...base, sort: resolveCssClassScanSort(args.sort) })
    if (agentProfile && !args.json) {
      process.stdout.write(`${profileHeader()}\n${formatAgentScanHits(hits)}\n`)
      return
    }
    process.stdout.write(`${formatScanHits(hits, !!args.json)}\n`)
  },
})

function resolveCssClassScanGroup(raw: unknown): 'token' | 'file' {
  if (raw == null)
    return 'token'
  if (raw !== 'token' && raw !== 'file') {
    process.stderr.write(`ripast css-class-scan: --by must be "token" or "file".\n`)
    process.exit(2)
  }
  return raw
}

function resolveCssClassScanSort(raw: unknown): 'count-desc' | 'count-asc' | 'token' {
  if (raw == null)
    return 'count-desc'
  if (raw !== 'count-desc' && raw !== 'count-asc' && raw !== 'token') {
    process.stderr.write(`ripast css-class-scan: --sort must be "count-desc", "count-asc", or "token".\n`)
    process.exit(2)
  }
  return raw
}

function resolveCssClassFileScanSort(raw: unknown): 'unique-desc' | 'unique-asc' | 'count-desc' | 'count-asc' | 'file' {
  if (raw == null)
    return 'unique-desc'
  if (raw !== 'unique-desc' && raw !== 'unique-asc' && raw !== 'count-desc' && raw !== 'count-asc' && raw !== 'file') {
    process.stderr.write(`ripast css-class-scan: --sort with --by file must be "unique-desc", "unique-asc", "count-desc", "count-asc", or "file".\n`)
    process.exit(2)
  }
  return raw
}

const scopeArg = { type: 'string' as const, description: 'Restrict to a single .vue file (skips glob/rg).' }
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
    json: jsonArg,
  },
  async run({ args }) {
    const r = await runVueTemplateWrap(args.selector as string, args.wrapper as string, {
      glob: args.glob ? (args.glob as string).split(',') : undefined,
      scope: args.scope as string | undefined,
      rootOnly: args.rootOnly as boolean,
    })
    emitResult(r, !!args.apply, false, !!args.json, resolveProfile(args.profile).agentProfile)
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
    json: jsonArg,
  },
  async run({ args }) {
    const r = await runVueTemplateUnwrap(args.selector as string, {
      glob: args.glob ? (args.glob as string).split(',') : undefined,
      scope: args.scope as string | undefined,
      rootOnly: args.rootOnly as boolean,
    })
    emitResult(r, !!args.apply, false, !!args.json, resolveProfile(args.profile).agentProfile)
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
    json: jsonArg,
  },
  async run({ args }) {
    const { agentProfile } = resolveProfile(args.profile)
    const opts = {
      glob: args.glob ? (args.glob as string).split(',') : undefined,
      source: resolveComponentsSource(args.source),
    }
    if (args.name) {
      const detail = await buildComponentDetail(args.name as string, opts)
      if (!detail) {
        process.stderr.write(`ripast components: no component named "${args.name}".\n`)
        process.exit(1)
      }
      if (args.json) {
        process.stdout.write(`${JSON.stringify(detail, null, 2)}\n`)
        return
      }
      process.stdout.write(`${formatDetail(detail)}\n`)
      return
    }
    const inv = await buildComponentInventory(opts)
    if (args.json) {
      process.stdout.write(`${JSON.stringify(args.dups ? inv.duplicates : inv, null, 2)}\n`)
      return
    }
    if (args.dups) {
      if (!inv.duplicates.length) {
        process.stdout.write('no duplicate-name groups\n')
        return
      }
      const lines: string[] = []
      for (const dup of inv.duplicates) {
        lines.push(dup.name)
        for (const e of dup.entries)
          lines.push(`  ${e.rel}${e.shadowed ? ' (shadowed)' : ''}`)
      }
      process.stdout.write(`${lines.join('\n')}\n`)
      return
    }
    if (agentProfile) {
      process.stdout.write(`${profileHeader()}\n${formatAgentInventory(inv)}\n`)
      return
    }
    process.stdout.write(`${formatInventory(inv)}\n`)
  },
})

function resolveComponentsSource(raw: unknown): 'auto' | 'manifest' | 'filesystem' | undefined {
  if (raw == null)
    return undefined
  if (raw !== 'auto' && raw !== 'manifest' && raw !== 'filesystem') {
    process.stderr.write(`ripast components: --source must be "auto", "manifest", or "filesystem".\n`)
    process.exit(2)
  }
  return raw
}

const doctorCmd = defineCommand({
  meta: { name: 'doctor', description: 'Health checks over the AST graph. Suppress per-file with `// ripast-doctor-ignore-file[: c1,c2]` or per-line with `// ripast-doctor-ignore-next-line[: c1,c2]`.' },
  args: {
    glob: globArg,
    checks: { type: 'string', description: 'Comma-separated subset: dangling-reexport, stale-reexport, stale-import, duplicate-export, orphan-file, orphan-test, inconsistent-import-path, circular-dep, phantom-component, shadowed-component, cross-realm-import, stale-nuxt-config-ref. Default: all (adapter checks run when their framework is detected).' },
    entry: { type: 'string', description: 'Comma-separated entry files exempt from orphan check (relative to cwd).' },
    fix: { type: 'boolean', default: false, description: 'Compute safe fixes for inconsistent-import-path and dangling-reexport findings.' },
    apply: applyArg,
    changed: { type: 'string', description: 'Report only findings on files changed vs git. No value = dirty working tree (staged+unstaged+untracked). With value (e.g. main, HEAD~1) = diff against that ref. Full project is still scanned so cross-file checks stay accurate.' },
    profile: profileArg,
    json: jsonArg,
  },
  async run({ args }) {
    const { agentProfile } = resolveProfile(args.profile)
    const checks = args.checks ? (args.checks as string).split(',') as any : undefined
    const entry = args.entry ? (args.entry as string).split(',') : undefined
    let changedFiles: string[] | undefined
    if (args.changed != null) {
      const ref = typeof args.changed === 'string' && args.changed !== '' && args.changed !== 'true' ? args.changed : undefined
      changedFiles = getChangedFiles({ cwd: process.cwd(), ref })
      if (!changedFiles.length) {
        process.stderr.write(`ripast doctor: --changed${ref ? ` ${ref}` : ''} matched no files; nothing to report.\n`)
        return
      }
    }
    const report = await runDoctor({
      glob: args.glob ? (args.glob as string).split(',') : undefined,
      checks,
      entry,
      changedFiles,
    })
    if (args.fix) {
      const fix = buildDoctorFixes(report, process.cwd())
      if (args.json) {
        process.stdout.write(`${JSON.stringify({
          findings: report.findings,
          filesScanned: report.filesScanned,
          fix: {
            applied: !!args.apply,
            files: fix.changes.length,
            fixed: fix.fixed,
            skipped: fix.skipped.length,
          },
          changes: args.apply ? undefined : fix.changes.map(c => ({ path: c.rel, before: c.before, after: c.after })),
        })}\n`)
        if (args.apply && fix.changes.length)
          writeChanges(fix.changes)
        if (fix.skipped.length)
          process.exit(1)
        return
      }
      const s = summarize(fix.changes)
      process.stdout.write(`doctor --fix: ${fix.fixed.length} fixable / ${fix.skipped.length} non-fixable findings\n`)
      process.stdout.write(`${fix.changes.length} file${fix.changes.length === 1 ? '' : 's'}, +${s.linesAdded} -${s.linesRemoved} lines\n\n`)
      if (!args.apply) {
        printDiffs(fix.changes)
        process.stdout.write(`\n(dry run, pass --apply to write)\n`)
      }
      else {
        writeChanges(fix.changes)
        for (const c of fix.changes) process.stdout.write(`wrote ${c.rel}\n`)
      }
      if (fix.skipped.length)
        process.exit(1)
      return
    }
    if (agentProfile && !args.json) {
      process.stdout.write(`${profileHeader()}\n${formatAgentDoctorReport(report)}\n`)
      return
    }
    process.stdout.write(formatDoctorReport(report, !!args.json))
    if (report.findings.length)
      process.exit(1)
  },
})

runMain(defineCommand({
  meta: { name: 'ripast', description: 'AST-aware refactor primitives. ripgrep-prefiltered, dry-run by default.' },
  subCommands: {
    'scan': scanCmd,
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
}))
