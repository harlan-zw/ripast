import type { Extension } from 'ripide-api'
import type { FileChange, FrameworkAdapter, scan } from 'ripide-api/adapter'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import ts from '@typescript/typescript6'
import { createEngine } from 'ripide-api'
import {
  applyVueFileRenameEdits,
  applyVueImportRewrite,
  applyVueRename,
  hasVueFilesContaining,
  vueRegressions,
} from './bridge.ts'
import { parseComponent, parseComponentSource } from './component-parse.ts'
import { findComponentUsage, findComponentUsages } from './component-usages.ts'
import { listComponents } from './components.ts'
import { rewriteVueCssClassTokens, visitVueCssClassTokens } from './css-class-source.ts'
import { doctor } from './doctor.ts'
import { finalizeVueFileRename } from './finalize-rename.ts'
import { loadNuxtProviderPaths, nuxtConsumerContext } from './nuxt-bindings.ts'
import { configProperty, literalNuxtConfig, literalString } from './nuxt-config.ts'
import { inspectNuxtAutoImportConsumers, validateNuxtAutoImportRename } from './nuxt-delete.ts'
import { addNuxtExplicitImports } from './nuxt-imports.ts'
import { aliasResolvesToTarget, isGeneratedNuxtPath, loadConsumerLocalAliases, loadNuxtPathAliases, removeGeneratedNuxtChanges } from './nuxt-paths.ts'
import { planNuxtAutoImportRename } from './nuxt-rename.ts'
import { findVueFiles, inspectAuthoredSource, parseAuthoredSource } from './source.ts'
import { extractTemplateExpressions } from './vue-template.ts'

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
  async applyFileRenameEdits(tsconfigPath, cwd, oldAbs, newAbs) {
    const changes = await applyVueFileRenameEdits(tsconfigPath, cwd, oldAbs, newAbs)
    return rewriteUnportableAliasSpecifiers(cwd, changes, newAbs)
  },
  autoImportScopes(cwd) {
    if (!isNuxtProject(cwd))
      return new Set()
    return nuxtAutoImportScopes(cwd)
  },
  isGeneratedPath: isGeneratedNuxtPath,
  inspectAutoImportConsumers: inspectNuxtAutoImportConsumers,
  validateAutoImportRename: validateNuxtAutoImportRename,
  planAutoImportRename: planNuxtAutoImportRename,
  filterGeneratedChanges: removeGeneratedNuxtChanges,
  isPlannedImportTarget(cwd, consumer, specifier, target) {
    if (!isNuxtProject(cwd))
      return false
    const aliases = loadNuxtPathAliases(nuxtConsumerContext(consumer, cwd))
    const consistent = aliases.filter(alias => aliases.every(other => other.pattern !== alias.pattern || JSON.stringify(other.targets) === JSON.stringify(alias.targets)))
    return aliasResolvesToTarget(consistent, specifier, target)
  },
  addExplicitImports: ctx => addNuxtExplicitImports({ ...ctx, scan: scanWithVue }),
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

export function createVueExtension(): Extension {
  return {
    css: { visit: visitVueCssClassTokens, rewrite: rewriteVueCssClassTokens },
    configPaths: ['.nuxt/tsconfig.json', '.nuxt/tsconfig.app.json', '.nuxt/tsconfig.server.json', '.nuxt/tsconfig.shared.json', '.nuxt/tsconfig.node.json'],
    name: 'vue',
    suffixes: ['.vue'],
    parse: parseAuthoredSource,
    inspect: inspectAuthoredSource,
    expressions: extractTemplateExpressions,
    semantic: { ...adapter },
    operations: ['rename', 'move', 'delete', 'renameFile', 'replace'],
    supports(request, cwd) {
      return request.operation !== 'replace' || !scanWithVue(request.from, { cwd, glob: '*.vue' }).length
    },
  }
}

function scanWithVue(pattern: string, opts: Parameters<typeof scan>[1] = {}) {
  return createEngine({ extensions: [createVueExtension()] }).scan(pattern, opts)
}

export { isInsideAutoImportScope } from './nuxt.ts'
export { runVueTemplateUnwrap, runVueTemplateWrap } from './vue-template-wrap.ts'
export type { VueTemplateWrapOptions, VueTemplateWrapResult } from './vue-template-wrap.ts'
export { extractTemplateExpressions, hyphenateVueName, parseVueTemplateAst, rewriteTemplateReferences } from './vue-template.ts'
export default createVueExtension

const DEFAULT_NUXT_AUTO_IMPORT_DIRS = [
  'composables',
  'utils',
  'app/composables',
  'app/utils',
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
  const scopes = new Set<string>()
  const contexts = new Set([cwd, ...findVueFiles('', { cwd, listAll: true }).map(path => nuxtConsumerContext(path, cwd))])
  for (const context of contexts) {
    const configPath = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.mts']
      .map(name => join(context, name))
      .find(existsSync)
    const config = configPath ? literalNuxtConfig(readFileSync(configPath, 'utf8')) : undefined
    const sourceRoot = resolve(context, literalString(configProperty(config, 'srcDir')) || defaultNuxtSourceDir(context, config))
    for (const dir of DEFAULT_NUXT_AUTO_IMPORT_DIRS)
      scopes.add(resolve(context, dir))
    for (const dir of ['utils', 'composables', 'components', 'middleware'])
      scopes.add(resolve(sourceRoot, dir))
    const sharedRoot = resolve(context, literalString(configProperty(configProperty(config, 'dir'), 'shared')) ?? 'shared')
    for (const dir of ['utils', 'types']) scopes.add(resolve(sharedRoot, dir))
    for (const dir of configuredNuxtDirs(config)) scopes.add(resolve(sourceRoot, stripGlob(dir)))
    for (const provider of loadNuxtProviderPaths(context))
      scopes.add(provider)
  }
  return scopes
}

function defaultNuxtSourceDir(context: string, config: ts.Expression | undefined): string {
  const app = join(context, 'app')
  if (!existsSync(app))
    return '.'
  const entries = readdirSync(app).filter(name => name !== 'spa-loading-template.html' && !name.startsWith('router.options'))
  if (entries.length)
    return 'app'
  if (['app.vue', 'App.vue'].some(name => existsSync(join(context, name))))
    return '.'
  const directories = ['assets', 'layouts', 'middleware', 'pages', 'plugins']
    .map(name => literalString(configProperty(configProperty(config, 'dir'), name)) ?? name)
  return directories.some(directory => existsSync(resolve(context, directory))) ? '.' : 'app'
}

function configuredNuxtDirs(config: ts.Expression | undefined): string[] {
  const dirs: string[] = []
  for (const array of [configProperty(configProperty(config, 'imports'), 'dirs'), configProperty(config, 'components')]) {
    if (!array || !ts.isArrayLiteralExpression(array))
      continue
    for (const element of array.elements) {
      const dir = literalString(element) ?? literalString(configProperty(element, 'path'))
      if (dir)
        dirs.push(dir)
    }
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
