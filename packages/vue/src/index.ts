import type { FrameworkAdapter } from '@ripast/core/adapter'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { extractTemplateExpressions, scan } from '@ripast/core/adapter'
import { URI } from 'vscode-uri'
import {
  applyVueImportRewrite,
  applyVueRename,
  hasVueFilesContaining,
  vueRegressions,
} from './bridge.ts'
import { finalizeVueFileRename } from './finalize-rename.ts'
import { addNuxtExplicitImports } from './nuxt-imports.ts'
import { isGeneratedNuxtPath, removeGeneratedNuxtChanges } from './nuxt-paths.ts'
import { createVueService, workspaceEditToChanges } from './service.ts'

const adapter: FrameworkAdapter = {
  name: 'vue',
  hasFilesContaining: hasVueFilesContaining,
  applyRename: applyVueRename,
  applyImportRewrite: applyVueImportRewrite,
  regressions: vueRegressions,
  extractTemplateExpressions,
  async applyFileRenameEdits(tsconfigPath, cwd, oldAbs, newAbs) {
    const vue = createVueService(tsconfigPath, cwd)
    try {
      const edits = await vue.service.getFileRenameEdits(URI.file(oldAbs), URI.file(newAbs))
      return edits ? workspaceEditToChanges(edits, vue, cwd) : []
    }
    finally { vue.dispose() }
  },
  autoImportScopes(cwd) {
    if (!isNuxtProject(cwd))
      return new Set()
    return nuxtAutoImportScopes(cwd)
  },
  isGeneratedPath: isGeneratedNuxtPath,
  filterGeneratedChanges: removeGeneratedNuxtChanges,
  addExplicitImports: ctx => addNuxtExplicitImports({ ...ctx, scan }),
  async finalizeFileRename(cwd, oldAbs, newAbs, existingChanges) {
    const scopes = isNuxtProject(cwd) ? nuxtAutoImportScopes(cwd) : new Set<string>()
    return finalizeVueFileRename(cwd, oldAbs, newAbs, existingChanges, scopes)
  },
}

export default adapter

const DEFAULT_NUXT_AUTO_IMPORT_DIRS = [
  'composables',
  'utils',
  'components',
  'server/utils',
  'middleware',
]

function isNuxtProject(cwd: string): boolean {
  if (existsSync(join(cwd, 'nuxt.config.ts')) || existsSync(join(cwd, 'nuxt.config.js')) || existsSync(join(cwd, '.nuxt')))
    return true
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath))
    return false
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
    return Boolean(deps.nuxt || deps['@nuxt/kit'])
  }
  catch {
    return false
  }
}

function nuxtAutoImportScopes(cwd: string): Set<string> {
  const dirs = new Set(DEFAULT_NUXT_AUTO_IMPORT_DIRS)
  const configPath = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.mts']
    .map(name => join(cwd, name))
    .find(path => existsSync(path))
  if (configPath) {
    try {
      for (const dir of extractConfiguredDirs(readFileSync(configPath, 'utf8')))
        dirs.add(dir)
    }
    catch {}
  }
  return new Set([...dirs].map(dir => resolve(cwd, stripGlob(dir))))
}

function extractConfiguredDirs(source: string): string[] {
  const dirs: string[] = []
  for (const match of source.matchAll(/\bdirs\s*:\s*\[([\s\S]*?)\]/g)) {
    for (const str of match[1].matchAll(/['"`]([^'"`]+)['"`]/g))
      dirs.push(str[1])
  }
  for (const match of source.matchAll(/\bcomponents\s*:\s*\[([\s\S]*?)\]/g)) {
    for (const str of match[1].matchAll(/(?:path\s*:\s*)?['"`]([^'"`]+)['"`]/g))
      dirs.push(str[1])
  }
  return dirs.filter(dir => !dir.startsWith('#') && !dir.startsWith('~') && !dir.startsWith('@'))
}

function stripGlob(dir: string): string {
  return dir.replace(/\/\*\*.*$/, '').replace(/\/\*.*$/, '')
}
