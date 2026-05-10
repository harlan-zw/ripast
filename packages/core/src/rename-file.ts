import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, relative, resolve } from 'node:path'
import process from 'node:process'
import { loadAdapter } from './adapter.ts'
import { rgFiles } from './util.ts'
import { rewriteTemplateReferences } from './vue-template.ts'

export interface RenameFileOptions {
  cwd?: string
  tsconfig?: string
  verify?: boolean
}

export interface RenameFileResult {
  changes: FileChange[]
  fileMove: { from: string, to: string }
  scanned: number
  regressions: Regression[]
}

export async function runRenameFile(oldPath: string, newPath: string, opts: RenameFileOptions = {}): Promise<RenameFileResult> {
  const cwd = opts.cwd ?? process.cwd()
  const oldAbs = resolve(cwd, oldPath)
  const inferredNewPath = extname(newPath) ? newPath : `${newPath}${extname(oldPath)}`
  const newAbs = resolve(cwd, inferredNewPath)

  if (!existsSync(oldAbs))
    throw new Error(`ripast rename-file: source "${oldPath}" does not exist`)
  if (existsSync(newAbs))
    throw new Error(`ripast rename-file: target "${newPath}" already exists`)

  const tsconfigPath = opts.tsconfig ? resolve(cwd, opts.tsconfig) : findTsconfig(cwd)
  if (!tsconfigPath)
    throw new Error('ripast rename-file: no tsconfig.json found; required for cross-file import rewriting')

  const vueAdapter = await loadAdapter('vue')
  if (!vueAdapter)
    throw new Error('ripast rename-file: requires the Vue adapter (install @ripast/vue or run via npx ripast)')

  const consumerChanges = await vueAdapter.applyFileRenameEdits(tsconfigPath, cwd, oldAbs, newAbs)
  const templateChanges = applyComponentTemplateRenameFallback(cwd, oldAbs, newAbs, consumerChanges)
  for (const change of templateChanges) {
    const existing = consumerChanges.find(c => c.path === change.path)
    if (existing)
      existing.after = change.after
    else
      consumerChanges.push(change)
  }
  const consumerNoSelf = consumerChanges.filter(c => c.path !== oldAbs && c.path !== newAbs && !isGeneratedNuxtPath(cwd, c.path))

  const verify = opts.verify ?? true
  const regressions = verify && consumerNoSelf.some(c => c.path.endsWith('.vue'))
    ? await vueAdapter.regressions(tsconfigPath, cwd, consumerNoSelf)
    : []

  return {
    changes: consumerNoSelf,
    fileMove: { from: oldAbs, to: newAbs },
    scanned: consumerNoSelf.length + 1,
    regressions,
  }
}

function applyComponentTemplateRenameFallback(cwd: string, oldAbs: string, newAbs: string, changes: FileChange[]): FileChange[] {
  if (!oldAbs.endsWith('.vue') || !newAbs.endsWith('.vue'))
    return []
  const oldName = basename(oldAbs, '.vue')
  const newName = basename(newAbs, '.vue')
  if (oldName === newName)
    return []
  const byPath = new Map(changes.map(change => [change.path, change]))
  const candidates = new Set([
    ...rgFiles(oldName, { cwd, glob: '*.vue' }),
    ...rgFiles(hyphenate(oldName), { cwd, glob: '*.vue' }),
  ])
  const out: FileChange[] = []
  for (const path of candidates) {
    const before = byPath.get(path)?.before ?? readFileSync(path, 'utf8')
    const baseAfter = byPath.get(path)?.after ?? before
    const after = rewriteTemplateReferences(baseAfter, oldName, newName)
    if (after === baseAfter)
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

function isGeneratedNuxtPath(cwd: string, filePath: string): boolean {
  const rel = relative(cwd, filePath).replace(/\\/g, '/')
  return rel === '.nuxt' || rel.startsWith('.nuxt/')
}

function hyphenate(s: string): string {
  return s.replace(/\B([A-Z])/g, '-$1').toLowerCase()
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
