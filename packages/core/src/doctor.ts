import type { DoctorAdapter, DoctorFinding, FrameworkName } from './adapter.ts'
import type { DoctorIndex, DoctorIndexFile } from './doctor-index.ts'
import type { EngineServices } from './engine.ts'
import type { DeclarationTree, DeclarationTreeFile, ScanOptions } from './scan.ts'
import type { FileChange } from './util.ts'
import type { Verification } from './verification.ts'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import process from 'node:process'
import { walk } from 'oxc-walker'
import { buildDoctorIndex } from './doctor-index.ts'
import { buildDeclarationTree } from './scan.ts'
import { parseFile } from './util.ts'

export type DoctorCheck = 'dangling-reexport' | 'stale-reexport' | 'stale-import' | 'duplicate-export' | 'orphan-file' | 'orphan-test' | 'inconsistent-import-path' | 'circular-dep' | string

export type { DoctorFinding } from './adapter.ts'

export interface DoctorReport {
  findings: DoctorFinding[]
  filesScanned: number
}

export interface DoctorOptions extends ScanOptions {
  checks?: DoctorCheck[]
  entry?: string[]
  /** Frameworks to load doctor adapters from. Defaults to autodetect. */
  frameworks?: FrameworkName[]
  /** Disable adapter loading entirely. */
  noAdapters?: boolean
  /**
   * When set, restrict reported findings to files in this set (paths relative
   * to cwd). The full project is still scanned so cross-file checks remain
   * accurate; only the *output* is filtered.
   */
  changedFiles?: string[]
}

export interface ChangedFilesOptions {
  cwd?: string
  /** Git ref to diff against. If omitted, returns the dirty working tree set. */
  ref?: string
}

/**
 * Resolve the set of "changed" files relative to cwd. With a ref, returns
 * `git diff --name-only <ref>...HEAD` plus untracked. Without, returns the
 * dirty working tree (staged + unstaged + untracked).
 */
export function getChangedFiles(opts: ChangedFilesOptions = {}): string[] {
  const cwd = opts.cwd ?? process.cwd()
  const out = new Set<string>()
  const collect = (args: string[]): void => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (r.status !== 0)
      return
    for (const line of r.stdout.split('\n')) {
      const path = line.trim()
      if (path)
        out.add(path)
    }
  }
  if (opts.ref) {
    collect(['diff', '--name-only', `${opts.ref}...HEAD`])
    collect(['diff', '--name-only', 'HEAD'])
    collect(['ls-files', '--others', '--exclude-standard'])
  }
  else {
    // Dirty: staged + unstaged + untracked.
    const r = spawnSync('git', ['status', '--porcelain', '-z'], { cwd, encoding: 'utf8' })
    if (r.status === 0) {
      for (const entry of r.stdout.split('\0')) {
        if (!entry)
          continue
        // Porcelain format: `XY path` or `XY orig -> path` for renames.
        const path = entry.slice(3)
        if (path)
          out.add(path)
      }
    }
  }
  return [...out]
}

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js']

function resolveRelative(fromFile: string, specifier: string, cwd: string, engine?: EngineServices): string | null {
  if (!specifier.startsWith('.'))
    return null
  const base = resolve(dirname(resolve(cwd, fromFile)), specifier)
  return tryExts(base, engine)
}

function tryExts(base: string, engine?: EngineServices): string | null {
  for (const ext of [...RESOLVE_EXTS, ...engine?.suffixes ?? []]) {
    const candidate = base + ext
    if (!existsSync(candidate))
      continue
    try {
      if (statSync(candidate).isFile())
        return candidate
    }
    catch {}
  }
  return null
}

/**
 * Alias map built from project tsconfigs. Each entry maps a glob (e.g.
 * `#sitemap/*`) to an array of absolute target patterns (e.g.
 * `/abs/src/runtime/*`). Patterns may or may not contain `*`.
 */
type AliasMap = Map<string, string[]>

function stripJsonComments(src: string): string {
  // Tolerant strip of // and /* */ comments and trailing commas. user configs can be JSONC.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,(\s*[}\]])/g, '$1')
}

function loadAliasMap(cwd: string, engine?: EngineServices): AliasMap {
  const map: AliasMap = new Map()
  const candidates = [
    'tsconfig.json',
    ...engine?.extensions.flatMap(extension => extension.configPaths ?? []) ?? [],
  ]
  for (const rel of candidates) {
    const abs = resolve(cwd, rel)
    if (!existsSync(abs))
      continue
    let raw: string
    try {
      raw = readFileSync(abs, 'utf8')
    }
    catch {
      continue
    }
    let parsed: any
    try {
      parsed = JSON.parse(stripJsonComments(raw))
    }
    catch {
      continue
    }
    const co = parsed?.compilerOptions ?? {}
    const paths = co.paths
    if (!paths || typeof paths !== 'object')
      continue
    const baseUrl = co.baseUrl ? resolve(dirname(abs), co.baseUrl) : dirname(abs)
    for (const [alias, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets))
        continue
      const resolvedTargets: string[] = []
      for (const t of targets) {
        if (typeof t !== 'string')
          continue
        resolvedTargets.push(resolve(baseUrl, t))
      }
      if (resolvedTargets.length)
        map.set(alias, resolvedTargets)
    }
  }
  return map
}

function resolveAlias(specifier: string, aliases: AliasMap, engine?: EngineServices): string | null {
  for (const [glob, targets] of aliases) {
    if (glob.includes('*')) {
      const prefix = glob.slice(0, glob.indexOf('*'))
      const suffix = glob.slice(glob.indexOf('*') + 1)
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix))
        continue
      const captured = specifier.slice(prefix.length, specifier.length - suffix.length)
      for (const target of targets) {
        const base = target.replace('*', captured)
        const file = tryExts(base, engine)
        if (file)
          return file
      }
    }
    else if (specifier === glob) {
      for (const target of targets) {
        const file = tryExts(target, engine)
        if (file)
          return file
      }
    }
  }
  return null
}

function findDanglingReexports(index: DoctorIndex, cwd: string): DoctorFinding[] {
  const out: DoctorFinding[] = []
  const seen = new Set<string>()
  for (const file of index.files) {
    for (const re of file.namedReexports) {
      if (!re.source.startsWith('.'))
        continue
      if (resolveRelative(file.file, re.source, cwd, index.engine))
        continue
      const key = `${file.file}::${re.source}::${re.line}`
      if (seen.has(key))
        continue
      seen.add(key)
      out.push({
        check: 'dangling-reexport',
        file: file.file,
        line: re.line,
        message: `re-export from "${re.source}" does not resolve`,
        detail: { specifier: re.source },
      })
    }
  }
  return out
}

function findDuplicateExports(tree: DeclarationTree): DoctorFinding[] {
  const byName = new Map<string, { file: DeclarationTreeFile, line: number }[]>()
  for (const file of tree.files) {
    for (const decl of file.declarations) {
      if (!decl.exported)
        continue
      if (decl.name === 'default')
        continue
      const arr = byName.get(decl.name) ?? []
      arr.push({ file, line: decl.line })
      byName.set(decl.name, arr)
    }
  }
  const out: DoctorFinding[] = []
  for (const [name, hits] of byName) {
    if (hits.length < 2)
      continue
    const byFile = new Map<string, number>()
    for (const h of hits) {
      if (!byFile.has(h.file.file))
        byFile.set(h.file.file, h.line)
    }
    if (byFile.size < 2)
      continue
    const unique = [...byFile.keys()]
    for (const [f, line] of byFile) {
      out.push({
        check: 'duplicate-export',
        file: f,
        line,
        message: `"${name}" is exported from ${unique.length} files (possible shadow type)`,
        detail: { name, files: unique },
      })
    }
  }
  return out
}

// Files that are conventionally entry points to build tooling rather than
// imported by source code. Universally true across TS projects.
const CONFIG_BASENAME_RE = /^[a-z][a-z0-9-]*\.config(?:\.[a-z0-9-]+)?\.[mc]?[jt]sx?$/i
const ENTRY_BASENAMES = new Set([
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'build.config.ts',
  'build.config.js',
  'build.config.mjs',
  'tsup.config.ts',
  'rollup.config.ts',
  'rollup.config.js',
  'rollup.config.mjs',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.mts',
  'playwright.config.ts',
  'playwright.config.js',
  'astro.config.ts',
  'astro.config.mjs',
  'svelte.config.js',
  'unbuild.config.ts',
  'obuild.config.ts',
  'tsconfig.json',
])
const SKIP_DIR_RE = /(?:^|\/)(?:examples?|playground|sandbox|fixtures?|__fixtures__)(?:\/|$)/

function basenameOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i < 0 ? p : p.slice(i + 1)
}

function isConventionalEntry(rel: string): boolean {
  const base = basenameOf(rel)
  if (ENTRY_BASENAMES.has(base))
    return true
  if (CONFIG_BASENAME_RE.test(base))
    return true
  if (rel.endsWith('.d.ts') || rel.endsWith('.d.mts') || rel.endsWith('.d.cts'))
    return true
  if (SKIP_DIR_RE.test(rel))
    return true
  return false
}

function collectPackageJsonEntries(cwd: string): Set<string> {
  const out = new Set<string>()
  const seen = new Set<string>()
  const scan = (dir: string, depth: number): void => {
    if (depth > 4)
      return
    const pkgPath = resolve(cwd, dir, 'package.json')
    if (seen.has(pkgPath))
      return
    seen.add(pkgPath)
    let raw: string
    try {
      raw = readFileSync(pkgPath, 'utf8')
    }
    catch {
      return
    }
    let pkg: any
    try {
      pkg = JSON.parse(raw)
    }
    catch {
      return
    }
    const candidates: string[] = []
    if (typeof pkg.main === 'string')
      candidates.push(pkg.main)
    if (typeof pkg.module === 'string')
      candidates.push(pkg.module)
    if (typeof pkg.types === 'string')
      candidates.push(pkg.types)
    if (typeof pkg.bin === 'string') {
      candidates.push(pkg.bin)
    }
    else if (pkg.bin && typeof pkg.bin === 'object') {
      for (const v of Object.values(pkg.bin)) {
        if (typeof v === 'string')
          candidates.push(v as string)
      }
    }
    const walkExports = (val: any): void => {
      if (typeof val === 'string') {
        candidates.push(val)
        return
      }
      if (val && typeof val === 'object') {
        for (const v of Object.values(val))
          walkExports(v)
      }
    }
    walkExports(pkg.exports)
    for (const c of candidates) {
      if (typeof c !== 'string' || !c.startsWith('.'))
        continue
      const abs = resolve(cwd, dir, c)
      out.add(relative(cwd, abs))
      // Source counterpart of dist artifact: ./dist/foo.mjs → ./src/foo.ts, .tsx, source suffixes, /index.ts.
      const distMatch = c.match(/^\.\/dist\/(.+?)\.(?:mjs|cjs|js|d\.[mc]?ts)$/)
      if (distMatch) {
        const stem = distMatch[1]!
        for (const srcCandidate of [`./src/${stem}.ts`, `./src/${stem}.tsx`, `./src/${stem}/index.ts`, `./src/${stem}/index.tsx`]) {
          const srcAbs = resolve(cwd, dir, srcCandidate)
          if (existsSync(srcAbs))
            out.add(relative(cwd, srcAbs))
        }
      }
    }
  }
  scan('.', 0)
  // Workspaces / packages dirs
  for (const subdir of ['packages', 'apps', 'modules', 'integrations']) {
    let entries: string[]
    try {
      entries = readdirSync(resolve(cwd, subdir))
    }
    catch {
      continue
    }
    for (const name of entries)
      scan(`${subdir}/${name}`, 1)
  }
  return out
}

function findOrphanFiles(tree: DeclarationTree, cwd: string, entries: Set<string>, engine?: EngineServices): DoctorFinding[] {
  const inbound = new Set<string>()
  const aliases = loadAliasMap(cwd, engine)
  for (const file of tree.files) {
    for (const spec of [...file.imports, ...file.reexports]) {
      const resolved = resolveRelative(file.file, spec, cwd, engine) ?? resolveAlias(spec, aliases, engine)
      if (resolved)
        inbound.add(relative(cwd, resolved))
    }
  }
  const pkgEntries = collectPackageJsonEntries(cwd)
  const out: DoctorFinding[] = []
  for (const file of tree.files) {
    if (inbound.has(file.file))
      continue
    if (entries.has(file.file))
      continue
    if (pkgEntries.has(file.file))
      continue
    if (isConventionalEntry(file.file))
      continue
    if (!file.declarations.some(d => d.exported))
      continue
    out.push({
      check: 'orphan-file',
      file: file.file,
      message: `no inbound imports and not listed as an entry`,
    })
  }
  return out
}

function findStaleReexports(index: DoctorIndex, cwd: string): DoctorFinding[] {
  const exports = buildTransitiveExports(index, cwd)
  const out: DoctorFinding[] = []
  for (const file of index.files) {
    for (const re of file.namedReexports) {
      if (re.imported === '*')
        continue
      if (!re.source.startsWith('.'))
        continue
      const resolved = resolveRelative(file.file, re.source, cwd, index.engine)
      if (!resolved)
        continue
      const targetRel = relative(cwd, resolved)
      const exported = exports.get(targetRel)
      if (!exported)
        continue
      if (exported.has(re.imported))
        continue
      out.push({
        check: 'stale-reexport',
        file: file.file,
        line: re.line,
        message: `re-exports "${re.imported}" from "${re.source}" but target no longer exports it`,
        detail: { name: re.imported, source: re.source, target: targetRel },
      })
    }
  }
  return out
}

function buildTransitiveExports(index: DoctorIndex, cwd: string) {
  const byRel = new Map<string, DoctorIndexFile>()
  for (const f of index.files)
    byRel.set(f.file, f)
  const cache = new Map<string, Set<string> | null>()
  function get(rel: string, stack: Set<string>): Set<string> | null {
    if (stack.has(rel))
      return new Set()
    if (cache.has(rel))
      return cache.get(rel)!
    const file = byRel.get(rel)
    if (!file) {
      cache.set(rel, null)
      return null
    }
    stack.add(rel)
    const out = new Set(file.exportedNames)
    for (const re of file.namedReexports) {
      if (re.exported !== '*' && re.exported !== '<namespace>')
        out.add(re.exported)
      if (re.imported === '*') {
        const resolved = resolveRelative(rel, re.source, cwd, index.engine)
        if (!resolved)
          continue
        const inner = get(relative(cwd, resolved), stack)
        if (inner) {
          for (const n of inner) {
            if (n !== 'default')
              out.add(n)
          }
        }
      }
    }
    stack.delete(rel)
    cache.set(rel, out)
    return out
  }
  return { get: (rel: string) => get(rel, new Set()) }
}

function findStaleImports(index: DoctorIndex, cwd: string): DoctorFinding[] {
  const exports = buildTransitiveExports(index, cwd)
  const out: DoctorFinding[] = []
  for (const file of index.files) {
    const reported = new Set<string>()
    for (const imp of file.imports) {
      if (!imp.imported || imp.imported === '*' || imp.imported === 'default')
        continue
      if (!imp.source.startsWith('.'))
        continue
      const resolved = resolveRelative(file.file, imp.source, cwd, index.engine)
      if (!resolved)
        continue
      const targetRel = relative(cwd, resolved)
      const names = exports.get(targetRel)
      if (!names)
        continue
      if (names.has(imp.imported))
        continue
      const key = `${imp.imported}@${imp.source}`
      if (reported.has(key))
        continue
      reported.add(key)
      out.push({
        check: 'stale-import',
        file: file.file,
        line: imp.line,
        message: `imports "${imp.imported}" from "${imp.source}" but target no longer exports it`,
        detail: { name: imp.imported, source: imp.source, target: targetRel },
      })
    }
  }
  return out
}

function findCircularDeps(index: DoctorIndex, cwd: string): DoctorFinding[] {
  const adj = new Map<string, string[]>()
  for (const file of index.files) {
    const edges: string[] = []
    const seen = new Set<string>()
    // Type-only edges are erased at runtime; they don't form real cycles.
    const specs = [
      ...file.imports.filter(i => !i.typeOnly).map(i => i.source),
      ...file.namedReexports.filter(r => !r.typeOnly).map(r => r.source),
    ]
    for (const spec of specs) {
      if (!spec.startsWith('.'))
        continue
      const resolved = resolveRelative(file.file, spec, cwd, index.engine)
      if (!resolved)
        continue
      const targetRel = relative(cwd, resolved)
      if (seen.has(targetRel))
        continue
      seen.add(targetRel)
      edges.push(targetRel)
    }
    adj.set(file.file, edges)
  }
  // Tarjan's SCC
  const indexOf = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []
  let counter = 0
  function strongconnect(v: string): void {
    indexOf.set(v, counter)
    lowlink.set(v, counter)
    counter++
    stack.push(v)
    onStack.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!indexOf.has(w)) {
        strongconnect(w)
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!))
      }
      else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, indexOf.get(w)!))
      }
    }
    if (lowlink.get(v) === indexOf.get(v)) {
      const scc: string[] = []
      while (true) {
        const w = stack.pop()!
        onStack.delete(w)
        scc.push(w)
        if (w === v)
          break
      }
      sccs.push(scc)
    }
  }
  for (const v of adj.keys()) {
    if (!indexOf.has(v))
      strongconnect(v)
  }
  const out: DoctorFinding[] = []
  for (const scc of sccs) {
    if (scc.length < 2) {
      const v = scc[0]
      if (!(adj.get(v) ?? []).includes(v))
        continue
    }
    const sorted = [...scc].sort()
    for (const file of sorted) {
      out.push({
        check: 'circular-dep',
        file,
        message: `circular dependency across ${scc.length} file(s): ${sorted.slice(0, 4).join(' -> ')}${sorted.length > 4 ? ' -> ...' : ''}`,
        detail: { cycle: sorted },
      })
    }
  }
  return out
}

function findOrphanTests(tree: DeclarationTree, _cwd: string, engine?: EngineServices): DoctorFinding[] {
  const all = new Set(tree.files.map(f => f.file))
  const SUBJECT_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', ...engine?.suffixes ?? []]
  const TEST_RE = /^(.+?)\.(?:test|spec)\.([cm]?[jt]sx?)$/
  const out: DoctorFinding[] = []
  for (const file of tree.files) {
    const m = file.file.match(TEST_RE)
    if (!m)
      continue
    const stem = m[1]!
    const hasSubject = SUBJECT_EXTS.some(ext => all.has(`${stem}${ext}`))
      || all.has(`${stem}/index.ts`)
      || all.has(`${stem}/index.tsx`)
      || all.has(`${stem}/index.js`)
    if (hasSubject)
      continue
    // Ignore tests that live in dedicated dirs (integration/e2e) where colocation
    // isn't expected. Match path segments only, not the .test. infix.
    const dirSegments = file.file.split(/[\\/]/).slice(0, -1)
    if (dirSegments.some(seg => /^(?:tests?|__tests__|e2e|integration|fixtures)$/.test(seg)))
      continue
    out.push({
      check: 'orphan-test',
      file: file.file,
      message: `test file has no sibling source (looked for ${stem}.{configured source suffixes})`,
      detail: { stem },
    })
  }
  return out
}

function findInconsistentImportPaths(index: DoctorIndex, cwd: string): DoctorFinding[] {
  // For each (target, file) pair record the actual specifier used. To classify
  // each usage, we collapse it to a style flavour that's invariant under file
  // depth: 'alias' (non-relative bare/aliased), 'relative-ext' (relative with
  // explicit extension), or 'relative' (relative without extension). Flag a
  // file when its flavour is in the minority.
  const usages = new Map<string, { file: string, spec: string, flavour: ImportFlavour, hasExt: boolean, line: number }[]>()
  for (const file of index.files) {
    const seen = new Set<string>()
    for (const imp of file.imports) {
      const key = `${imp.source}@${file.file}`
      if (seen.has(key))
        continue
      seen.add(key)
      const resolved = resolveRelative(file.file, imp.source, cwd, index.engine)
      if (!resolved)
        continue
      const target = relative(cwd, resolved)
      const flavour: ImportFlavour = imp.source.startsWith('.')
        ? (MODULE_EXT_RE.test(imp.source) ? 'relative-ext' : 'relative')
        : 'alias'
      const hasExt = MODULE_EXT_RE.test(imp.source)
      const arr = usages.get(target) ?? []
      arr.push({ file: file.file, spec: imp.source, flavour, hasExt, line: imp.line })
      usages.set(target, arr)
    }
  }
  const out: DoctorFinding[] = []
  for (const [target, list] of usages) {
    if (list.length < 2)
      continue
    const counts = new Map<ImportFlavour, number>()
    const canonicalSpecByFlavour = new Map<ImportFlavour, string>()
    for (const u of list) {
      counts.set(u.flavour, (counts.get(u.flavour) ?? 0) + 1)
      if (!canonicalSpecByFlavour.has(u.flavour))
        canonicalSpecByFlavour.set(u.flavour, u.spec)
    }
    if (counts.size < 2)
      continue
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1])
    const [winnerFlavour, winnerCount] = ranked[0]
    for (const u of list) {
      if (u.flavour === winnerFlavour)
        continue
      const winnerExample = canonicalSpecByFlavour.get(winnerFlavour)!
      out.push({
        check: 'inconsistent-import-path',
        file: u.file,
        line: u.line,
        message: `imports "${target}" using ${u.flavour} style ("${u.spec}"); majority (${winnerCount}) use ${winnerFlavour} style (e.g. "${winnerExample}")`,
        detail: {
          target,
          used: u.spec,
          usedFlavour: u.flavour,
          canonicalFlavour: winnerFlavour,
          canonicalCount: winnerCount,
          canonicalExample: winnerExample,
        },
      })
    }
  }
  return out
}

type ImportFlavour = 'alias' | 'relative' | 'relative-ext'

async function loadDoctorAdapters(cwd: string, opts: DoctorOptions): Promise<DoctorAdapter[]> {
  if (opts.noAdapters)
    return []
  const adapters = opts.engine?.extensions.flatMap(extension => extension.semantic?.doctor ? [extension.semantic.doctor] : []) ?? []
  return adapters
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = opts.cwd ?? process.cwd()
  const checks = new Set<DoctorCheck>(opts.checks ?? ['dangling-reexport', 'stale-reexport', 'stale-import', 'duplicate-export', 'orphan-file', 'orphan-test', 'inconsistent-import-path', 'circular-dep'])
  const tree = buildDeclarationTree({ cwd, glob: opts.glob, exports: 'all' })
  const needsIndex = checks.has('dangling-reexport') || checks.has('stale-reexport') || checks.has('stale-import') || checks.has('inconsistent-import-path') || checks.has('circular-dep')
  const index = needsIndex ? buildDoctorIndex({ cwd, engine: opts.engine, glob: opts.glob }) : null
  const adapters = await loadDoctorAdapters(cwd, opts)
  const entries = new Set((opts.entry ?? []).map(file => relative(cwd, resolve(cwd, file))))
  for (const adapter of adapters) {
    for (const entry of adapter.entryFiles?.(cwd) ?? [])
      entries.add(entry)
  }
  const findings: DoctorFinding[] = []
  if (checks.has('dangling-reexport') && index)
    findings.push(...findDanglingReexports(index, cwd))
  if (checks.has('stale-reexport') && index)
    findings.push(...findStaleReexports(index, cwd))
  if (checks.has('stale-import') && index)
    findings.push(...findStaleImports(index, cwd))
  if (checks.has('duplicate-export'))
    findings.push(...findDuplicateExports(tree))
  if (checks.has('orphan-file'))
    findings.push(...findOrphanFiles(tree, cwd, entries, opts.engine))
  if (checks.has('orphan-test'))
    findings.push(...findOrphanTests(tree, cwd, opts.engine))
  if (checks.has('inconsistent-import-path') && index)
    findings.push(...findInconsistentImportPaths(index, cwd))
  if (checks.has('circular-dep') && index)
    findings.push(...findCircularDeps(index, cwd))
  const adapterIndex = index ?? (adapters.some(a => a.extraFindings) ? buildDoctorIndex({ cwd, engine: opts.engine, glob: opts.glob }) : null)
  for (const adapter of adapters)
    findings.push(...adapter.extraFindings?.(cwd, adapterIndex ? { index: adapterIndex } : undefined) ?? [])
  const ignores = buildIgnoreIndex(cwd, findings)
  const changedSet = opts.changedFiles ? new Set(opts.changedFiles.map(file => resolve(cwd, file))) : null
  const filtered = findings.filter((f) => {
    if (changedSet && !changedSet.has(resolve(cwd, f.file)))
      return false
    if (isIgnored(ignores, f))
      return false
    for (const adapter of adapters) {
      if (adapter.filterFinding && !adapter.filterFinding(cwd, f))
        return false
    }
    return true
  })
  filtered.sort((a, b) => a.file.localeCompare(b.file) || a.check.localeCompare(b.check))
  return { findings: filtered, filesScanned: tree.files.length }
}

interface FileIgnore {
  all: boolean
  checks: Set<string>
  /** Map 1-based line -> set of checks to ignore on that line ('*' = all). */
  perLine: Map<number, Set<string>>
}

function buildIgnoreIndex(cwd: string, findings: DoctorFinding[]): Map<string, FileIgnore> {
  const byFile = new Map<string, FileIgnore>()
  const seenFiles = new Set<string>()
  for (const f of findings) {
    if (seenFiles.has(f.file))
      continue
    seenFiles.add(f.file)
    const abs = resolve(cwd, f.file)
    let source: string
    try {
      source = readFileSync(abs, 'utf8')
    }
    catch {
      continue
    }
    const lines = source.split('\n')
    const ignore: FileIgnore = { all: false, checks: new Set(), perLine: new Map() }
    const head = lines.slice(0, 10).join('\n')
    const fileDirective = /\/\/\s*ripide-doctor-ignore-file\s*(?::\s*([^\n]+))?/.exec(head)
    if (fileDirective) {
      const list = (fileDirective[1] ?? '').trim()
      if (!list) {
        ignore.all = true
      }
      else {
        for (const name of list.split(/[,\s]+/).filter(Boolean))
          ignore.checks.add(name)
      }
    }
    const lineRe = /\/\/\s*ripide-doctor-ignore-next-line\s*(?::\s*([^\n]+))?/
    for (let i = 0; i < lines.length; i++) {
      const m = lineRe.exec(lines[i]!)
      if (!m)
        continue
      const targetLine = i + 2 // 1-based line below the directive
      const set = ignore.perLine.get(targetLine) ?? new Set<string>()
      const list = (m[1] ?? '').trim()
      if (!list) {
        set.add('*')
      }
      else {
        for (const name of list.split(/[,\s]+/).filter(Boolean))
          set.add(name)
      }
      ignore.perLine.set(targetLine, set)
    }
    if (ignore.all || ignore.checks.size || ignore.perLine.size)
      byFile.set(f.file, ignore)
  }
  return byFile
}

function isIgnored(ignores: Map<string, FileIgnore>, finding: DoctorFinding): boolean {
  const entry = ignores.get(finding.file)
  if (!entry)
    return false
  if (entry.all)
    return true
  if (entry.checks.has(finding.check))
    return true
  if (finding.line != null) {
    const perLine = entry.perLine.get(finding.line)
    if (perLine && (perLine.has('*') || perLine.has(finding.check)))
      return true
  }
  return false
}

export type FixableCheck = 'inconsistent-import-path' | 'dangling-reexport' | 'stale-import'
const FIXABLE: ReadonlySet<string> = new Set<FixableCheck>(['inconsistent-import-path', 'dangling-reexport', 'stale-import'])

export interface DoctorFixResult {
  verification: Verification
  changes: FileChange[]
  fixed: DoctorFinding[]
  skipped: DoctorFinding[]
}

export function buildDoctorFixes(report: DoctorReport, cwd: string = process.cwd()): DoctorFixResult {
  const fixed: DoctorFinding[] = []
  const skipped: DoctorFinding[] = []
  interface Slot {
    abs: string
    rel: string
    textualEdits: { from: string, to: string }[]
    deleteLines: string[]
    staleImports: { source: string, imported: string, finding: DoctorFinding }[]
  }
  const editsByFile = new Map<string, Slot>()
  const slotFor = (finding: DoctorFinding): Slot => {
    const abs = resolve(cwd, finding.file)
    const existing = editsByFile.get(finding.file)
    if (existing)
      return existing
    const slot: Slot = { abs, rel: finding.file, textualEdits: [], deleteLines: [], staleImports: [] }
    editsByFile.set(finding.file, slot)
    return slot
  }
  for (const finding of report.findings) {
    if (!FIXABLE.has(finding.check)) {
      skipped.push(finding)
      continue
    }
    const slot = slotFor(finding)
    if (finding.check === 'inconsistent-import-path') {
      const used = String(finding.detail?.used ?? '')
      const target = String(finding.detail?.target ?? '')
      const canonicalFlavour = finding.detail?.canonicalFlavour as ImportFlavour | undefined
      const canonicalExample = String(finding.detail?.canonicalExample ?? '')
      if (!used || !target || !canonicalFlavour) {
        skipped.push(finding)
        continue
      }
      const to = canonicalFlavour === 'alias'
        ? canonicalExample
        : relativeSpecifier(finding.file, target, canonicalFlavour === 'relative-ext')
      if (to === used) {
        fixed.push(finding)
        continue
      }
      slot.textualEdits.push({ from: used, to })
      fixed.push(finding)
    }
    else if (finding.check === 'dangling-reexport') {
      const spec = String(finding.detail?.specifier ?? '')
      if (!spec) {
        skipped.push(finding)
        continue
      }
      slot.deleteLines.push(spec)
      fixed.push(finding)
    }
    else if (finding.check === 'stale-import') {
      const source = String(finding.detail?.source ?? '')
      const imported = String(finding.detail?.name ?? '')
      if (!source || !imported) {
        skipped.push(finding)
        continue
      }
      slot.staleImports.push({ source, imported, finding })
    }
  }
  const changes: FileChange[] = []
  for (const slot of editsByFile.values()) {
    let source: string
    try {
      source = readFileSync(slot.abs, 'utf8')
    }
    catch {
      continue
    }
    let after = source
    if (slot.staleImports.length) {
      const result = removeStaleImportSpecifiers(slot.abs, after, slot.staleImports)
      after = result.source
      for (const f of result.fixed)
        fixed.push(f)
      for (const s of result.skipped)
        skipped.push(s)
    }
    for (const spec of slot.deleteLines)
      after = deleteExportLine(after, spec)
    for (const edit of slot.textualEdits)
      after = rewriteImportSpecifier(after, edit.from, edit.to)
    if (after !== source)
      changes.push({ path: slot.abs, rel: slot.rel, before: source, after })
  }
  return { changes, fixed, skipped, verification: { _tag: 'Skipped', reason: changes.length ? 'not-applicable' : 'no-changes' } }
}

function removeStaleImportSpecifiers(
  abs: string,
  source: string,
  removals: { source: string, imported: string, finding: DoctorFinding }[],
): { source: string, fixed: DoctorFinding[], skipped: DoctorFinding[] } {
  const fixed: DoctorFinding[] = []
  const skipped: DoctorFinding[] = []
  const parsed = parseFile(abs)
  const program = parsed.program
  if (!program) {
    for (const r of removals)
      skipped.push(r.finding)
    return { source, fixed, skipped }
  }
  const offset = parsed.scriptStart ?? 0
  // First pass: find all candidate ImportDeclarations & specifiers.
  interface Candidate {
    finding: DoctorFinding
    declStart: number
    declEnd: number
    specStart: number
    specEnd: number
    localName: string
    isOnly: boolean
  }
  const candidates: Candidate[] = []
  const declsToCheck = new Set<any>()
  const importDecls = (program.body ?? []).filter((n: any) => n.type === 'ImportDeclaration')
  for (const removal of removals) {
    let foundDecl: any = null
    let foundSpec: any = null
    for (const node of importDecls) {
      if (node.source?.value !== removal.source)
        continue
      for (const spec of node.specifiers ?? []) {
        if (spec.type !== 'ImportSpecifier')
          continue
        const imp = spec.imported?.name ?? spec.imported?.value
        if (imp === removal.imported) {
          foundDecl = node
          foundSpec = spec
          break
        }
      }
      if (foundSpec)
        break
    }
    if (!foundSpec || !foundDecl) {
      skipped.push(removal.finding)
      continue
    }
    const localName = foundSpec.local?.name
    if (!localName) {
      skipped.push(removal.finding)
      continue
    }
    candidates.push({
      finding: removal.finding,
      declStart: foundDecl.start + offset,
      declEnd: foundDecl.end + offset,
      specStart: foundSpec.start + offset,
      specEnd: foundSpec.end + offset,
      localName,
      isOnly: (foundDecl.specifiers ?? []).length === 1,
    })
    declsToCheck.add(foundDecl)
  }
  // Second pass: detect body references for each localName, excluding the
  // ImportDeclaration ranges of the candidates themselves.
  const referenced = new Set<string>()
  const excludeRanges = [...declsToCheck].map((d: any) => [d.start, d.end] as const)
  walk(program, {
    enter(node: any) {
      if (node?.type !== 'Identifier')
        return
      const name = node.name
      if (!name || referenced.has(name))
        return
      const pos = node.start
      for (const [s, e] of excludeRanges) {
        if (pos >= s && pos < e)
          return
      }
      referenced.add(name)
    },
  })
  // JSX uses JSXIdentifier nodes; check those too.
  walk(program, {
    enter(node: any) {
      if (node?.type !== 'JSXIdentifier')
        return
      const pos = node.start
      for (const [s, e] of excludeRanges) {
        if (pos >= s && pos < e)
          return
      }
      if (node.name)
        referenced.add(node.name)
    },
  })

  // Sort candidates so we splice from the end backwards (preserve offsets).
  candidates.sort((a, b) => b.specStart - a.specStart)
  let next = source
  // Track which declarations had a remove; we need post-processing to drop
  // the whole declaration when it ends up empty.
  const removedFromDecls = new Map<number, number>()
  for (const c of candidates) {
    if (referenced.has(c.localName)) {
      c.finding.detail = { ...c.finding.detail, fixSkippedReason: `local name "${c.localName}" is still referenced in this file` }
      skipped.push(c.finding)
      continue
    }
    if (c.isOnly) {
      // Drop the entire ImportDeclaration line (incl. trailing newline).
      let end = c.declEnd
      while (next[end] === '\n' || next[end] === '\r')
        end++
      next = next.slice(0, c.declStart) + next.slice(end)
      fixed.push(c.finding)
      continue
    }
    // Remove just the specifier; absorb a neighbouring comma.
    let start = c.specStart
    let end = c.specEnd
    // Consume trailing `,` + whitespace, or leading `,` + whitespace if last.
    const trailing = /^[ \t]*,[ \t\n]*/.exec(next.slice(end))
    if (trailing) {
      end += trailing[0].length
    }
    else {
      const before = next.slice(0, start)
      const m = /[ \t\n]*,[ \t]*$/.exec(before)
      if (m)
        start -= m[0].length
    }
    next = next.slice(0, start) + next.slice(end)
    removedFromDecls.set(c.declStart, (removedFromDecls.get(c.declStart) ?? 0) + 1)
    fixed.push(c.finding)
  }
  return { source: next, fixed, skipped }
}

function rewriteImportSpecifier(source: string, oldSpec: string, newSpec: string): string {
  const escaped = oldSpec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`((?:from|import)\\s*\\(?\\s*)(['"\`])${escaped}\\2`, 'g')
  return source.replace(re, (_m, prefix, quote) => `${prefix}${quote}${newSpec}${quote}`)
}

const MODULE_EXT_RE = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/

function relativeSpecifier(fromRel: string, targetRel: string, keepExt: boolean): string {
  const fromDir = dirname(fromRel)
  let rel = relative(fromDir, targetRel).replace(/\\/g, '/')
  if (!keepExt)
    rel = rel.replace(MODULE_EXT_RE, '')
  if (!rel.startsWith('.'))
    rel = `./${rel}`
  return rel
}

function deleteExportLine(source: string, specifier: string): string {
  const lines = source.split('\n')
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\s*export\\b[^;]*\\bfrom\\s*(['"\`])${escaped}\\1\\s*;?\\s*$`)
  const kept = lines.filter(line => !re.test(line))
  return kept.join('\n')
}

export function formatDoctorReport(report: DoctorReport, json = false): string {
  if (json)
    return JSON.stringify(report, null, 2)
  if (!report.findings.length)
    return `doctor: no findings across ${report.filesScanned} files\n`
  const byCheck = new Map<DoctorCheck, DoctorFinding[]>()
  for (const f of report.findings) {
    const arr = byCheck.get(f.check) ?? []
    arr.push(f)
    byCheck.set(f.check, arr)
  }
  const lines: string[] = []
  for (const [check, items] of byCheck) {
    lines.push(`# ${check} (${items.length})`)
    for (const it of items)
      lines.push(`  ${it.file}: ${it.message}`)
    lines.push('')
  }
  lines.push(`${report.findings.length} finding(s) across ${report.filesScanned} files`)
  return `${lines.join('\n')}\n`
}

export function formatAgentDoctorReport(report: DoctorReport): string {
  const counts = new Map<DoctorCheck, number>()
  for (const f of report.findings)
    counts.set(f.check, (counts.get(f.check) ?? 0) + 1)
  const lines = [`findings: ${report.findings.length}/${report.filesScanned} files scanned`]
  for (const [check, n] of counts)
    lines.push(`  ${check}: ${n}`)
  for (const f of report.findings.slice(0, 50))
    lines.push(`  ${f.check} ${f.file}: ${f.message}`)
  if (report.findings.length > 50)
    lines.push(`  ... ${report.findings.length - 50} more`)
  return lines.join('\n')
}
