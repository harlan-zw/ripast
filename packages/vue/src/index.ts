import type { FileChange, FrameworkAdapter } from '@ripast/core/adapter'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { extractTemplateExpressions, rgFiles, scan } from '@ripast/core/adapter'
import { URI } from 'vscode-uri'
import {
  applyVueImportRewrite,
  applyVueRename,
  hasVueFilesContaining,
  vueRegressions,
} from './bridge.ts'
import { parseComponent, parseComponentSource } from './component-parse.ts'
import { findComponentUsage, findComponentUsages } from './component-usages.ts'
import { listComponents } from './components.ts'
import { doctor } from './doctor.ts'
import { finalizeVueFileRename } from './finalize-rename.ts'
import { loadNuxtProviderPaths, nuxtConsumerContext } from './nuxt-bindings.ts'
import { inspectNuxtAutoImportConsumers, validateNuxtAutoImportRename } from './nuxt-delete.ts'
import { addNuxtExplicitImports } from './nuxt-imports.ts'
import { aliasResolvesToTarget, isGeneratedNuxtPath, loadConsumerLocalAliases, removeGeneratedNuxtChanges } from './nuxt-paths.ts'
import { createVueService, workspaceEditToChanges } from './service.ts'

export { parseComponent, parseComponentSource } from './component-parse.ts'
export type { ParsedComponentShape, PropSig } from './component-parse.ts'
export { findComponentUsage, findComponentUsages } from './component-usages.ts'
export type { ComponentUsage, UsageForm } from './component-usages.ts'
export { listComponents } from './components.ts'
export type { ComponentKind, ListComponentsOptions, VueComponent } from './components.ts'

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
      const changes = edits ? workspaceEditToChanges(edits, vue, cwd) : []
      return rewriteUnportableAliasSpecifiers(cwd, changes, newAbs)
    }
    finally { vue.dispose() }
  },
  autoImportScopes(cwd) {
    if (!isNuxtProject(cwd))
      return new Set()
    return nuxtAutoImportScopes(cwd)
  },
  isGeneratedPath: isGeneratedNuxtPath,
  inspectAutoImportConsumers: inspectNuxtAutoImportConsumers,
  validateAutoImportRename: validateNuxtAutoImportRename,
  filterGeneratedChanges: removeGeneratedNuxtChanges,
  addExplicitImports: ctx => addNuxtExplicitImports({ ...ctx, scan }),
  async finalizeFileRename(cwd, oldAbs, newAbs, existingChanges) {
    const scopes = isNuxtProject(cwd) ? nuxtAutoImportScopes(cwd) : new Set<string>()
    return finalizeVueFileRename(cwd, oldAbs, newAbs, existingChanges, scopes)
  },
  listComponents,
  findComponentUsages,
  doctor,
}

void parseComponent
void parseComponentSource
void findComponentUsage

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
  const scopes = new Set([...dirs].map(dir => resolve(cwd, stripGlob(dir))))
  const contexts = new Set([cwd, ...rgFiles('', { cwd, listAll: true }).map(path => nuxtConsumerContext(path, cwd))])
  for (const context of contexts) {
    for (const provider of loadNuxtProviderPaths(context))
      scopes.add(provider)
  }
  return scopes
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

const MODULE_EXT_RE = /\.(?:tsx?|jsx?|mts|cts|mjs|cjs|vue)$/
const ALIAS_PREFIX_RE = /^[~@#]/
const IMPORT_FROM_RE = /\b(?:import|export)\b[^;\n]+from\s*(['"`])([^'"`]+)\1/g
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g

/**
 * Volar's getFileRenameEdits preserves the original alias prefix when rewriting
 * consumer imports. In a multi-app Nuxt workspace each app re-roots `~/*` to its
 * own srcDir via its generated `.nuxt/tsconfig.json`, so an emitted `~/layers/...`
 * in a consumer under apps/site/ resolves to `apps/site/layers/...` at runtime,
 * not to the actual workspace `layers/...` directory. Detect this by reading
 * each consumer's nearest `.nuxt/tsconfig.json`; if the alias used in the emitted
 * specifier doesn't resolve to the rename target from there, rewrite to relative.
 */
function rewriteUnportableAliasSpecifiers(cwd: string, changes: FileChange[], newAbs: string): FileChange[] {
  for (const change of changes) {
    if (change.path === newAbs)
      continue
    const localAliases = loadConsumerLocalAliases(change.path, cwd)
    if (!localAliases.length)
      continue
    const before = change.before
    const after = change.after
    const beforeSpecs = collectSpecifiers(before)
    const afterSpecs = collectSpecifiers(after)
    const changedNew = new Set<string>()
    for (const spec of afterSpecs) {
      if (!beforeSpecs.has(spec) && ALIAS_PREFIX_RE.test(spec))
        changedNew.add(spec)
    }
    if (!changedNew.size)
      continue
    let rewritten = after
    for (const spec of changedNew) {
      if (aliasResolvesToTarget(localAliases, spec, newAbs))
        continue
      const replacement = toRelativeSpecifier(change.path, newAbs, spec)
      rewritten = replaceSpecifier(rewritten, spec, replacement)
    }
    change.after = rewritten
  }
  return changes
}

function collectSpecifiers(source: string): Set<string> {
  const out = new Set<string>()
  IMPORT_FROM_RE.lastIndex = 0
  for (const m of source.matchAll(IMPORT_FROM_RE))
    out.add(m[2])
  for (const m of source.matchAll(DYNAMIC_IMPORT_RE))
    out.add(m[2])
  return out
}

function replaceSpecifier(source: string, oldSpec: string, newSpec: string): string {
  const escaped = oldSpec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return source.replace(new RegExp(`(['"\`])${escaped}\\1`, 'g'), `$1${newSpec}$1`)
}

function toRelativeSpecifier(consumerFile: string, targetFile: string, oldSpec: string): string {
  const hasExt = MODULE_EXT_RE.test(oldSpec)
  let rel = relative(dirname(consumerFile), targetFile).replace(/\\/g, '/')
  if (!hasExt)
    rel = rel.replace(MODULE_EXT_RE, '')
  if (!rel.startsWith('.'))
    rel = `./${rel}`
  return rel
}
