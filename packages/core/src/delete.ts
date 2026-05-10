import type { Node, SourceFile } from 'ts-morph'
import type { VerifyMode } from './project.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { Project, SyntaxKind } from 'ts-morph'
import { findTsconfig, resolveVerifyMode } from './project.ts'
import { rgFiles } from './util.ts'
import { findRegressions, snapshotDiagnostics } from './verify.ts'

export interface DeleteOptions {
  cwd?: string
  tsconfig?: string
  verify?: boolean | VerifyMode
  lazy?: boolean
  project?: Project
}

export interface DeleteReference {
  file: string
  line: number
  col: number
}

export interface DeleteResult {
  changes: FileChange[]
  scanned: number
  regressions: Regression[]
}

const DELETABLE_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
])

export async function runDelete(symbol: string, fromPath: string, opts: DeleteOptions = {}): Promise<DeleteResult> {
  const cwd = opts.cwd ?? process.cwd()
  const verifyMode = resolveVerifyMode(opts.verify)
  const tsconfigPath = opts.tsconfig ? resolve(cwd, opts.tsconfig) : findTsconfig(cwd)
  const lazy = opts.lazy ?? true
  const projectMode = !opts.project && lazy && tsconfigPath && verifyMode !== 'project' ? 'lazy' : 'full'
  const project = opts.project ?? (tsconfigPath
    ? new Project({ tsConfigFilePath: tsconfigPath, skipAddingFilesFromTsConfig: projectMode === 'lazy' })
    : new Project({ compilerOptions: { allowJs: true, checkJs: true } }))

  const fromAbs = resolve(cwd, fromPath)
  const candidatePaths = rgFiles(symbol, { cwd })
  let fromSF = project.getSourceFile(fromAbs) ?? project.addSourceFileAtPathIfExists(fromAbs)
  if (!fromSF)
    fromSF = project.addSourceFileAtPath(fromAbs)

  if (projectMode === 'lazy') {
    for (const f of candidatePaths) project.addSourceFileAtPathIfExists(f)
  }

  const decl = findTopLevelDeclaration(fromSF, symbol)
  if (!decl) {
    throw new Error(
      `ripast delete: no top-level declaration named "${symbol}" in ${fromPath} `
      + `(supported: function, class, interface, type, enum, const/let/var with single declarator)`,
    )
  }

  const references = findReferencesOutsideDeclaration(decl.nameNode, decl.node, cwd)
  if (references.length) {
    const preview = references.slice(0, 20).map(ref => `${ref.file}:${ref.line}:${ref.col}`).join('\n')
    const extra = references.length > 20 ? `\n... ${references.length - 20} more` : ''
    throw new Error(`ripast delete: "${symbol}" still has ${references.length} reference${references.length === 1 ? '' : 's'}\n\n${preview}${extra}\n\nUse ripast scan ${symbol} to inspect usages.`)
  }

  const verifyFiles = verifyMode === 'none'
    ? []
    : verifyMode === 'project'
      ? project.getSourceFiles()
      : [fromSF]
  const baseline = verifyMode !== 'none' ? snapshotDiagnostics(project, verifyFiles) : null
  const before = fromSF.getFullText()

  decl.node.remove()
  pruneUnusedImports(fromSF)

  const after = fromSF.getFullText()
  const changes = after === before
    ? []
    : [{
        path: fromSF.getFilePath(),
        rel: relative(cwd, fromSF.getFilePath()),
        before,
        after,
      }]

  const regressions = baseline ? findRegressions(baseline, project, verifyFiles) : []

  return { changes, scanned: projectMode === 'full' ? project.getSourceFiles().length : new Set([...candidatePaths, fromAbs]).size, regressions }
}

interface DeletableDeclaration {
  node: Node & { remove: () => void }
  nameNode: Node
}

function findTopLevelDeclaration(sf: SourceFile, symbol: string): DeletableDeclaration | null {
  for (const stmt of sf.getStatements()) {
    if (stmt.getKind() === SyntaxKind.VariableStatement) {
      const vs = stmt.asKindOrThrow(SyntaxKind.VariableStatement)
      const decls = vs.getDeclarationList().getDeclarations()
      if (decls.length !== 1)
        continue
      const decl = decls[0]
      const nameNode = decl.getNameNode()
      if (nameNode.getKind() !== SyntaxKind.Identifier)
        continue
      if (decl.getName() === symbol)
        return { node: vs as Node & { remove: () => void }, nameNode }
      continue
    }
    if (!DELETABLE_KINDS.has(stmt.getKind()))
      continue
    const named = stmt as Node & {
      hasDefaultKeyword?: () => boolean
      getName?: () => string | undefined
      getNameNode?: () => Node | undefined
      remove?: () => void
    }
    if (named.hasDefaultKeyword?.())
      continue
    const nameNode = named.getNameNode?.()
    if (named.getName?.() === symbol && nameNode && named.remove)
      return { node: named as Node & { remove: () => void }, nameNode }
  }
  return null
}

function findReferencesOutsideDeclaration(nameNode: Node, declaration: Node, cwd: string): DeleteReference[] {
  const declStart = declaration.getStart(true)
  const declEnd = declaration.getEnd()
  const out: DeleteReference[] = []
  for (const ref of (nameNode as any).findReferencesAsNodes() as Node[]) {
    const sourceFile = ref.getSourceFile()
    const pos = ref.getStart()
    if (sourceFile.getFilePath() === declaration.getSourceFile().getFilePath() && pos >= declStart && pos < declEnd)
      continue
    const lc = sourceFile.getLineAndColumnAtPos(pos)
    out.push({
      file: relative(cwd, sourceFile.getFilePath()),
      line: lc.line,
      col: lc.column,
    })
  }
  out.sort((a, b) => `${a.file}\0${a.line}\0${a.col}`.localeCompare(`${b.file}\0${b.line}\0${b.col}`))
  return out
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
