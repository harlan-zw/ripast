import type { AutoImportRenamePlan, FileChange, Regression, RenameSite } from 'ripide-api/adapter'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { diagnosticRegressions, posToLineCol, rewriteTemplateReferences } from 'ripide-api/adapter'
import { URI } from 'vscode-uri'
import { createVueService, vueProjectConfigs, withFilteredConsoleWarn, workspaceEditToChanges, workspaceRelativePath } from './service.ts'
import { hasVueFilesContaining, listVueFiles, listVueFilesContaining } from './vue-files.ts'

export { hasVueFilesContaining }

export async function applyVueRename(
  tsconfigPath: string,
  cwd: string,
  from: string,
  to: string,
  sites: RenameSite[],
  autoImportPlan?: AutoImportRenamePlan,
): Promise<FileChange[]> {
  const byPath = new Map<string, FileChange>()
  for (const project of vueProjectConfigs(tsconfigPath)) {
    const vue = createVueService(project.tsconfigPath, cwd)
    try {
      for (const site of sites) {
        const uri = URI.file(resolve(cwd, site.filePath))
        const { line, col } = posToLineCol(site.source, site.pos)
        const edits = await vue.service.getRenameEdits(uri, { line: line - 1, character: col - 1 }, to)
        if (!edits)
          continue
        const vueChanges = workspaceEditToChanges(edits, vue, cwd, fileName => fileName.endsWith('.vue'), autoImportPlan?.transformEdits)
        for (const c of vueChanges) {
          const existing = byPath.get(c.path)
          if (existing && existing.after !== c.after)
            throw new Error(`ripide: Vue projects disagree on edits for ${c.rel}. Use an explicit tsconfig.`)
          byPath.set(c.path, c)
        }
      }
    }
    finally { vue.dispose() }
  }
  if (autoImportPlan)
    return [...byPath.values()]
  // Volar misses Vue template references: component tag usage and pure-template-only
  // identifier refs (used in {{ }} but not in script). Sweep .vue consumers that
  // mention `from` and apply a template-AST post-pass.
  const consumerPaths = new Set<string>(byPath.keys())
  for (const p of listVueFilesContaining(cwd, from)) consumerPaths.add(p)
  for (const path of consumerPaths) {
    const existing = byPath.get(path)
    const before = existing?.before ?? safeReadFile(path)
    if (before === undefined)
      continue
    const baseAfter = existing?.after ?? before
    if (hasLocalScriptBinding(baseAfter, from))
      continue
    const rewritten = rewriteTemplateReferences(baseAfter, from, to)
    if (rewritten === baseAfter)
      continue
    byPath.set(path, {
      path,
      rel: existing?.rel ?? workspaceRelativePath(path, cwd),
      before,
      after: rewritten,
    })
  }
  return [...byPath.values()]
}

function hasLocalScriptBinding(source: string, name: string): boolean {
  const script = extractScript(source)
  if (!script?.includes(name))
    return false
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const withoutImports = script.replace(/^\s*import [^;\n]*;?$/gm, '')
  return new RegExp(`\\b(?:const|let|var|function|class|interface|type|enum)\\s+${escaped}\\b`).test(withoutImports)
}

function extractScript(source: string): string | null {
  const match = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/i.exec(source)
  return match?.[1] ?? null
}

function safeReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return undefined
  }
}

export async function applyVueImportRewrite(
  tsconfigPath: string,
  cwd: string,
  fromAbs: string,
  toAbs: string,
): Promise<FileChange[]> {
  return applyVueFileRenameEdits(tsconfigPath, cwd, fromAbs, toAbs, fileName => fileName.endsWith('.vue'))
}

export async function applyVueFileRenameEdits(
  tsconfigPath: string,
  cwd: string,
  fromAbs: string,
  toAbs: string,
  filter?: (fileName: string) => boolean,
): Promise<FileChange[]> {
  const byPath = new Map<string, FileChange>()
  for (const project of vueProjectConfigs(tsconfigPath)) {
    const vue = createVueService(project.tsconfigPath, cwd)
    try {
      const edits = await vue.service.getFileRenameEdits(URI.file(fromAbs), URI.file(toAbs))
      if (!edits)
        continue
      for (const change of workspaceEditToChanges(edits, vue, cwd, filter)) {
        const existing = byPath.get(change.path)
        if (existing && existing.after !== change.after)
          throw new Error(`ripide: Vue projects disagree on edits for ${change.rel}. Use an explicit tsconfig.`)
        byPath.set(change.path, change)
      }
    }
    finally { vue.dispose() }
  }
  return [...byPath.values()]
}

export async function vueRegressions(
  tsconfigPath: string,
  cwd: string,
  pendingChanges: FileChange[],
): Promise<Regression[]> {
  const vueFiles = listVueFiles(cwd)
  const pendingVue = pendingChanges.filter(change => change.path.endsWith('.vue'))
  if (!vueFiles.length && !pendingVue.length)
    return []
  const projects = vueProjectConfigs(tsconfigPath)
  for (const change of pendingVue) {
    if (projects.some(project => project.files.includes(change.path)))
      continue
    if (projects.length !== 1)
      throw new Error(`ripide: cannot select a Vue project for ${change.rel}. Use an explicit tsconfig.`)
    projects[0].files.push(change.path)
  }
  const out: Regression[] = []
  for (const project of projects) {
    const selected = new Set(project.files)
    const files = [...new Set([...vueFiles, ...pendingVue.map(change => change.path)])].filter(file => selected.has(file))
    if (!files.length)
      continue
    const vue = createVueService(project.tsconfigPath, cwd)
    try {
      for (const file of files)
        vue.setSnapshot(file, pendingVue.find(change => change.path === file)?.before ?? readFileSync(file, 'utf8'))
      for (const change of pendingChanges) {
        if (change.path.endsWith('.vue') && !selected.has(change.path))
          continue
        vue.setSnapshot(change.path, change.before)
      }
      const baseline = new Map(await withFilteredConsoleWarn(() => Promise.all(
        files.map(async file => [file, (await getDiags(vue, file)).filter(diagnostic => diagnostic.severity === 1)] as const),
      )))
      for (const c of pendingChanges) {
        if (c.path.endsWith('.vue') && !selected.has(c.path))
          continue
        vue.setSnapshot(c.path, c.after)
      }
      const postPairs = await withFilteredConsoleWarn(() => Promise.all(
        files.map(async file => [file, await getDiags(vue, file)] as const),
      ))
      const after = new Map(postPairs.map(([file, diagnostics]) => [file, diagnostics.filter(diagnostic => diagnostic.severity === 1)]))
      out.push(...diagnosticRegressions(baseline, after, pendingChanges))
    }
    finally { vue.dispose() }
  }
  return out
}

async function getDiags(vue: ReturnType<typeof createVueService>, fileName: string): Promise<{ range: { start: { line: number, character: number }, end: { line: number, character: number } }, severity?: number, code?: string | number, message: string }[]> {
  const uri = URI.file(fileName)
  return await vue.service.getDiagnostics(uri) as any
}
