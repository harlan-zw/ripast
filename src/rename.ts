import type { Identifier, SourceFile } from 'ts-morph'
import type { ProfileSink } from './profile.ts'
import type { VerifyMode } from './project.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { Project, SyntaxKind } from 'ts-morph'
import { timed, timedAsync } from './profile.ts'
import { projectSourceFiles, resolveVerifyMode } from './project.ts'
import { rgFiles } from './util.ts'
import { findRegressions, snapshotDiagnostics } from './verify.ts'
import { applyVueRename, hasVueFilesContaining, vueRegressions } from './vue-bridge.ts'

export interface RenameOptions {
  cwd?: string
  tsconfig?: string
  glob?: string | string[]
  verify?: boolean | VerifyMode
  lazy?: boolean
  project?: Project
  scope?: string
  allowMultiple?: boolean
  vue?: boolean
  profile?: ProfileSink
}

export interface RenameResult {
  changes: FileChange[]
  scanned: number
  regressions: Regression[]
}

const DECLARATION_KINDS = new Set<SyntaxKind>([
  SyntaxKind.FunctionDeclaration,
  SyntaxKind.ClassDeclaration,
  SyntaxKind.InterfaceDeclaration,
  SyntaxKind.TypeAliasDeclaration,
  SyntaxKind.EnumDeclaration,
  SyntaxKind.VariableDeclaration,
])

export async function runRename(from: string, to: string, opts: RenameOptions = {}): Promise<RenameResult> {
  const cwd = opts.cwd ?? process.cwd()
  const profile = opts.profile
  const verifyMode = resolveVerifyMode(opts.verify)
  const vueEnabled = opts.vue ?? true
  const tsconfigPath = timed(profile, 'find tsconfig', () => opts.tsconfig ? resolve(cwd, opts.tsconfig) : findTsconfig(cwd))
  const lazy = opts.lazy ?? true
  const projectMode = !opts.project && lazy && !vueEnabled && tsconfigPath && verifyMode !== 'project' ? 'lazy' : 'full'
  const candidatePaths = timed(profile, 'rg candidates', () => rgFiles(from, { cwd, glob: opts.glob }))
  const project = timed(profile, 'project load', () => opts.project ?? (tsconfigPath
    ? new Project({ tsConfigFilePath: tsconfigPath, skipAddingFilesFromTsConfig: projectMode === 'lazy' })
    : new Project({ compilerOptions: { allowJs: true } })))

  if (!tsconfigPath) {
    for (const f of candidatePaths) project.addSourceFileAtPath(f)
  }
  else if (projectMode === 'lazy') {
    for (const f of candidatePaths) project.addSourceFileAtPathIfExists(f)
  }

  const loadedFiles = timed(profile, 'map candidates', () => projectSourceFiles(project, candidatePaths, projectMode))
  const candidateFiles = sourceFilesMatching(project, candidatePaths)

  const originals = timed(profile, 'snapshot originals', () => {
    const out = new Map<string, string>()
    for (const sf of candidateFiles) out.set(sf.getFilePath(), sf.getFullText())
    return out
  })

  const allDeclarations = timed(profile, 'find declarations', () => findDeclarations(candidateFiles, from))
  const declarations = opts.scope
    ? allDeclarations.filter(d => d.getSourceFile().getFilePath() === resolve(cwd, opts.scope!))
    : allDeclarations

  if (!declarations.length) {
    if (opts.scope)
      throw new Error(`ripast rename: no declaration of "${from}" in ${opts.scope}`)
    throw new Error(`ripast rename: no declaration of "${from}" found in project`)
  }

  const uniqueFiles = new Set(declarations.map(d => relative(cwd, d.getSourceFile().getFilePath())))
  if (uniqueFiles.size > 1 && !opts.allowMultiple) {
    throw new Error(`ripast rename: "${from}" is declared in multiple files (${[...uniqueFiles].join(', ')}). Pass --scope <file> to pick one, or --all to rename every occurrence.`)
  }

  const verifyFiles = verifyMode === 'none'
    ? []
    : verifyMode === 'project'
      ? loadedFiles
      : candidateFiles
  const baseline = verifyMode !== 'none' ? timed(profile, 'verify baseline', () => snapshotDiagnostics(project, verifyFiles)) : null

  const renameSites = declarations.map((decl) => {
    const sf = decl.getSourceFile()
    return { filePath: sf.getFilePath(), source: sf.getFullText(), pos: decl.getStart() }
  })

  timed(profile, 'rename transform', () => {
    for (const decl of declarations) {
      try {
        (decl as any).rename?.(to)
      }
      catch {}
    }
  })

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

  if (vueEnabled && tsconfigPath && timed(profile, 'vue prefilter', () => hasVueFilesContaining(cwd, from))) {
    const vueChanges = await timedAsync(profile, 'vue rename', () => applyVueRename(tsconfigPath, cwd, from, to, renameSites))
    for (const vc of vueChanges) {
      if (!changes.some(c => c.path === vc.path))
        changes.push(vc)
    }
  }

  const regressions = baseline ? timed(profile, 'verify regressions', () => findRegressions(baseline, project, verifyFiles)) : []

  if (vueEnabled && verifyMode !== 'none' && tsconfigPath && changes.some(c => c.path.endsWith('.vue'))) {
    const vueRegs = await vueRegressions(tsconfigPath, cwd, changes)
    regressions.push(...vueRegs)
  }

  return { changes, scanned: loadedFiles.length, regressions }
}

function findDeclarations(sourceFiles: SourceFile[], name: string): Identifier[] {
  const out: Identifier[] = []
  const seen = new Set<string>()
  for (const sf of sourceFiles) {
    for (const id of topLevelDeclarationNames(sf)) {
      if (id.getText() !== name)
        continue
      const key = `${id.getSourceFile().getFilePath()}:${id.getStart()}`
      if (seen.has(key))
        continue
      seen.add(key)
      out.push(id)
    }
  }
  return out
}

function topLevelDeclarationNames(sf: SourceFile): Identifier[] {
  const out: Identifier[] = []
  for (const stmt of sf.getStatements()) {
    if (stmt.getKind() === SyntaxKind.VariableStatement) {
      const vs = stmt.asKindOrThrow(SyntaxKind.VariableStatement)
      for (const decl of vs.getDeclarationList().getDeclarations()) {
        const nameNode = decl.getNameNode()
        if (nameNode.getKind() === SyntaxKind.Identifier)
          out.push(nameNode as Identifier)
      }
      continue
    }
    if (!DECLARATION_KINDS.has(stmt.getKind()))
      continue
    const nameNode = (stmt as any).getNameNode?.()
    if (nameNode?.getKind?.() === SyntaxKind.Identifier)
      out.push(nameNode)
  }
  return out
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
