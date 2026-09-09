import type { TopLevelDeclaration } from './declarations.ts'
import type { ImportInfo, ImportSpec } from './imports.ts'
import type { ProfileSink } from './profile.ts'
import type { VerifyMode } from './project.ts'
import type { TsServer } from './ts-server.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { walk } from 'oxc-walker'
import { loadAdapter } from './adapter.ts'
import { declarationText, isPropertyNamePosition, listTopLevelDeclarations, localBindingNames, parseSource, removeDeclaration } from './declarations.ts'
import { addOrMergeImport, appendStatement, computeSpecifier, isImportEmpty, listImports, parseProgram, pruneUnusedImports, renderImport, rewriteImports } from './imports.ts'
import { isInsideAutoImportScope } from './nuxt.ts'
import { timed, timedAsync } from './profile.ts'
import { findTsconfig, isVuePath, resolveVerifyMode, verifyScope } from './project.ts'
import { startTsServer } from './ts-server.ts'
import { mergeFileChanges, rgFiles } from './util.ts'
import { findRegressions } from './verify.ts'

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

const IMPORT_SPECIFIER_PARENTS = new Set(['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'])

export async function runMove(symbol: string, fromPath: string, toPath: string, opts: MoveOptions = {}): Promise<MoveResult> {
  const cwd = opts.cwd ?? process.cwd()
  const profile = opts.profile
  const verifyMode = resolveVerifyMode(opts.verify)
  const vueEnabled = opts.vue ?? true
  const tsconfigPath = timed(profile, 'find tsconfig', () => opts.tsconfig ? resolve(cwd, opts.tsconfig) : findTsconfig(cwd))

  const fromAbs = resolve(cwd, fromPath)
  const toAbs = resolve(cwd, toPath)
  const candidatePaths = timed(profile, 'rg candidates', () => rgFiles(symbol, { cwd }))

  const fromOriginal = readFileSync(fromAbs, 'utf8')
  const fromSplit = timed(profile, 'split declarators', () => splitMultiDeclaratorIfNeeded(fromOriginal, fromAbs, symbol))
  const parsed = parseSource(fromAbs, fromSplit)

  const decl = timed(profile, 'find export', () => findMovableExport(parsed.program, symbol))
  if (!decl)
    throw new Error(`ripast move: no top-level export named "${symbol}" in ${fromPath} (supported: function, class, interface, type, enum, const with single declarator)`)

  const localDeps = timed(profile, 'find local deps', () => findLocalSiblingDeps(parsed.program, decl, symbol))
  if (localDeps.nonExported.length) {
    throw new Error(
      `ripast move: "${symbol}" depends on local non-exported symbol(s) [${localDeps.nonExported.join(', ')}] in ${fromPath}. `
      + `Export them first, or move them together.`,
    )
  }

  const usedImports = timed(profile, 'collect used imports', () => collectUsedImports(fromSplit, fromAbs, parsed.program, decl, symbol))
  const declText = timed(profile, 'copy declaration', () => declarationText(fromSplit, parsed.comments, decl))
  const remainingReferences = timed(profile, 'count remaining refs', () => countReferencesOutside(parsed.program, decl, symbol))

  const toOriginal = existsSync(toAbs) ? readFileSync(toAbs, 'utf8') : ''
  let toAfter = toOriginal
  for (const used of usedImports) {
    // An import of the target file itself: those names are declared there.
    if (relativeImportTarget(fromAbs, used.specifier) === toAbs)
      continue
    toAfter = addOrMergeImport(toAfter, toAbs, rebaseSpecifier(used.specifier, fromAbs, toAbs), used.spec)
  }
  if (localDeps.exported.length)
    toAfter = addOrMergeImport(toAfter, toAbs, computeSpecifier(toAbs, fromAbs, './placeholder.ts'), { namedImports: localDeps.exported.map(name => ({ name })) })
  toAfter = appendStatement(toAfter, declText)

  let fromAfter = removeDeclaration(fromSplit, parsed.comments, decl)
  fromAfter = pruneUnusedImports(fromAfter, fromAbs)
  if (remainingReferences > 0)
    fromAfter = addOrMergeImport(fromAfter, fromAbs, computeSpecifier(fromAbs, toAbs, './placeholder.ts'), { namedImports: [{ name: symbol }] })

  const server = await timedAsync(profile, 'server start', () => startTsServer(cwd, { tsconfig: tsconfigPath ?? undefined }))
  try {
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
        const after = await rewriteImportSites(server, path, before, fromAbs, toAbs, symbol)
        if (after !== before)
          changes.push({ path, rel: relative(cwd, path), before, after })
      }
    })

    const fromBasename = fromPath.split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''
    const vueAdapter = vueEnabled && tsconfigPath ? await loadAdapter('vue') : null
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
      regressions.push(...await timedAsync(profile, 'verify', () => findRegressions(server, scriptChanges, files)))
    }

    if (vueAdapter && verifyMode !== 'none' && tsconfigPath && changes.some(c => isVuePath(c.path))) {
      const vueRegs = await vueAdapter.regressions(tsconfigPath, cwd, changes)
      regressions.push(...vueRegs)
    }

    return { changes, scanned: new Set([...candidatePaths, fromAbs, toAbs]).size, regressions }
  }
  finally {
    server.dispose()
  }
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
    const id = declarator.id
    const typeAnnotation = id.typeAnnotation ? source.slice(id.typeAnnotation.start, id.typeAnnotation.end) : ''
    const init = declarator.init ? ` = ${source.slice(declarator.init.start, declarator.init.end)}` : ''
    return `export ${target.variableKind} ${id.name}${typeAnnotation}${init}`
  })
  return source.slice(0, target.start) + lines.join('\n') + source.slice(target.end)
}

interface LocalSiblingDeps {
  nonExported: string[]
  exported: string[]
}

function findLocalSiblingDeps(program: any, decl: TopLevelDeclaration, selfName: string): LocalSiblingDeps {
  const siblings = new Map<string, 'exported' | 'local'>()
  for (const other of listTopLevelDeclarations(program)) {
    if (other.nameStart === decl.nameStart)
      continue
    siblings.set(other.name, other.exported ? 'exported' : 'local')
  }
  const locals = localBindingNames(decl.node)
  const nonExported: string[] = []
  const exported: string[] = []
  const seen = new Set<string>()
  walk(decl.node, {
    enter(node: any, parent: any) {
      if (node.type !== 'Identifier')
        return
      const name = node.name
      if (name === selfName || seen.has(name) || locals.has(name))
        return
      if (isPropertyNamePosition(node, parent))
        return
      const sibling = siblings.get(name)
      if (!sibling)
        return
      seen.add(name)
      if (sibling === 'local')
        nonExported.push(name)
      else
        exported.push(name)
    },
  })
  return { nonExported, exported }
}

interface UsedImport {
  specifier: string
  spec: ImportSpec
}

function collectUsedImports(source: string, path: string, program: any, decl: TopLevelDeclaration, selfName: string): UsedImport[] {
  const referenced = new Set<string>()
  walk(decl.node, {
    enter(node: any) {
      if ((node.type === 'Identifier' || node.type === 'JSXIdentifier') && node.name !== selfName)
        referenced.add(node.name)
    },
  })
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

function countReferencesOutside(program: any, decl: TopLevelDeclaration, symbol: string): number {
  let count = 0
  walk(program, {
    enter(node: any, parent: any) {
      if (node.type !== 'Identifier' || node.name !== symbol)
        return
      if (parent && IMPORT_SPECIFIER_PARENTS.has(parent.type))
        return
      if (node.start >= decl.start && node.start < decl.end)
        return
      count++
    },
  })
  return count
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
    if (imp.sideEffectOnly || !(await importResolvesTo(server, path, imp, fromAbs)))
      continue
    const current = copyOf(imp)
    const match = current.named.find(n => n.name === symbol)
    const isDefault = current.defaultImport?.name === symbol
    if (!match && !isDefault)
      continue
    const alias = match?.alias
    const isTypeOnly = current.isTypeOnly || !!match?.isTypeOnly
    const newSpec = computeSpecifier(path, toAbs, current.specifier)
    // A value binding must not land in an `import type` statement; a type
    // binding can join either kind (inline `type` on a value import).
    const existing = imports.find(i => i.specifier === newSpec && i !== imp && !i.sideEffectOnly && (isTypeOnly || !i.isTypeOnly))
    if (!existing && isSimpleSoleNamedImport(current, symbol)) {
      current.specifier = newSpec
      continue
    }
    if (match)
      current.named = current.named.filter(n => n !== match)
    if (isDefault)
      current.defaultImport = undefined
    if (existing) {
      const target = copyOf(existing)
      if (!target.named.some(n => n.name === symbol))
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

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue']

/** Absolute file a relative specifier points at from `fromFile`, probing extensions and index files. */
function relativeImportTarget(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.'))
    return null
  const base = resolve(dirname(fromFile), specifier)
  for (const ext of RESOLVE_EXTS) {
    const candidate = `${base}${ext}`
    if (existsSync(candidate))
      return candidate
  }
  for (const ext of RESOLVE_EXTS.slice(1)) {
    const candidate = join(base, `index${ext}`)
    if (existsSync(candidate))
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
