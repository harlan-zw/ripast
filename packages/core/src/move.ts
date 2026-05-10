import type { ImportDeclaration, Node, SourceFile } from 'ts-morph'
import type { ProfileSink } from './profile.ts'
import type { VerifyMode } from './project.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { Project, SyntaxKind } from 'ts-morph'
import { loadAdapter } from './adapters/resolve.ts'
import { timed, timedAsync } from './profile.ts'
import { resolveVerifyMode } from './project.ts'
import { scan } from './scan.ts'
import { rgFiles } from './util.ts'
import { findRegressions, snapshotDiagnostics } from './verify.ts'

export interface MoveOptions {
  cwd?: string
  tsconfig?: string
  verify?: boolean | VerifyMode
  lazy?: boolean
  project?: Project
  vue?: boolean
  profile?: ProfileSink
}

export interface MoveResult {
  changes: FileChange[]
  scanned: number
  regressions: Regression[]
}

const MOVABLE_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
])

export async function runMove(symbol: string, fromPath: string, toPath: string, opts: MoveOptions = {}): Promise<MoveResult> {
  const cwd = opts.cwd ?? process.cwd()
  const profile = opts.profile
  const verifyMode = resolveVerifyMode(opts.verify)
  const vueEnabled = opts.vue ?? true
  const tsconfigPath = timed(profile, 'find tsconfig', () => opts.tsconfig ? resolve(cwd, opts.tsconfig) : findTsconfig(cwd))
  const lazy = opts.lazy ?? true
  const projectMode = !opts.project && lazy && !vueEnabled && tsconfigPath && verifyMode !== 'project' ? 'lazy' : 'full'
  const project = timed(profile, 'project load', () => opts.project ?? (tsconfigPath
    ? new Project({ tsConfigFilePath: tsconfigPath, skipAddingFilesFromTsConfig: projectMode === 'lazy' })
    : new Project({ compilerOptions: { allowJs: true } })))

  const fromAbs = resolve(cwd, fromPath)
  const toAbs = resolve(cwd, toPath)
  const candidatePaths = timed(profile, 'rg candidates', () => rgFiles(symbol, { cwd }))

  let fromSF = project.getSourceFile(fromAbs) ?? project.addSourceFileAtPathIfExists(fromAbs)
  if (!fromSF)
    fromSF = project.addSourceFileAtPath(fromAbs)

  let toSF = project.getSourceFile(toAbs) ?? project.addSourceFileAtPathIfExists(toAbs)
  if (!toSF)
    toSF = project.createSourceFile(toAbs, '', { overwrite: false })

  if (projectMode === 'lazy') {
    for (const f of candidatePaths) project.addSourceFileAtPathIfExists(f)
  }

  timed(profile, 'split declarators', () => splitMultiDeclaratorIfNeeded(fromSF, symbol))

  const decl = timed(profile, 'find export', () => findNamedExport(fromSF, symbol))
  if (!decl)
    throw new Error(`ripast move: no top-level export named "${symbol}" in ${fromPath} (supported: function, class, interface, type, enum, const with single declarator)`)

  const localDeps = timed(profile, 'find local deps', () => findLocalSiblingDeps(decl, fromSF, symbol))
  if (localDeps.nonExported.length) {
    throw new Error(
      `ripast move: "${symbol}" depends on local non-exported symbol(s) [${localDeps.nonExported.join(', ')}] in ${fromPath}. `
      + `Export them first, or move them together.`,
    )
  }

  const candidateFiles = timed(profile, 'map candidates', () => sourceFilesMatching(project, candidatePaths, [fromSF, toSF]))
  const originals = timed(profile, 'snapshot originals', () => {
    const out = new Map<string, string>()
    for (const sf of candidateFiles) out.set(sf.getFilePath(), sf.getFullText())
    return out
  })

  const verifyFiles = verifyMode === 'none'
    ? []
    : verifyMode === 'project'
      ? project.getSourceFiles()
      : timed(profile, 'collect verify files', () => collectMoveVerifyFiles(candidateFiles, fromSF, toSF))
  const baseline = verifyMode !== 'none' ? timed(profile, 'verify baseline', () => snapshotDiagnostics(project, verifyFiles)) : null

  const usedImports = timed(profile, 'collect used imports', () => collectUsedImports(decl, fromSF, symbol))
  const declText = timed(profile, 'copy declaration', () => getDeclarationFullText(decl))
  const remainingReferences = timed(profile, 'count remaining refs', () => countReferencesOutside(fromSF, symbol, decl))

  for (const { moduleSpecifier, namedImports, defaultImport, namespaceImport } of usedImports) {
    addOrMergeImport(toSF, moduleSpecifier, { namedImports, defaultImport, namespaceImport })
  }

  if (localDeps.exported.length) {
    const spec = computeSpecifier(toAbs, fromAbs, './placeholder.ts')
    addOrMergeImport(toSF, spec, { namedImports: localDeps.exported.map(name => ({ name })) })
  }

  toSF.insertStatements(toSF.getStatements().length, declText.trim())

  timed(profile, 'rewrite import sites', () => {
    for (const sf of candidateFiles) {
      if (sf === fromSF || sf === toSF)
        continue
      rewriteImportSites(sf, fromAbs, toAbs, symbol)
    }
  })

  ;(decl as any).remove?.()
  pruneUnusedImports(fromSF)

  if (remainingReferences > 0) {
    const newSpec = computeSpecifier(fromSF.getFilePath(), toAbs, './placeholder.ts')
    addOrMergeImport(fromSF, newSpec, { namedImports: [{ name: symbol }] })
  }

  const changes: FileChange[] = timed(profile, 'collect changes', () => {
    const out: FileChange[] = []
    for (const sf of candidateFiles) {
      const before = originals.get(sf.getFilePath()) ?? ''
      const after = sf.getFullText()
      if (after !== before) {
        out.push({
          path: sf.getFilePath(),
          rel: relative(cwd, sf.getFilePath()),
          before,
          after,
        })
      }
    }
    return out
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
    if (isInsideAnyScope(fromAbs, scopes) && !isInsideAnyScope(toAbs, scopes)) {
      const autoImportChanges = timed(profile, 'nuxt auto-import consumers', () => addNuxtExplicitImports(cwd, symbol, toAbs, changes, fromAbs))
      for (const change of autoImportChanges) {
        const existing = changes.find(c => c.path === change.path)
        if (existing)
          existing.after = change.after
        else
          changes.push(change)
      }
    }
    if (scopes.size)
      removeGeneratedNuxtChanges(cwd, changes)
  }

  const regressions = baseline ? timed(profile, 'verify regressions', () => findRegressions(baseline, project, verifyFiles)) : []

  if (vueAdapter && verifyMode !== 'none' && tsconfigPath && changes.some(c => c.path.endsWith('.vue'))) {
    const vueRegs = await vueAdapter.regressions(tsconfigPath, cwd, changes)
    regressions.push(...vueRegs)
  }

  return { changes, scanned: projectMode === 'full' ? project.getSourceFiles().length : candidateFiles.length, regressions }
}

function addNuxtExplicitImports(cwd: string, symbol: string, toAbs: string, changes: FileChange[], fromAbs: string): FileChange[] {
  const byPath = new Map(changes.map(change => [change.path, change]))
  const hits = scan(symbol, { cwd, kinds: ['identifier-reference'] })
  const consumerPaths = new Set(hits.map(hit => resolve(cwd, hit.file)))
  const out: FileChange[] = []
  for (const filePath of consumerPaths) {
    if (isGeneratedNuxtPath(cwd, filePath))
      continue
    if (filePath === fromAbs || filePath === toAbs)
      continue
    const current = byPath.get(filePath)?.after ?? readFileSync(filePath, 'utf8')
    if (hasNamedImport(current, symbol))
      continue
    const specifier = computeSpecifier(filePath, toAbs, './placeholder')
    const after = filePath.endsWith('.vue')
      ? insertVueScriptImport(current, symbol, specifier, toAbs)
      : insertTopLevelImport(current, symbol, specifier)
    if (after !== current) {
      out.push({
        path: filePath,
        rel: relative(cwd, filePath),
        before: byPath.get(filePath)?.before ?? readFileSync(filePath, 'utf8'),
        after,
      })
    }
  }
  return out
}

function removeGeneratedNuxtChanges(cwd: string, changes: FileChange[]): void {
  for (let i = changes.length - 1; i >= 0; i--) {
    if (isGeneratedNuxtPath(cwd, changes[i].path))
      changes.splice(i, 1)
  }
}

function isGeneratedNuxtPath(cwd: string, filePath: string): boolean {
  const rel = relative(cwd, filePath).replace(/\\/g, '/')
  return rel === '.nuxt' || rel.startsWith('.nuxt/')
}

function insertVueScriptImport(source: string, symbol: string, specifier: string, toAbs: string): string {
  const match = source.match(/<script(?:\s[^>]*)?>/)
  if (!match || match.index === undefined) {
    throw new Error(
      `ripast move: "${symbol}" is auto-imported in Nuxt; moving to ${toAbs}`
      + ` removes it from auto-import scope. Either keep it in`
      + ` composables/utils/components, or add explicit imports first.`,
    )
  }
  const insertAt = match.index + match[0].length
  const rest = source[insertAt] === '\n' ? source.slice(insertAt + 1) : source.slice(insertAt)
  return `${source.slice(0, insertAt)}\nimport { ${symbol} } from '${specifier}'\n${rest}`
}

function insertTopLevelImport(source: string, symbol: string, specifier: string): string {
  const importLine = `import { ${symbol} } from '${specifier}'\n`
  if (source.startsWith('#!')) {
    const nl = source.indexOf('\n')
    if (nl >= 0)
      return `${source.slice(0, nl + 1)}${importLine}${source.slice(nl + 1)}`
  }
  return `${importLine}${source}`
}

function hasNamedImport(source: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\bimport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}\\s*from\\s*['"]`).test(source)
}

function isInsideAnyScope(filePath: string, scopes: Set<string>): boolean {
  for (const scope of scopes) {
    if (filePath === scope || filePath.startsWith(`${scope}${sep}`))
      return true
  }
  return false
}

function findNamedExport(sf: SourceFile, symbol: string): Node | null {
  for (const stmt of sf.getStatements()) {
    const kind = stmt.getKind()
    if (kind === SyntaxKind.VariableStatement) {
      const vs = stmt.asKindOrThrow(SyntaxKind.VariableStatement)
      if (!vs.hasExportKeyword())
        continue
      const decls = vs.getDeclarationList().getDeclarations()
      if (decls.length !== 1)
        continue
      if (decls[0].getName() === symbol)
        return vs
      continue
    }
    if (!MOVABLE_KINDS.has(kind))
      continue
    const named = stmt as Node & { hasExportKeyword?: () => boolean, hasDefaultKeyword?: () => boolean, getName?: () => string | undefined }
    if (!named.hasExportKeyword?.())
      continue
    if (named.hasDefaultKeyword?.())
      continue
    if (named.getName?.() === symbol)
      return stmt
  }
  return null
}

function getDeclarationFullText(decl: Node): string {
  const leading = decl.getLeadingCommentRanges()
  if (!leading.length)
    return decl.getText()
  const start = leading[0].getPos()
  return decl.getSourceFile().getFullText().slice(start, decl.getEnd())
}

function countReferencesOutside(sf: SourceFile, symbol: string, decl: Node): number {
  const declStart = decl.getStart(true)
  const declEnd = decl.getEnd()
  let count = 0
  sf.forEachDescendant((n) => {
    if (n.getKind() !== SyntaxKind.Identifier)
      return
    if (n.getText() !== symbol)
      return
    const p = n.getParent()
    if (p?.getKind() === SyntaxKind.ImportSpecifier || p?.getKind() === SyntaxKind.ImportClause)
      return
    const pos = n.getStart()
    if (pos >= declStart && pos < declEnd)
      return
    count++
  })
  return count
}

interface CollectedImport {
  moduleSpecifier: string
  namedImports: { name: string, alias?: string }[]
  defaultImport?: string
  namespaceImport?: string
}

function collectUsedImports(decl: Node, fromSF: SourceFile, selfName: string): CollectedImport[] {
  const referenced = new Set<string>()
  decl.forEachDescendant((n) => {
    if (n.getKind() === SyntaxKind.Identifier) {
      const name = n.getText()
      if (name !== selfName)
        referenced.add(name)
    }
  })

  const result: CollectedImport[] = []
  for (const imp of fromSF.getImportDeclarations()) {
    const names: { name: string, alias?: string }[] = []
    for (const ni of imp.getNamedImports()) {
      const local = ni.getAliasNode()?.getText() ?? ni.getName()
      if (referenced.has(local))
        names.push({ name: ni.getName(), alias: ni.getAliasNode()?.getText() })
    }
    const defaultImport = imp.getDefaultImport()
    const defaultName = defaultImport && referenced.has(defaultImport.getText()) ? defaultImport.getText() : undefined
    const ns = imp.getNamespaceImport()
    const nsName = ns && referenced.has(ns.getText()) ? ns.getText() : undefined
    if (names.length || defaultName || nsName) {
      result.push({ moduleSpecifier: imp.getModuleSpecifierValue(), namedImports: names, defaultImport: defaultName, namespaceImport: nsName })
    }
  }
  return result
}

function addOrMergeImport(sf: SourceFile, moduleSpecifier: string, spec: { namedImports: { name: string, alias?: string }[], defaultImport?: string, namespaceImport?: string }) {
  const existing = sf.getImportDeclarations().find(i => i.getModuleSpecifierValue() === moduleSpecifier)
  if (existing) {
    const have = new Set(existing.getNamedImports().map(ni => ni.getName()))
    for (const ni of spec.namedImports) {
      if (!have.has(ni.name))
        existing.addNamedImport({ name: ni.name, alias: ni.alias })
    }
    if (spec.defaultImport && !existing.getDefaultImport())
      existing.setDefaultImport(spec.defaultImport)
    if (spec.namespaceImport && !existing.getNamespaceImport())
      existing.setNamespaceImport(spec.namespaceImport)
    return
  }
  sf.addImportDeclaration({
    moduleSpecifier,
    namedImports: spec.namedImports,
    defaultImport: spec.defaultImport,
    namespaceImport: spec.namespaceImport,
  })
}

function pruneUnusedImports(sf: SourceFile): void {
  const used = new Set<string>()
  sf.forEachDescendant((n) => {
    if (n.getKind() === SyntaxKind.Identifier) {
      const p = n.getParent()
      const pk = p?.getKind()
      if (pk === SyntaxKind.ImportSpecifier || pk === SyntaxKind.ImportClause || pk === SyntaxKind.NamespaceImport)
        return
      used.add(n.getText())
    }
  })
  for (const imp of sf.getImportDeclarations()) {
    for (const ni of imp.getNamedImports()) {
      const local = ni.getAliasNode()?.getText() ?? ni.getName()
      if (!used.has(local))
        ni.remove()
    }
    const def = imp.getDefaultImport()
    if (def && !used.has(def.getText()))
      imp.removeDefaultImport()
    const ns = imp.getNamespaceImport()
    if (ns && !used.has(ns.getText()))
      imp.removeNamespaceImport()
    if (imp.getNamedImports().length === 0 && !imp.getDefaultImport() && !imp.getNamespaceImport())
      imp.remove()
  }
}

function rewriteImportSites(sf: SourceFile, fromAbs: string, toAbs: string, symbol: string): void {
  const imports: ImportDeclaration[] = sf.getImportDeclarations()
  for (const imp of imports) {
    if (!importResolvesTo(imp, fromAbs))
      continue
    const namedImports = imp.getNamedImports()
    const match = namedImports.find(ni => ni.getName() === symbol)
    const def = imp.getDefaultImport()
    if (!match && def?.getText() !== symbol)
      continue
    const alias = match?.getAliasNode()?.getText()
    const oldSpec = imp.getModuleSpecifierValue()
    const newSpec = computeSpecifier(sf.getFilePath(), toAbs, oldSpec)
    const existing = sf.getImportDeclarations().find(i => i.getModuleSpecifierValue() === newSpec && i !== imp)
    if (!existing && isSimpleSoleNamedImport(imp, symbol)) {
      imp.setModuleSpecifier(newSpec)
      continue
    }
    if (match)
      match.remove()
    if (!match && def?.getText() === symbol)
      imp.removeDefaultImport()
    if (existing) {
      existing.addNamedImport({ name: symbol, alias })
    }
    else {
      sf.addImportDeclaration({ moduleSpecifier: newSpec, namedImports: [{ name: symbol, alias }] })
    }
    if (imp.getNamedImports().length === 0 && !imp.getDefaultImport() && !imp.getNamespaceImport())
      imp.remove()
  }
}

function isSimpleSoleNamedImport(imp: ImportDeclaration, symbol: string): boolean {
  if (imp.getDefaultImport() || imp.getNamespaceImport())
    return false
  const named = imp.getNamedImports()
  if (named.length !== 1)
    return false
  const only = named[0]
  return only?.getName() === symbol && !only.getAliasNode()
}

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.vue']

function importResolvesTo(imp: ImportDeclaration, targetAbs: string): boolean {
  const specifier = imp.getModuleSpecifierValue()
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(imp.getSourceFile().getFilePath()), specifier)
    for (const ext of RESOLVE_EXTS) {
      const candidate = `${base}${ext}`
      if (candidate === targetAbs && (ext === '' || existsSync(candidate)))
        return true
    }
    for (const ext of RESOLVE_EXTS.slice(1)) {
      const candidate = join(base, `index${ext}`)
      if (candidate === targetAbs && existsSync(candidate))
        return true
    }
    return false
  }
  return imp.getModuleSpecifierSourceFile()?.getFilePath() === targetAbs
}

function sourceFilesMatching(project: Project, paths: string[], extra: SourceFile[] = []): SourceFile[] {
  const out: SourceFile[] = []
  const seen = new Set<string>()
  const add = (sf: SourceFile | undefined) => {
    if (!sf || seen.has(sf.getFilePath()))
      return
    seen.add(sf.getFilePath())
    out.push(sf)
  }
  for (const path of paths) add(project.getSourceFile(path))
  for (const sf of extra) add(sf)
  return out
}

function collectMoveVerifyFiles(sourceFiles: SourceFile[], fromSF: SourceFile, toSF: SourceFile): SourceFile[] {
  const out: SourceFile[] = []
  const seen = new Set<string>()
  const add = (sf: SourceFile) => {
    if (seen.has(sf.getFilePath()))
      return
    seen.add(sf.getFilePath())
    out.push(sf)
  }
  add(fromSF)
  add(toSF)
  for (const sf of sourceFiles) {
    if (sf === fromSF || sf === toSF)
      continue
    for (const imp of sf.getImportDeclarations()) {
      if (importResolvesTo(imp, fromSF.getFilePath()) || importResolvesTo(imp, toSF.getFilePath())) {
        add(sf)
        break
      }
    }
  }
  return out
}

const MODULE_EXT_RE = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/
const WIN_SEP_RE = /\\/g

function computeSpecifier(fromFilePath: string, toFilePath: string, oldSpec: string): string {
  const hasExt = MODULE_EXT_RE.test(oldSpec)
  let rel = relative(dirname(fromFilePath), toFilePath).replace(WIN_SEP_RE, '/')
  if (!hasExt)
    rel = rel.replace(MODULE_EXT_RE, '')
  if (!rel.startsWith('.'))
    rel = `./${rel}`
  return rel
}

function splitMultiDeclaratorIfNeeded(sf: SourceFile, symbol: string): void {
  for (const vs of sf.getVariableStatements()) {
    if (!vs.hasExportKeyword())
      continue
    const decls = vs.getDeclarationList().getDeclarations()
    if (decls.length < 2)
      continue
    if (!decls.some(d => d.getName() === symbol))
      continue
    const kind = vs.getDeclarationList().getDeclarationKind()
    const lines = decls.map((d) => {
      const name = d.getName()
      const typeNode = d.getTypeNode()?.getText()
      const initializer = d.getInitializer()?.getText()
      const typeAnno = typeNode ? `: ${typeNode}` : ''
      const init = initializer !== undefined ? ` = ${initializer}` : ''
      return `export ${kind} ${name}${typeAnno}${init}`
    })
    const idx = vs.getChildIndex()
    vs.remove()
    sf.insertStatements(idx, lines)
    return
  }
}

interface LocalSiblingDeps {
  nonExported: string[]
  exported: string[]
}

function findLocalSiblingDeps(decl: Node, fromSF: SourceFile, selfName: string): LocalSiblingDeps {
  const nonExported: string[] = []
  const exported: string[] = []
  const siblings = collectTopLevelSiblingNames(fromSF, decl)
  const localBindings = collectLocalBindingNames(decl)
  const seen = new Set<string>()
  decl.forEachDescendant((n) => {
    if (n.getKind() !== SyntaxKind.Identifier)
      return
    const name = n.getText()
    if (name === selfName || seen.has(name))
      return
    if (localBindings.has(name))
      return
    const parent = n.getParent()
    if (!parent)
      return
    const pk = parent.getKind()
    if (pk === SyntaxKind.ImportSpecifier || pk === SyntaxKind.ImportClause || pk === SyntaxKind.NamespaceImport)
      return
    if (pk === SyntaxKind.PropertyAssignment || pk === SyntaxKind.ShorthandPropertyAssignment || pk === SyntaxKind.PropertyDeclaration || pk === SyntaxKind.MethodDeclaration || pk === SyntaxKind.MethodSignature || pk === SyntaxKind.PropertySignature)
      return
    if (pk === SyntaxKind.PropertyAccessExpression) {
      const pa = parent as any
      if (pa.getNameNode?.() === n)
        return
    }
    if (pk === SyntaxKind.QualifiedName) {
      const qn = parent as any
      if (qn.getRight?.() === n)
        return
    }
    const sibling = siblings.get(name)
    if (!sibling)
      return
    if (sibling === 'local') {
      seen.add(name)
      nonExported.push(name)
    }
    else {
      seen.add(name)
      exported.push(name)
    }
  })
  return { nonExported, exported }
}

function collectTopLevelSiblingNames(fromSF: SourceFile, movedDecl: Node): Map<string, 'exported' | 'local'> {
  const out = new Map<string, 'exported' | 'local'>()
  for (const stmt of fromSF.getStatements()) {
    if (stmt === movedDecl)
      continue
    const exported = (stmt as any).hasExportKeyword?.() ? 'exported' : 'local'
    if (stmt.getKind() === SyntaxKind.VariableStatement) {
      const vs = stmt.asKindOrThrow(SyntaxKind.VariableStatement)
      for (const decl of vs.getDeclarationList().getDeclarations())
        out.set(decl.getName(), exported)
      continue
    }
    const name = (stmt as any).getName?.()
    if (typeof name === 'string' && name)
      out.set(name, exported)
  }
  return out
}

function collectLocalBindingNames(decl: Node): Set<string> {
  const out = new Set<string>()
  decl.forEachDescendant((n) => {
    const parent = n.getParent()
    if (!parent)
      return
    if (parent === decl)
      return
    const pk = parent.getKind()
    if (pk === SyntaxKind.VariableDeclaration || pk === SyntaxKind.Parameter || pk === SyntaxKind.TypeParameter) {
      const name = (parent as any).getName?.()
      if (typeof name === 'string')
        out.add(name)
      return
    }
    if (
      pk === SyntaxKind.FunctionDeclaration
      || pk === SyntaxKind.FunctionExpression
      || pk === SyntaxKind.ClassDeclaration
      || pk === SyntaxKind.ClassExpression
      || pk === SyntaxKind.InterfaceDeclaration
      || pk === SyntaxKind.TypeAliasDeclaration
      || pk === SyntaxKind.EnumDeclaration
    ) {
      const nameNode = (parent as any).getNameNode?.()
      if (nameNode === n)
        out.add(n.getText())
    }
  })
  return out
}

function findTsconfig(cwd: string): string | null {
  const tries = ['tsconfig.json', 'tsconfig.build.json']
  for (const t of tries) {
    try {
      readFileSync(resolve(cwd, t))
      return resolve(cwd, t)
    }
    catch {}
  }
  return null
}
