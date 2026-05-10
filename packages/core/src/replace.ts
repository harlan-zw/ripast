import type { Node, SourceFile } from 'ts-morph'
import type { VerifyMode } from './project.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { dirname, relative, resolve } from 'node:path'
import process from 'node:process'
import { Project, SyntaxKind } from 'ts-morph'
import { findTsconfig, projectSourceFiles, resolveVerifyMode } from './project.ts'
import { rgFiles } from './util.ts'
import { findRegressions, snapshotDiagnostics } from './verify.ts'

export interface ReplaceOptions {
  cwd?: string
  tsconfig?: string
  glob?: string | string[]
  verify?: boolean | VerifyMode
  lazy?: boolean
  project?: Project
  targetScope?: string
}

export interface ReplaceResult {
  changes: FileChange[]
  scanned: number
  regressions: Regression[]
}

interface ImportName {
  name: string
  alias?: string
  isTypeOnly?: boolean
}

interface ReplacementTarget {
  filePath: string
  importName: string
  isTypeOnly: boolean
}

const REPLACEABLE_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
])

export async function runReplace(from: string, to: string, opts: ReplaceOptions = {}): Promise<ReplaceResult> {
  const cwd = opts.cwd ?? process.cwd()
  const verifyMode = resolveVerifyMode(opts.verify)
  const tsconfigPath = opts.tsconfig ? resolve(cwd, opts.tsconfig) : findTsconfig(cwd)
  const lazy = opts.lazy ?? true
  const projectMode = !opts.project && lazy && tsconfigPath && verifyMode !== 'project' ? 'lazy' : 'full'
  const candidatePaths = rgFiles(from, { cwd, glob: opts.glob })
  const project = opts.project ?? (tsconfigPath
    ? new Project({ tsConfigFilePath: tsconfigPath, skipAddingFilesFromTsConfig: projectMode === 'lazy' })
    : new Project({ compilerOptions: { allowJs: true, checkJs: true } }))

  if (!tsconfigPath) {
    for (const f of rgFiles('', { cwd, glob: opts.glob, listAll: true })) project.addSourceFileAtPathIfExists(f)
  }
  else if (projectMode === 'lazy') {
    for (const f of candidatePaths) project.addSourceFileAtPathIfExists(f)
    for (const f of rgFiles(to, { cwd, glob: opts.glob })) project.addSourceFileAtPathIfExists(f)
  }

  const loadedFiles = projectSourceFiles(project, candidatePaths, projectMode)
  const target = findReplacementTarget(project, to, cwd, opts.targetScope)
  const candidateFiles = sourceFilesMatching(project, candidatePaths)

  const originals = new Map<string, string>()
  for (const sf of candidateFiles) originals.set(sf.getFilePath(), sf.getFullText())

  const verifyFiles = verifyMode === 'none'
    ? []
    : verifyMode === 'project'
      ? project.getSourceFiles()
      : candidateFiles
  const baseline = verifyMode !== 'none' ? snapshotDiagnostics(project, verifyFiles) : null

  for (const sf of candidateFiles)
    replaceImportedSymbol(sf, from, to, target)

  const changes: FileChange[] = []
  for (const sf of candidateFiles) {
    const before = originals.get(sf.getFilePath()) ?? ''
    const after = sf.getFullText()
    if (after !== before) {
      changes.push({
        path: sf.getFilePath(),
        rel: relative(cwd, sf.getFilePath()),
        before,
        after,
      })
    }
  }

  const regressions = baseline ? findRegressions(baseline, project, verifyFiles) : []
  return { changes, scanned: loadedFiles.length, regressions }
}

function findReplacementTarget(project: Project, symbol: string, cwd: string, targetScope?: string): ReplacementTarget {
  const matches: ReplacementTarget[] = []
  const scopeAbs = targetScope ? resolve(cwd, targetScope) : null
  for (const sf of project.getSourceFiles()) {
    if (scopeAbs && sf.getFilePath() !== scopeAbs)
      continue
    const match = findExportedDeclaration(sf, symbol)
    if (match)
      matches.push(match)
  }
  if (!matches.length) {
    if (targetScope)
      throw new Error(`ripast replace: no exported declaration of "${symbol}" in ${targetScope}`)
    throw new Error(`ripast replace: no exported declaration of "${symbol}" found in project`)
  }
  const uniqueFiles = new Set(matches.map(m => relative(cwd, m.filePath)))
  if (uniqueFiles.size > 1) {
    throw new Error(
      `ripast replace: "${symbol}" is exported from multiple files (${[...uniqueFiles].join(', ')}). `
      + `Pass --target-scope <file> to pick one.`,
    )
  }
  return matches[0]
}

function findExportedDeclaration(sf: SourceFile, symbol: string): ReplacementTarget | null {
  for (const stmt of sf.getStatements()) {
    if (stmt.getKind() === SyntaxKind.VariableStatement) {
      const vs = stmt.asKindOrThrow(SyntaxKind.VariableStatement)
      if (!vs.hasExportKeyword())
        continue
      for (const decl of vs.getDeclarationList().getDeclarations()) {
        if (decl.getName() === symbol) {
          return {
            filePath: sf.getFilePath(),
            importName: symbol,
            isTypeOnly: false,
          }
        }
      }
      continue
    }
    if (!REPLACEABLE_KINDS.has(stmt.getKind()))
      continue
    const named = stmt as Node & {
      hasExportKeyword?: () => boolean
      hasDefaultKeyword?: () => boolean
      getName?: () => string | undefined
    }
    if (!named.hasExportKeyword?.() || named.hasDefaultKeyword?.())
      continue
    if (named.getName?.() === symbol) {
      return {
        filePath: sf.getFilePath(),
        importName: symbol,
        isTypeOnly: stmt.getKind() === SyntaxKind.InterfaceDeclaration || stmt.getKind() === SyntaxKind.TypeAliasDeclaration,
      }
    }
  }
  return null
}

function replaceImportedSymbol(sf: SourceFile, from: string, to: string, target: ReplacementTarget): void {
  let replaced = false
  for (const imp of [...sf.getImportDeclarations()]) {
    for (const ni of [...imp.getNamedImports()]) {
      const local = ni.getAliasNode()?.getText() ?? ni.getName()
      if (local !== from)
        continue
      const binding = ni.getAliasNode() ?? ni.getNameNode()
      for (const ref of findReferenceNodes(binding)) {
        if (ref.getSourceFile() !== sf)
          continue
        if (isInsideImportDeclaration(ref))
          continue
        ref.replaceWithText(to)
        replaced = true
      }
      ni.remove()
    }

    const def = imp.getDefaultImport()
    if (def?.getText() === from) {
      for (const ref of findReferenceNodes(def)) {
        if (ref.getSourceFile() !== sf)
          continue
        if (isInsideImportDeclaration(ref))
          continue
        ref.replaceWithText(to)
        replaced = true
      }
      imp.removeDefaultImport()
    }

    if (imp.getNamedImports().length === 0 && !imp.getDefaultImport() && !imp.getNamespaceImport())
      imp.remove()
  }

  if (!replaced)
    return

  const specifier = computeSpecifier(sf.getFilePath(), target.filePath, './placeholder.ts')
  addOrMergeImport(sf, specifier, {
    namedImports: [{ name: target.importName, alias: target.importName === to ? undefined : to, isTypeOnly: target.isTypeOnly }],
    isTypeOnly: target.isTypeOnly,
  })
  pruneUnusedImports(sf)
}

function findReferenceNodes(node: Node): Node[] {
  return (node as any).findReferencesAsNodes?.() as Node[] ?? []
}

function isInsideImportDeclaration(node: Node): boolean {
  return !!node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)
}

function addOrMergeImport(sf: SourceFile, moduleSpecifier: string, spec: { namedImports: ImportName[], isTypeOnly?: boolean }) {
  const existing = sf.getImportDeclarations().find(i => i.getModuleSpecifierValue() === moduleSpecifier && i.isTypeOnly() === !!spec.isTypeOnly)
  if (existing) {
    const have = new Set(existing.getNamedImports().map(ni => `${ni.getName()}:${ni.getAliasNode()?.getText() ?? ''}`))
    for (const ni of spec.namedImports) {
      const key = `${ni.name}:${ni.alias ?? ''}`
      if (!have.has(key))
        existing.addNamedImport({ name: ni.name, alias: ni.alias, isTypeOnly: !existing.isTypeOnly() && ni.isTypeOnly })
    }
    return
  }
  sf.addImportDeclaration({
    moduleSpecifier,
    isTypeOnly: spec.isTypeOnly,
    namedImports: spec.namedImports.map(ni => ({ name: ni.name, alias: ni.alias, isTypeOnly: !spec.isTypeOnly && ni.isTypeOnly })),
  })
}

function pruneUnusedImports(sf: SourceFile): void {
  const used = new Set<string>()
  sf.forEachDescendant((n) => {
    if (n.getKind() !== SyntaxKind.Identifier)
      return
    const p = n.getParent()
    const pk = p?.getKind()
    if (pk === SyntaxKind.ImportSpecifier || pk === SyntaxKind.ImportClause || pk === SyntaxKind.NamespaceImport)
      return
    used.add(n.getText())
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

function sourceFilesMatching(project: Project, paths: string[]): SourceFile[] {
  const out: SourceFile[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    const sf = project.getSourceFile(path)
    if (!sf || seen.has(sf.getFilePath()))
      continue
    seen.add(sf.getFilePath())
    out.push(sf)
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
