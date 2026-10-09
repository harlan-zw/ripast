import type { FileChange } from '@ripast/core/adapter'
import { readFileSync } from 'node:fs'
import { basename, relative } from 'node:path'
import { scan } from '@ripast/core/adapter'
import { addNuxtExplicitImports, extractTopLevelExportNames } from './nuxt-imports.ts'
import { isGeneratedNuxtPath, loadNuxtPathAliases, resolveBestImportSpecifier } from './nuxt-paths.ts'
import { isInsideAutoImportScope } from './nuxt.ts'
import { rgVueFiles } from './source.ts'
import { hyphenateVueName, rewriteTemplateReferences } from './vue-template.ts'

const TS_LIKE_RE = /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/

export async function finalizeVueFileRename(
  cwd: string,
  oldAbs: string,
  newAbs: string,
  existingChanges: FileChange[],
  autoImportScopes: Set<string>,
): Promise<{ changes: FileChange[], warnings: string[] }> {
  const changes: FileChange[] = applyComponentTemplateRenameFallback(cwd, oldAbs, newAbs, existingChanges)
  const warnings: string[] = []

  if (oldAbs.endsWith('.vue') && newAbs.endsWith('.vue')) {
    const oldName = basename(oldAbs, '.vue')
    const newName = basename(newAbs, '.vue')

    const resolveCompEdits = rewriteResolveComponentSites(cwd, oldName, newName, existingChanges, oldAbs, newAbs, warnings)
    mergeIntoChanges(changes, resolveCompEdits)

    if (oldName !== newName) {
      const isEdits = rewriteIsAttributeSites(cwd, oldName, newName, mergeView(existingChanges, changes), oldAbs, newAbs, warnings)
      mergeIntoChanges(changes, isEdits)
    }

    if (autoImportScopes.size && isInsideAutoImportScope(oldAbs, autoImportScopes) && !isInsideAutoImportScope(newAbs, autoImportScopes)) {
      const merged = mergeView(existingChanges, changes)
      const explicit = addExplicitComponentImports(cwd, oldName, newName, newAbs, merged, oldAbs)
      mergeIntoChanges(changes, explicit)
    }
    return { changes, warnings }
  }

  if (
    TS_LIKE_RE.test(oldAbs)
    && TS_LIKE_RE.test(newAbs)
    && autoImportScopes.size
    && isInsideAutoImportScope(oldAbs, autoImportScopes)
    && !isInsideAutoImportScope(newAbs, autoImportScopes)
  ) {
    const movedSource = readMovedSource(oldAbs, newAbs, existingChanges)
    const symbols = movedSource ? extractTopLevelExportNames(movedSource) : []
    if (symbols.length) {
      const explicit = addNuxtExplicitImports({
        cwd,
        symbols,
        toAbs: newAbs,
        fromAbs: oldAbs,
        existingChanges: mergeView(existingChanges, changes),
        scan,
        noScriptError: name => new Error(
          `ripast rename-file: "${name}" is auto-imported in Nuxt; moving ${basename(oldAbs)} to ${newAbs}`
          + ` takes it out of auto-import scope but a consumer has no <script> block to receive an explicit import.`
          + ` Add a <script setup> block first, or keep the file in composables/utils.`,
        ),
      })
      mergeIntoChanges(changes, explicit)
    }
  }

  return { changes, warnings }
}

function readMovedSource(oldAbs: string, newAbs: string, existingChanges: FileChange[]): string | null {
  const self = existingChanges.find(c => c.path === oldAbs || c.path === newAbs)
  if (self)
    return self.before
  try {
    return readFileSync(oldAbs, 'utf8')
  }
  catch {
    return null
  }
}

function mergeView(a: FileChange[], b: FileChange[]): FileChange[] {
  const map = new Map<string, FileChange>()
  for (const c of a) map.set(c.path, c)
  for (const c of b) map.set(c.path, c)
  return [...map.values()]
}

function mergeIntoChanges(target: FileChange[], incoming: FileChange[]): void {
  for (const change of incoming) {
    const existing = target.find(c => c.path === change.path)
    if (existing)
      existing.after = change.after
    else
      target.push(change)
  }
}

function rewriteResolveComponentSites(
  cwd: string,
  oldName: string,
  newName: string,
  changes: FileChange[],
  oldAbs: string,
  newAbs: string,
  warnings: string[],
): FileChange[] {
  const candidates = new Set(rgVueFiles('resolveComponent', { cwd }))
  if (!candidates.size)
    return []
  const byPath = new Map(changes.map(change => [change.path, change]))
  const escaped = escapeRe(oldName)
  const literalRe = new RegExp(`resolveComponent\\s*\\(\\s*(['"\`])${escaped}\\1`, 'g')
  const out: FileChange[] = []
  const warnFiles: string[] = []
  for (const path of candidates) {
    if (path === oldAbs || path === newAbs || isGeneratedNuxtPath(cwd, path))
      continue
    const before = byPath.get(path)?.before ?? readFileSync(path, 'utf8')
    const current = byPath.get(path)?.after ?? before
    literalRe.lastIndex = 0
    if (!literalRe.test(current))
      continue
    warnFiles.push(relative(cwd, path))
    if (oldName === newName)
      continue
    literalRe.lastIndex = 0
    const after = current.replace(literalRe, (match, quote) => match.replace(`${quote}${oldName}${quote}`, `${quote}${newName}${quote}`))
    if (after === current)
      continue
    out.push({ path, rel: relative(cwd, path), before, after })
  }
  if (warnFiles.length) {
    warnings.push(
      `rename-file: "${oldName}" is referenced via resolveComponent() in ${warnFiles.length} file(s) `
      + `[${warnFiles.join(', ')}]. The component must stay globally registered for these sites to resolve `
      + `(plugin app.component(...) or Nuxt components dir).`,
    )
  }
  return out
}

function addExplicitComponentImports(
  cwd: string,
  oldName: string,
  newName: string,
  newAbs: string,
  changes: FileChange[],
  oldAbs: string,
): FileChange[] {
  const tokens = new Set([oldName, newName, hyphenateVueName(oldName), hyphenateVueName(newName)])
  const candidates = new Set<string>()
  for (const token of tokens) {
    for (const path of rgVueFiles(token, { cwd, glob: '*.vue' }))
      candidates.add(path)
  }
  if (!candidates.size)
    return []
  const aliases = loadNuxtPathAliases(cwd)
  const byPath = new Map(changes.map(change => [change.path, change]))
  const tagRe = new RegExp(`<\\/?(?:${escapeRe(newName)}|${escapeRe(hyphenateVueName(newName))})(?=[\\s/>])`)
  const out: FileChange[] = []
  for (const path of candidates) {
    if (path === oldAbs || path === newAbs || isGeneratedNuxtPath(cwd, path))
      continue
    const before = byPath.get(path)?.before ?? readFileSync(path, 'utf8')
    const current = byPath.get(path)?.after ?? before
    if (!tagRe.test(current))
      continue
    if (hasDefaultImportFromVue(current, newName))
      continue
    const specifier = resolveBestImportSpecifier(path, newAbs, aliases, './placeholder.vue')
    const after = insertVueComponentImport(current, newName, specifier)
    if (after === current)
      continue
    out.push({ path, rel: relative(cwd, path), before, after })
  }
  return out
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rewriteIsAttributeSites(
  cwd: string,
  oldName: string,
  newName: string,
  changes: FileChange[],
  oldAbs: string,
  newAbs: string,
  warnings: string[],
): FileChange[] {
  const oldKebab = hyphenateVueName(oldName)
  const newKebab = hyphenateVueName(newName)
  const candidates = new Set([
    ...rgVueFiles(oldName, { cwd, glob: '*.vue' }),
    ...rgVueFiles(oldKebab, { cwd, glob: '*.vue' }),
  ])
  if (!candidates.size)
    return []
  const byPath = new Map(changes.map(change => [change.path, change]))
  const oldRe = `${escapeRe(oldName)}|${escapeRe(oldKebab)}`
  // :is="'Name'" string-literal binding. Handles both nested-quote shapes.
  const isStringLiteralRe = new RegExp(
    `(:is\\s*=\\s*)(?:"\\s*'(${oldRe})'\\s*"|'\\s*"(${oldRe})"\\s*')`,
    'g',
  )
  // is="Name" static attribute (resolves like a tag).
  const isStaticRe = new RegExp(`(\\bis\\s*=\\s*)(['"])(${oldRe})\\2`, 'g')
  const dynamicBindingRe = /:is\s*=\s*"\s*([A-Za-z_$][\w$]*)\s*"/g
  const out: FileChange[] = []
  const dynamicBindingWarn: string[] = []
  const mapToken = (token: string): string => token === oldName ? newName : newKebab
  for (const path of candidates) {
    if (path === oldAbs || path === newAbs || isGeneratedNuxtPath(cwd, path))
      continue
    const before = byPath.get(path)?.before ?? readFileSync(path, 'utf8')
    let current = byPath.get(path)?.after ?? before
    current = current.replace(isStringLiteralRe, (_m, prefix, p1, p2) => {
      const matched = p1 ?? p2
      return `${prefix}"'${mapToken(matched)}'"`
    })
    current = current.replace(isStaticRe, (_m, prefix, quote, name) => `${prefix}${quote}${mapToken(name)}${quote}`)
    for (const m of current.matchAll(dynamicBindingRe)) {
      if (m[1] === oldName) {
        dynamicBindingWarn.push(relative(cwd, path))
        break
      }
    }
    if (current === before)
      continue
    out.push({ path, rel: relative(cwd, path), before, after: current })
  }
  if (dynamicBindingWarn.length) {
    warnings.push(
      `rename-file: "${oldName}" may be referenced via dynamic <component :is="ref"> in `
      + `${dynamicBindingWarn.length} file(s) [${dynamicBindingWarn.join(', ')}]. These cannot be `
      + `auto-rewritten; inspect and update manually.`,
    )
  }
  return out
}

function hasDefaultImportFromVue(source: string, name: string): boolean {
  const re = new RegExp(`\\bimport\\s+${escapeRe(name)}\\s+from\\s+['"\`][^'"\`]+\\.vue['"\`]`)
  return re.test(source)
}

function insertVueComponentImport(source: string, name: string, specifier: string): string {
  const match = source.match(/<script(?:\s[^>]*)?>/)
  if (!match || match.index === undefined) {
    throw new Error(
      `ripast rename-file: "${name}" is auto-imported in Nuxt; the new path falls outside auto-import scope `
      + `but a consumer has no <script> block to receive an explicit import. Add a <script setup> block first.`,
    )
  }
  const insertAt = match.index + match[0].length
  const importLine = `\nimport ${name} from '${specifier}'`
  if (source.slice(insertAt, insertAt + 1) === '\n')
    return `${source.slice(0, insertAt)}${importLine}${source.slice(insertAt)}`
  return `${source.slice(0, insertAt)}${importLine}\n${source.slice(insertAt)}`
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
    ...rgVueFiles(oldName, { cwd, glob: '*.vue' }),
    ...rgVueFiles(hyphenateVueName(oldName), { cwd, glob: '*.vue' }),
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
