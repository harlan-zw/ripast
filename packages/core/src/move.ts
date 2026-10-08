import type { TopLevelDeclaration } from './declarations.ts'
import type { ImportInfo, ImportSpec } from './imports.ts'
import type { ProfileSink } from './profile.ts'
import type { VerifyMode } from './project.ts'
import type { TsServer } from './ts-server.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { walk } from 'oxc-walker'
import { loadAdapter } from './adapter.ts'
import { declarationText, isPropertyNamePosition, listTopLevelDeclarations, parseSource, removeDeclaration } from './declarations.ts'
import { addOrMergeImport, appendStatement, computeSpecifier, isImportEmpty, listImports, parseProgram, pruneUnusedImports, renderImport, rewriteImports } from './imports.ts'
import { isInsideAutoImportScope } from './nuxt.ts'
import { timed, timedAsync } from './profile.ts'
import { findTsconfig, isVuePath, resolveVerifyMode, verifyScope } from './project.ts'
import { startTsServer } from './ts-server.ts'
import { applyTextEdits, mergeFileChanges, rgFiles } from './util.ts'
import { findRegressions, findVueRegressions } from './verify.ts'

export interface MoveOptions {
  cwd?: string
  /** Configured project used for moves and verification. */
  tsconfig?: string
  verify?: boolean | VerifyMode
  vue?: boolean
  profile?: ProfileSink
}

export interface MoveResult {
  changes: FileChange[]
  scanned: number
  regressions: Regression[]
}

export async function runMove(symbol: string, fromPath: string, toPath: string, opts: MoveOptions = {}): Promise<MoveResult> {
  const cwd = opts.cwd ?? process.cwd()
  const profile = opts.profile
  const verifyMode = resolveVerifyMode(opts.verify)
  const vueEnabled = opts.vue ?? true
  const tsconfigPath = timed(profile, 'find tsconfig', () => opts.tsconfig ? resolve(cwd, opts.tsconfig) : findTsconfig(cwd))

  const fromAbs = resolve(cwd, fromPath)
  const toAbs = resolve(cwd, toPath)
  if (fromAbs === toAbs)
    throw new Error('ripast move: source and destination must be different files')
  // Imports may spell identifiers with Unicode escapes. Inspect every script.
  const candidatePaths = timed(profile, 'rg candidates', () => rgFiles('', { cwd, listAll: true }))

  const fromOriginal = readFileSync(fromAbs, 'utf8')
  const fromSplit = timed(profile, 'split declarators', () => splitMultiDeclaratorIfNeeded(fromOriginal, fromAbs, symbol))
  const parsed = parseSource(fromAbs, fromSplit)
  const importStyle = listImports(fromSplit, fromAbs, parsed.program).find(imp => isRelativeScriptImport(imp.specifier))?.specifier
    ?? candidatePaths.filter(path => path !== fromAbs && !isVuePath(path)).flatMap((path) => {
      return listImports(readFileSync(path, 'utf8'), path).filter(imp => isRelativeScriptImport(imp.specifier)).map(imp => imp.specifier)
    })[0]
    ?? './placeholder.ts'

  const decl = timed(profile, 'find export', () => findMovableExport(parsed.program, symbol))
  if (!decl)
    throw new Error(`ripast move: no top-level export named "${symbol}" in ${fromPath} (supported: function, class, interface, type, enum, const with single declarator)`)

  const vueAdapter = vueEnabled && tsconfigPath ? await loadAdapter('vue') : null
  const server = await timedAsync(profile, 'server start', () => startTsServer(cwd, { tsconfig: tsconfigPath ?? undefined }))
  try {
    // Splitting a declaration changes offsets. Resolve against the exact source overlay.
    server.open(fromAbs, fromSplit)
    const referencedBindings = await timedAsync(profile, 'resolve declaration dependencies', () => referencedTopLevelBindings(server, fromAbs, fromSplit, parsed.program, decl))
    const localDeps = timed(profile, 'find local deps', () => findLocalSiblingDeps(parsed.program, decl, referencedBindings))
    if (localDeps.nonExported.length) {
      throw new Error(
        `ripast move: "${symbol}" depends on local non-exported symbol(s) [${localDeps.nonExported.join(', ')}] in ${fromPath}. `
        + `Export them first, or move them together.`,
      )
    }

    const usedImports = timed(profile, 'collect used imports', () => collectUsedImports(fromSplit, fromAbs, parsed.program, referencedBindings))
    const declText = timed(profile, 'copy declaration', () => declarationText(fromSplit, parsed.comments, decl))
    const remainingReferences = (await server.references(fromAbs, decl.nameStart)).filter(site => site.path === fromAbs && (site.start < decl.start || site.start >= decl.end)).length

    const toOriginal = existsSync(toAbs) ? readFileSync(toAbs, 'utf8') : ''
    let toAfter = toOriginal
    const targetDeclarations = listTopLevelDeclarations(parseProgram(toAbs, toOriginal))
    const sourceImports = listImports(fromSplit, fromAbs, parsed.program)
    for (const used of usedImports) {
      // Keep self imports for aliases, anonymous defaults, and namespace objects.
      // Reuse an existing destination declaration only when its binding matches.
      const spec = relativeImportTarget(fromAbs, used.specifier) === toAbs
        ? await withoutDestinationBindings(server, fromAbs, toAbs, used, sourceImports, targetDeclarations)
        : used.spec
      if (spec.namedImports.length || spec.defaultImport || spec.namespaceImport)
        toAfter = addOrMergeImport(toAfter, toAbs, rebaseSpecifier(used.specifier, fromAbs, toAbs), spec)
    }
    if (localDeps.namedImports.length || localDeps.defaultImport)
      toAfter = addOrMergeImport(toAfter, toAbs, computeSpecifier(toAbs, fromAbs, importStyle), { namedImports: localDeps.namedImports.map(name => ({ name })), defaultImport: localDeps.defaultImport })
    toAfter = appendStatement(toAfter, declText)

    let fromAfter = removeDeclaration(fromSplit, parsed.comments, decl)
    fromAfter = pruneUnusedImports(fromAfter, fromAbs)
    if (remainingReferences > 0)
      fromAfter = addOrMergeImport(fromAfter, fromAbs, computeSpecifier(fromAbs, toAbs, importStyle), { namedImports: [{ name: symbol }] })

    // Removing the last export must not turn module-local declarations into globals.
    if (fromAfter.trim() && !parseProgram(fromAbs, fromAfter).body.some((node: any) => node.type === 'ImportDeclaration' || node.type.startsWith('Export')))
      fromAfter = appendStatement(fromAfter, 'export {}')

    // Consumer import queries still refer to their original documents.
    server.open(fromAbs, fromOriginal)
    // Resolve bindings against the same text used to collect their offsets.
    // A new destination exists only in this overlay during the dry run.
    server.open(toAbs, toAfter)
    const destinationImports = listImports(toAfter, toAbs, parseProgram(toAbs, toAfter))
    const replacements = new Map<ImportInfo, string | null>()
    for (const imp of destinationImports) {
      const match = imp.named.find(binding => binding.name === symbol)
      if (imp.sideEffectOnly || !match || !(await importResolvesTo(server, toAbs, imp, fromAbs)))
        continue
      if (match.alias && match.alias !== symbol)
        throw new Error(`ripast move: destination imports "${symbol}" as "${match.alias}". Remove the alias before moving it.`)
      const remaining = { ...imp, named: imp.named.filter(binding => binding !== match) }
      replacements.set(imp, isImportEmpty(remaining) ? null : renderImport(remaining))
    }
    toAfter = rewriteImports(toAfter, destinationImports, replacements, [])
    server.open(toAbs, toOriginal)
    const unsupportedConsumer = await findUnsupportedModuleConsumer(server, candidatePaths.filter(path => !vueAdapter?.isGeneratedPath?.(cwd, path)), fromAbs)
    if (unsupportedConsumer)
      throw new Error(`ripast move: cannot move "${symbol}" while ${relative(cwd, unsupportedConsumer)} uses a namespace or dynamic import of ${fromPath}. Use named imports first.`)
    const changes: FileChange[] = []
    if (fromAfter !== fromOriginal)
      changes.push({ path: fromAbs, rel: relative(cwd, fromAbs), before: fromOriginal, after: fromAfter })
    if (toAfter !== toOriginal)
      changes.push({ path: toAbs, rel: relative(cwd, toAbs), before: toOriginal, after: toAfter })

    await timedAsync(profile, 'rewrite import sites', async () => {
      for (const path of candidatePaths) {
        if (path === fromAbs || path === toAbs || isVuePath(path))
          continue
        const before = readFileSync(path, 'utf8')
        const importsAfter = await rewriteImportSites(server, path, before, fromAbs, toAbs, symbol)
        const after = await rewriteReexports(server, path, importsAfter, before, fromAbs, toAbs, symbol, decl.kind === 'interface' || decl.kind === 'type', !fromAfter.trim())
        if (after !== before)
          changes.push({ path, rel: relative(cwd, path), before, after })
      }
    })

    const fromBasename = basename(fromAbs, extname(fromAbs))
    if (vueAdapter && tsconfigPath && fromBasename && timed(profile, 'vue prefilter', () => vueAdapter.hasFilesContaining(cwd, fromBasename))) {
      const vueChanges = await timedAsync(profile, 'vue import rewrite', () => vueAdapter.applyImportRewrite(tsconfigPath, cwd, fromAbs, toAbs))
      for (const vc of vueChanges) {
        if (!changes.some(c => c.path === vc.path))
          changes.push(vc)
      }
    }

    if (vueAdapter?.autoImportScopes) {
      const scopes = timed(profile, 'auto-import scopes', () => vueAdapter.autoImportScopes!(cwd))
      if (isInsideAutoImportScope(fromAbs, scopes) && !isInsideAutoImportScope(toAbs, scopes) && vueAdapter.addExplicitImports) {
        const autoImportChanges = timed(profile, 'nuxt auto-import consumers', () => vueAdapter.addExplicitImports!({
          cwd,
          symbols: [symbol],
          toAbs,
          fromAbs,
          existingChanges: changes,
          noScriptError: name => new Error(
            `ripast move: "${name}" is auto-imported in Nuxt; moving to ${toAbs}`
            + ` removes it from auto-import scope. Either keep it in`
            + ` composables/utils/components, or add explicit imports first.`,
          ),
        }))
        mergeFileChanges(changes, autoImportChanges)
      }
      if (scopes.size)
        vueAdapter.filterGeneratedChanges?.(cwd, changes)
    }

    const regressions: Regression[] = []
    if (verifyMode !== 'none') {
      const scriptChanges = changes.filter(c => !isVuePath(c.path))
      const files = verifyScope(verifyMode, cwd, [fromAbs, toAbs, ...candidatePaths], scriptChanges.map(c => c.path))
      const verified = await timedAsync(profile, 'verify', () => findRegressions(server, scriptChanges, files))
      // Native module resolution reads disk, so a new directory cannot resolve yet.
      // Ignore only changed consumers pointing at this planned destination.
      const consumers = new Set(scriptChanges.filter(change => change.path !== toAbs).map(change => change.path))
      regressions.push(...verified.filter(regression => !consumers.has(regression.file) || !isUnresolvedMoveTarget(regression, toAbs)))
    }

    if (vueEnabled && verifyMode === 'project') {
      regressions.push(...await findVueRegressions(cwd, changes, tsconfigPath, async () => vueAdapter))
    }
    else if (vueAdapter && verifyMode !== 'none' && tsconfigPath && changes.some(c => isVuePath(c.path))) {
      const vueRegs = await vueAdapter.regressions(tsconfigPath, cwd, changes)
      regressions.push(...vueRegs)
    }

    return { changes, scanned: new Set([...candidatePaths, fromAbs, toAbs]).size, regressions }
  }
  finally {
    server.dispose()
  }
}

function isUnresolvedMoveTarget(regression: Regression, toAbs: string): boolean {
  if (regression.code !== 2307)
    return false
  const specifier = /Cannot find module '([^']+)'/.exec(regression.message)?.[1]
  if (!specifier?.startsWith('.'))
    return false
  const moduleExtension = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/
  const base = resolve(dirname(regression.file), specifier).replace(moduleExtension, '')
  return base === toAbs.replace(moduleExtension, '')
}

function findMovableExport(program: any, symbol: string): TopLevelDeclaration | null {
  return listTopLevelDeclarations(program).find(d =>
    d.name === symbol && d.exported && !d.isDefault && (d.kind !== 'variable' || d.declaratorCount === 1),
  ) ?? null
}

function splitMultiDeclaratorIfNeeded(source: string, path: string, symbol: string): string {
  const { program } = parseSource(path, source)
  const target = listTopLevelDeclarations(program).find(d =>
    d.kind === 'variable' && d.exported && !d.isDefault && d.declaratorCount > 1 && d.name === symbol,
  )
  if (!target)
    return source
  const lines = (target.node.declarations as any[]).map((declarator) => {
    const declaration = source.slice(declarator.start, declarator.end)
    return `export ${target.variableKind} ${declaration};`
  })
  return source.slice(0, target.start) + lines.join('\n') + source.slice(target.end)
}

interface LocalSiblingDeps {
  nonExported: string[]
  namedImports: string[]
  defaultImport?: string
}

function isRelativeScriptImport(specifier: string): boolean {
  return specifier.startsWith('.') && !/[?#]/.test(specifier)
    && !/\.(?:json|vue|css|scss|sass|less|svg|png|jpe?g|webp|woff2?|wasm)$/.test(specifier)
}

function isBindingReference(node: any, parent: any): boolean {
  if (node.type === 'Identifier')
    return !isPropertyNamePosition(node, parent)
  if (node.type !== 'JSXIdentifier' || !parent)
    return false
  if (parent.type === 'JSXMemberExpression')
    return parent.object === node
  return (parent.type === 'JSXOpeningElement' || parent.type === 'JSXClosingElement')
    && parent.name === node && !/^[a-z]/.test(node.name)
}

function findLocalSiblingDeps(program: any, decl: TopLevelDeclaration, referenced: Set<string>): LocalSiblingDeps {
  const out: LocalSiblingDeps = { nonExported: [], namedImports: [] }
  for (const other of listTopLevelDeclarations(program)) {
    if (other.nameStart === decl.nameStart || !referenced.has(other.name))
      continue
    if (!other.exported)
      out.nonExported.push(other.name)
    else if (other.isDefault)
      out.defaultImport = other.name
    else
      out.namedImports.push(other.name)
  }
  return out
}

/** Resolve only candidate names seen in the declaration, so nested shadows stay local. */
async function referencedTopLevelBindings(server: TsServer, path: string, source: string, program: any, decl: TopLevelDeclaration): Promise<Set<string>> {
  const candidates = new Set<string>()
  walk(decl.node, {
    enter(node: any, parent: any) {
      if (isBindingReference(node, parent))
        candidates.add(node.name)
    },
  })
  const bindings = listTopLevelDeclarations(program).map(binding => ({ name: binding.name, offset: binding.nameStart }))
  for (const imp of listImports(source, path, program)) {
    bindings.push(...imp.named.map(binding => ({ name: binding.alias ?? binding.name, offset: binding.localStart })))
    if (imp.defaultImport)
      bindings.push({ name: imp.defaultImport.name, offset: imp.defaultImport.start })
    if (imp.namespaceImport)
      bindings.push({ name: imp.namespaceImport.name, offset: imp.namespaceImport.start })
  }
  const referenced = new Set<string>()
  for (const binding of bindings) {
    if (!candidates.has(binding.name) || binding.name === decl.name)
      continue
    const sites = await server.references(path, binding.offset)
    if (sites.some(site => site.path === path && site.start >= decl.start && site.start < decl.end))
      referenced.add(binding.name)
  }
  return referenced
}

interface UsedImport {
  specifier: string
  spec: ImportSpec
}

async function withoutDestinationBindings(server: TsServer, fromAbs: string, toAbs: string, used: UsedImport, imports: ImportInfo[], declarations: TopLevelDeclaration[]): Promise<ImportSpec> {
  const alreadyDeclared = async (name: string, offset: number | undefined): Promise<boolean> => {
    const declaration = declarations.find(declaration => declaration.name === name)
    if (!declaration || offset === undefined)
      return false
    const sites = await server.definition(fromAbs, offset)
    return sites.some(site => site.path === toAbs && site.start === declaration.nameStart)
  }
  const namedImports: ImportSpec['namedImports'] = []
  for (const binding of used.spec.namedImports) {
    const name = binding.alias ?? binding.name
    const imported = imports.filter(imp => imp.specifier === used.specifier).flatMap(imp => imp.named).find(candidate => candidate.name === binding.name && (candidate.alias ?? candidate.name) === name)
    if (!await alreadyDeclared(name, imported?.localStart))
      namedImports.push(binding)
  }
  const defaultImport = used.spec.defaultImport
  const defaultOffset = imports.find(imp => imp.specifier === used.specifier && imp.defaultImport?.name === defaultImport)?.defaultImport?.start
  return {
    ...used.spec,
    namedImports,
    defaultImport: defaultImport && await alreadyDeclared(defaultImport, defaultOffset) ? undefined : defaultImport,
  }
}

function collectUsedImports(source: string, path: string, program: any, referenced: Set<string>): UsedImport[] {
  const out: UsedImport[] = []
  for (const imp of listImports(source, path, program)) {
    if (imp.sideEffectOnly)
      continue
    const named = imp.named
      .filter(n => referenced.has(n.alias ?? n.name))
      .map(n => ({ name: n.name, alias: n.alias, isTypeOnly: imp.isTypeOnly || n.isTypeOnly }))
    const defaultImport = imp.defaultImport && referenced.has(imp.defaultImport.name) ? imp.defaultImport.name : undefined
    const namespaceImport = imp.namespaceImport && referenced.has(imp.namespaceImport.name) ? imp.namespaceImport.name : undefined
    if (named.length || defaultImport || namespaceImport)
      out.push({ specifier: imp.specifier, spec: { namedImports: named, defaultImport, namespaceImport, isTypeOnly: imp.isTypeOnly } })
  }
  return out
}

/** A relative specifier written from `fromAbs`, rewritten so it resolves the same target from `toAbs`. */
function rebaseSpecifier(specifier: string, fromAbs: string, toAbs: string): string {
  if (!specifier.startsWith('.'))
    return specifier
  const target = resolve(dirname(fromAbs), specifier)
  return computeSpecifier(toAbs, target, specifier)
}

async function rewriteImportSites(server: TsServer, path: string, source: string, fromAbs: string, toAbs: string, symbol: string): Promise<string> {
  const program = parseProgram(path, source)
  const imports = listImports(source, path, program)
  if (!imports.length)
    return source
  const working = new Map<ImportInfo, ImportInfo>()
  const copyOf = (imp: ImportInfo): ImportInfo => {
    let copy = working.get(imp)
    if (!copy) {
      copy = { ...imp, named: [...imp.named] }
      working.set(imp, copy)
    }
    return copy
  }
  const inserts: string[] = []
  for (const imp of imports) {
    if (imp.sideEffectOnly || !imp.named.some(binding => binding.name === symbol) || !(await importResolvesTo(server, path, imp, fromAbs)))
      continue
    const current = copyOf(imp)
    const match = current.named.find(n => n.name === symbol)
    if (!match)
      continue
    const alias = match.alias
    const isTypeOnly = current.isTypeOnly || !!match.isTypeOnly
    const newSpec = computeSpecifier(path, toAbs, current.specifier)
    // A value binding must not land in an `import type` statement; a type
    // binding can join either kind (inline `type` on a value import).
    const existing = imports.find(i => i.specifier === newSpec && i !== imp && !i.sideEffectOnly && !i.namespaceImport && (isTypeOnly || !i.isTypeOnly))
    if (!existing && isSimpleSoleNamedImport(current, symbol)) {
      current.specifier = newSpec
      continue
    }
    current.named = current.named.filter(n => n !== match)
    if (existing) {
      const target = copyOf(existing)
      if (!target.named.some(n => n.name === symbol && (n.alias ?? n.name) === (alias ?? symbol)))
        target.named.push({ name: symbol, alias, isTypeOnly: !target.isTypeOnly && isTypeOnly, localStart: -1 })
    }
    else {
      inserts.push(renderImport({
        specifier: newSpec,
        quote: current.quote,
        semicolon: current.semicolon,
        isTypeOnly,
        named: [{ name: symbol, alias, isTypeOnly: false, localStart: -1 }],
        sideEffectOnly: false,
      }))
    }
  }
  const replacements = new Map<ImportInfo, string | null>()
  for (const [imp, current] of working) {
    if (isImportEmpty(current)) {
      replacements.set(imp, null)
      continue
    }
    const text = renderImport(current)
    if (text !== source.slice(imp.start, imp.end))
      replacements.set(imp, text)
  }
  if (!replacements.size && !inserts.length)
    return source
  return rewriteImports(source, imports, replacements, inserts)
}

function isSimpleSoleNamedImport(imp: ImportInfo, symbol: string): boolean {
  if (imp.defaultImport || imp.namespaceImport || imp.named.length !== 1)
    return false
  const only = imp.named[0]
  return only.name === symbol && !only.alias
}

async function rewriteReexports(server: TsServer, path: string, source: string, original: string, fromAbs: string, toAbs: string, symbol: string, isTypeOnly: boolean, sourceIsEmpty: boolean): Promise<string> {
  const edits: { start: number, end: number, replacement: string }[] = []
  for (const node of parseProgram(path, source).body ?? []) {
    if (node.type === 'ExportAllDeclaration' && !node.exported) {
      const specifier = node.source.value
      const originalNode = parseProgram(path, original).body.find((statement: any) => statement.type === 'ExportAllDeclaration' && statement.source?.value === specifier)
      const resolves = specifier.startsWith('.')
        ? relativeImportTarget(path, specifier) === fromAbs
        : (await server.definition(path, originalNode.source.start + 1)).some(definition => definition.path === fromAbs)
      if (resolves) {
        const quote = source[node.source.start]
        const kind = isTypeOnly || node.exportKind === 'type' ? 'export type' : 'export'
        const semicolon = source[node.end - 1] === ';' ? ';' : ''
        const statement = `${kind} { ${symbol} } from ${quote}${computeSpecifier(path, toAbs, specifier)}${quote}${semicolon}`
        edits.push(sourceIsEmpty
          ? { start: node.start, end: node.end, replacement: statement }
          : { start: node.end, end: node.end, replacement: `\n${statement}` })
      }
      continue
    }
    if (node.type !== 'ExportNamedDeclaration' || !node.source)
      continue
    const moved = node.specifiers.filter((specifier: any) => (specifier.local.name ?? specifier.local.value) === symbol)
    if (!moved.length)
      continue
    const specifier = node.source.value
    let resolves: boolean
    if (specifier.startsWith('.')) {
      resolves = relativeImportTarget(path, specifier) === fromAbs
    }
    else {
      // Import rewrites may shift this statement. Query the server at its original offset.
      const originalNode = parseProgram(path, original).body.find((statement: any) =>
        statement.type === 'ExportNamedDeclaration' && statement.source?.value === specifier
        && statement.specifiers.some((spec: any) => (spec.local.name ?? spec.local.value) === symbol),
      )
      const originalSpecifier = originalNode.specifiers.find((spec: any) => (spec.local.name ?? spec.local.value) === symbol)
      resolves = (await server.definition(path, originalSpecifier.local.start)).some(definition => definition.path === fromAbs)
    }
    if (!resolves)
      continue
    const quote = source[node.source.start]
    const prefix = node.exportKind === 'type' ? 'export type' : 'export'
    const semicolon = source[node.end - 1] === ';' ? ';' : ''
    const render = (specifiers: any[], target: string): string => `${prefix} { ${specifiers.map(spec => source.slice(spec.start, spec.end)).join(', ')} } from ${quote}${target}${quote}${semicolon}`
    const remaining = node.specifiers.filter((specifier: any) => !moved.includes(specifier))
    const statements = remaining.length ? [render(remaining, specifier)] : []
    statements.push(render(moved, computeSpecifier(path, toAbs, specifier)))
    edits.push({ start: node.start, end: node.end, replacement: statements.join('\n') })
  }
  return applyTextEdits(source, edits)
}

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue']

/** Absolute file a relative specifier points at from `fromFile`, probing extensions and index files. */
function relativeImportTarget(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.'))
    return null
  const base = resolve(dirname(fromFile), specifier)
  // TypeScript resolves emitted runtime extensions to their source files.
  const sourceExtensions = base.endsWith('.js')
    ? ['.ts', '.tsx']
    : base.endsWith('.jsx')
      ? ['.tsx', '.ts']
      : base.endsWith('.mjs')
        ? ['.mts']
        : base.endsWith('.cjs') ? ['.cts'] : []
  for (const ext of sourceExtensions) {
    const candidate = base.replace(/\.[^.]+$/, ext)
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      if (statSync(base, { throwIfNoEntry: false })?.isFile())
        throw new Error(`ripast move: ambiguous module "${specifier}" from ${fromFile}. Both runtime and source files exist.`)
      return candidate
    }
  }
  for (const ext of RESOLVE_EXTS) {
    const candidate = `${base}${ext}`
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile())
      return candidate
  }
  for (const ext of RESOLVE_EXTS.slice(1)) {
    const candidate = join(base, `index${ext}`)
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile())
      return candidate
  }
  return base
}

async function importResolvesTo(server: TsServer, path: string, imp: ImportInfo, targetAbs: string): Promise<boolean> {
  if (imp.specifier.startsWith('.'))
    return relativeImportTarget(path, imp.specifier) === targetAbs
  // Path aliases and packages: ask the server where the binding is declared.
  const offset = imp.named[0]?.localStart ?? imp.defaultImport?.start ?? imp.namespaceImport?.start
  if (offset === undefined)
    return false
  const definitions = await server.definition(path, offset)
  return definitions.some(d => d.path === targetAbs)
}

async function findUnsupportedModuleConsumer(server: TsServer, paths: string[], fromAbs: string): Promise<string | null> {
  for (const path of paths) {
    const source = readFileSync(path, 'utf8')
    let script = source
    let scriptPath = path
    if (isVuePath(path)) {
      const { descriptor } = parseSfc(source, { filename: path })
      const blocks = [descriptor.script, descriptor.scriptSetup].filter(block => block !== null)
      script = blocks.map(block => block.content).join('\n')
      const extension = blocks.some(block => block.lang === 'tsx' || block.lang === 'jsx') ? 'tsx' : 'ts'
      scriptPath = `${path}.${randomUUID()}.${extension}`
      server.open(scriptPath, script)
    }
    const program = parseProgram(scriptPath, script)
    const modules: any[] = []
    walk(program, {
      enter(node: any) {
        if ((node.type === 'ExportAllDeclaration' && node.exported) || node.type === 'ImportExpression' || node.type === 'TSImportType'
          || (node.type === 'ImportDeclaration' && node.specifiers.some((specifier: any) => specifier.type === 'ImportNamespaceSpecifier'))) {
          modules.push(node.source)
        }
      },
    })
    for (const module of modules) {
      if (typeof module?.value !== 'string')
        return path
      if (module.value.startsWith('.')) {
        if (relativeImportTarget(path, module.value) === fromAbs)
          return path
      }
      else if ((await server.definition(scriptPath, module.start + 1)).some(definition => definition.path === fromAbs)) {
        return path
      }
    }
  }
  return null
}
