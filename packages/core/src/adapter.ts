import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Adapter SDK entry. @ripast/<framework> packages import from here.
export { posToLineCol, rgFiles } from './util.ts'
export type { FileChange } from './util.ts'
export type { Regression } from './verify.ts'
export { extractTemplateExpressions, rewriteTemplateReferences } from './vue-template.ts'

export type FrameworkName = 'vue' | 'nuxt' | 'svelte'

export interface RenameSite {
  filePath: string
  source: string
  pos: number
}

export interface TemplateExpression {
  code: string
  offsetInSource: number
}

export interface FrameworkAdapter {
  name: string
  capabilities?: {
    nuxt?: boolean
  }

  hasFilesContaining: (cwd: string, pattern: string) => boolean

  applyRename: (
    tsconfigPath: string,
    cwd: string,
    from: string,
    to: string,
    sites: RenameSite[],
  ) => Promise<FileChange[]>

  applyImportRewrite: (
    tsconfigPath: string,
    cwd: string,
    fromAbs: string,
    toAbs: string,
  ) => Promise<FileChange[]>

  applyFileRenameEdits: (
    tsconfigPath: string,
    cwd: string,
    oldAbs: string,
    newAbs: string,
  ) => Promise<FileChange[]>

  regressions: (
    tsconfigPath: string,
    cwd: string,
    changes: FileChange[],
  ) => Promise<Regression[]>

  extractTemplateExpressions?: (source: string) => TemplateExpression[]

  autoImportScopes?: (cwd: string) => Set<string>
}

const cache = new Map<FrameworkName, FrameworkAdapter | null>()

export async function loadAdapter(name: FrameworkName): Promise<FrameworkAdapter | null> {
  if (cache.has(name))
    return cache.get(name) ?? null

  const tryImport = async (spec: string): Promise<FrameworkAdapter | null> => {
    try {
      const mod = await import(spec)
      return (mod.default ?? mod) as FrameworkAdapter
    }
    catch { return null }
  }

  const adapterName = name === 'nuxt' ? 'vue' : name
  const external = await tryImport(`@ripast/${adapterName}`)
  const bundledVue = new URL('../../vue/src/index.ts', import.meta.url).href
  const resolved = external ?? (adapterName === 'vue' ? await tryImport(bundledVue) : null)
  const adapter = name === 'nuxt' && resolved
    ? { ...resolved, capabilities: { ...resolved.capabilities, nuxt: true } }
    : resolved

  cache.set(name, adapter)
  return adapter
}

export function detectFrameworks(cwd: string): FrameworkName[] {
  const out: FrameworkName[] = []
  const seen = new Set<string>()
  let dir = cwd
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
        for (const [name, marker] of [
          ['nuxt', ['nuxt', '@nuxt/kit']] as const,
          ['vue', ['vue']] as const,
          ['svelte', ['svelte', '@sveltejs/kit']] as const,
        ]) {
          if (seen.has(name))
            continue
          if (marker.some(m => allDeps[m])) {
            out.push(name as FrameworkName)
            seen.add(name)
          }
        }
      }
      catch {}
    }
    const parent = join(dir, '..')
    if (parent === dir)
      break
    dir = parent
  }
  return out
}

export function resetAdapterCache(): void {
  cache.clear()
}
