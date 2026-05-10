import type { Identifier, SourceFile } from 'ts-morph'
import type { ProfileSink } from './profile.ts'
import type { VerifyMode } from './project.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'
import { Project, SyntaxKind } from 'ts-morph'
import { loadAdapter } from './adapter.ts'
import { isGeneratedNuxtPath, isInsideNuxtAutoImportScope, removeGeneratedNuxtChanges } from './nuxt.ts'
import { timed, timedAsync } from './profile.ts'
import { findTsconfig, projectSourceFiles, resolveVerifyMode } from './project.ts'
import { applyTextEdits, mergeFileChanges, parseFile, parseSourceFile, rgFiles, spliceScript } from './util.ts'
import { findRegressions, snapshotDiagnostics } from './verify.ts'
import { rewriteTemplateReferences } from './vue-template.ts'

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

  const vueAdapter = vueEnabled && tsconfigPath ? await loadAdapter('vue') : null
  if (vueAdapter && tsconfigPath && timed(profile, 'vue prefilter', () => vueAdapter.hasFilesContaining(cwd, from))) {
    const vueChanges = await timedAsync(profile, 'vue rename', () => vueAdapter.applyRename(tsconfigPath, cwd, from, to, renameSites))
    for (const vc of vueChanges) {
      if (!changes.some(c => c.path === vc.path))
        changes.push(vc)
    }
  }

  if (vueAdapter?.autoImportScopes) {
    const scopes = timed(profile, 'auto-import scopes', () => vueAdapter.autoImportScopes!(cwd))
    if (declarations.some(decl => isInsideNuxtAutoImportScope(decl.getSourceFile().getFilePath(), scopes))) {
      removeVueLocalBindingChanges(changes, from)
      const fallbackChanges = timed(profile, 'nuxt rename fallback', () => applyNuxtBareIdentifierRename(cwd, from, to, changes))
      mergeFileChanges(changes, fallbackChanges)
    }
    if (scopes.size)
      removeGeneratedNuxtChanges(cwd, changes)
  }

  const regressions = baseline ? timed(profile, 'verify regressions', () => findRegressions(baseline, project, verifyFiles)) : []

  if (vueAdapter && verifyMode !== 'none' && tsconfigPath && changes.some(c => c.path.endsWith('.vue'))) {
    const vueRegs = await vueAdapter.regressions(tsconfigPath, cwd, changes)
    regressions.push(...vueRegs)
  }

  return { changes, scanned: loadedFiles.length, regressions }
}

function applyNuxtBareIdentifierRename(cwd: string, from: string, to: string, changes: FileChange[]): FileChange[] {
  const byPath = new Map(changes.map(change => [change.path, change]))
  const out: FileChange[] = []
  for (const path of rgFiles(from, { cwd })) {
    if (isGeneratedNuxtPath(cwd, path))
      continue
    const file = parseFile(path, cwd)
    const before = byPath.get(path)?.before ?? file.fullSource
    const current = byPath.get(path)?.after ?? before
    const currentFile = current === file.fullSource ? file : parseSourceFile(path, current, cwd)
    if (scriptDeclaresBinding(currentFile.scriptSource, from))
      continue
    const script = rewriteScriptIdentifiers(currentFile.scriptSource, from, to)
    let after = spliceScript(currentFile, script)
    if (currentFile.isSfc)
      after = rewriteTemplateReferences(after, from, to)
    if (after === current)
      continue
    out.push({
      path,
      rel: relative(cwd, path),
      before,
      after,
    })
  }
  return out
}

function removeVueLocalBindingChanges(changes: FileChange[], from: string): void {
  for (let i = changes.length - 1; i >= 0; i--) {
    const change = changes[i]
    if (change.path.endsWith('.vue') && scriptDeclaresBinding(change.before, from, false))
      changes.splice(i, 1)
  }
}

function scriptDeclaresBinding(source: string, name: string, includeImports: boolean = true): boolean {
  source = extractScriptSource(source) ?? source
  if (!source.includes(name))
    return false
  let program: any
  try {
    program = parseSync('script.ts', source).program
  }
  catch {
    return false
  }
  let found = false
  walk(program, {
    enter(node: any) {
      if (found)
        return
      if (node.type === 'VariableDeclarator' && bindingIncludes(node.id, name)) {
        found = true
        return
      }
      if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration' || node.type === 'TSInterfaceDeclaration' || node.type === 'TSTypeAliasDeclaration' || node.type === 'TSEnumDeclaration') && node.id?.name === name) {
        found = true
        return
      }
      if (includeImports && node.type === 'ImportSpecifier' && (node.local?.name ?? node.imported?.name) === name) {
        found = true
        return
      }
      if (includeImports && (node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier') && node.local?.name === name)
        found = true
    },
  })
  return found
}

function extractScriptSource(source: string): string | null {
  const match = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/i.exec(source)
  return match?.[1] ?? null
}

function bindingIncludes(node: any, name: string): boolean {
  if (!node)
    return false
  if (node.type === 'Identifier')
    return node.name === name
  if (node.type === 'ObjectPattern')
    return (node.properties ?? []).some((prop: any) => bindingIncludes(prop.value ?? prop.argument ?? prop.key, name))
  if (node.type === 'ArrayPattern')
    return (node.elements ?? []).some((element: any) => bindingIncludes(element, name))
  if (node.type === 'AssignmentPattern')
    return bindingIncludes(node.left, name)
  if (node.type === 'RestElement')
    return bindingIncludes(node.argument, name)
  return false
}

function rewriteScriptIdentifiers(source: string, from: string, to: string): string {
  if (!source.includes(from))
    return source
  let program: any
  try {
    program = parseSync('script.ts', source).program
  }
  catch {
    return source
  }
  const edits: { start: number, end: number }[] = []
  walk(program, {
    enter(node: any, parent: any) {
      if (node.type !== 'Identifier' || node.name !== from)
        return
      if (parent) {
        if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier')
          return
        if (parent.type === 'VariableDeclarator' && parent.id === node)
          return
        if ((parent.type === 'FunctionDeclaration' || parent.type === 'ClassDeclaration' || parent.type === 'TSInterfaceDeclaration' || parent.type === 'TSTypeAliasDeclaration' || parent.type === 'TSEnumDeclaration') && parent.id === node)
          return
        if (parent.type === 'MemberExpression' && !parent.computed && parent.property === node)
          return
        if ((parent.type === 'Property' || parent.type === 'ObjectProperty') && !parent.computed && parent.key === node && parent.value !== node)
          return
      }
      edits.push({ start: node.start, end: node.end })
    },
  })
  return applyTextEdits(source, edits.map(edit => ({ ...edit, replacement: to })))
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
