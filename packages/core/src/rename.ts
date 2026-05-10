import type { Identifier, SourceFile } from 'ts-morph'
import type { ProfileSink } from './profile.ts'
import type { VerifyMode } from './project.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'
import { Project, SyntaxKind } from 'ts-morph'
import { loadAdapter } from './adapter.ts'
import { timed, timedAsync } from './profile.ts'
import { projectSourceFiles, resolveVerifyMode } from './project.ts'
import { parseFile, rgFiles, spliceScript } from './util.ts'
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
    if (declarations.some(decl => isInsideAnyScope(decl.getSourceFile().getFilePath(), scopes))) {
      removeVueLocalBindingChanges(changes, from)
      const fallbackChanges = timed(profile, 'nuxt rename fallback', () => applyNuxtBareIdentifierRename(cwd, from, to, changes))
      for (const change of fallbackChanges) {
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
    const currentFile = current === file.fullSource ? file : parseFileFromSource(path, cwd, current)
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
  return applyIdentifierEdits(source, edits, to)
}

function applyIdentifierEdits(source: string, edits: { start: number, end: number }[], to: string): string {
  if (!edits.length)
    return source
  edits.sort((a, b) => a.start - b.start)
  let out = ''
  let cursor = 0
  for (const edit of edits) {
    if (edit.start < cursor)
      continue
    out += source.slice(cursor, edit.start) + to
    cursor = edit.end
  }
  out += source.slice(cursor)
  return out
}

function parseFileFromSource(path: string, cwd: string, source: string): ReturnType<typeof parseFile> {
  const rel = relative(cwd, path)
  if (!path.endsWith('.vue')) {
    let program: any = null
    try {
      program = parseSync(path, source).program
    }
    catch {}
    return { path, rel, fullSource: source, scriptSource: source, scriptStart: 0, scriptEnd: source.length, program, isSfc: false }
  }
  const match = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .filter(m => !/\bsrc\s*=/.test(source.slice(m.index ?? 0, source.indexOf('>', m.index ?? 0) + 1)))
    .at(0)
  if (!match || match.index === undefined)
    return { path, rel, fullSource: source, scriptSource: '', scriptStart: 0, scriptEnd: 0, program: null, isSfc: true }
  const tagEnd = source.indexOf('>', match.index) + 1
  const scriptSource = match[1]
  let program: any = null
  try {
    program = parseSync(`${path}.ts`, scriptSource).program
  }
  catch {}
  return { path, rel, fullSource: source, scriptSource, scriptStart: tagEnd, scriptEnd: tagEnd + scriptSource.length, program, isSfc: true }
}

function isInsideAnyScope(filePath: string, scopes: Set<string>): boolean {
  for (const scope of scopes) {
    if (filePath === scope || filePath.startsWith(`${scope}/`))
      return true
  }
  return false
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
