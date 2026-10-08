import type { ProfileSink } from './profile.ts'
import type { VerifyMode } from './project.ts'
import type { LspTextEdit } from './ts-server.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'
import { loadAdapter } from './adapter.ts'
import { listTopLevelDeclarations, NAMED_DECLARATION_TYPES, parseSource } from './declarations.ts'
import { isInsideAutoImportScope } from './nuxt.ts'
import { timed, timedAsync } from './profile.ts'
import { findTsconfig, isVuePath, resolveVerifyMode, verifyScope } from './project.ts'
import { applyLspEdits, startTsServer } from './ts-server.ts'
import { applyTextEdits, mergeFileChanges, parseFile, parseSourceFile, rgFiles, spliceScript } from './util.ts'
import { findRegressions } from './verify.ts'
import { rewriteTemplateReferences } from './vue-template.ts'

export interface RenameOptions {
  cwd?: string
  /** Configured project used for renames and verification. */
  tsconfig?: string
  glob?: string | string[]
  verify?: boolean | VerifyMode
  scope?: string
  allowMultiple?: boolean
  vue?: boolean
  profile?: ProfileSink
}

export interface RenameResult {
  changes: FileChange[]
  scanned: number
  regressions: Regression[]
  warnings: string[]
}

interface Declaration {
  _tag: 'TopLevel' | 'Local'
  filePath: string
  source: string
  pos: number
}

export async function runRename(from: string, to: string, opts: RenameOptions = {}): Promise<RenameResult> {
  const cwd = opts.cwd ?? process.cwd()
  const profile = opts.profile
  const verifyMode = resolveVerifyMode(opts.verify)
  const vueEnabled = opts.vue ?? true
  const tsconfigPath = timed(profile, 'find tsconfig', () => opts.tsconfig ? resolve(cwd, opts.tsconfig) : findTsconfig(cwd))
  const candidatePaths = timed(profile, 'rg candidates', () => rgFiles(from, { cwd, glob: opts.glob }))
  const scriptCandidates = candidatePaths.filter(path => !isVue(path))

  const declarationPaths = opts.scope
    ? scriptCandidates.filter(path => path === resolve(cwd, opts.scope!))
    : scriptCandidates
  const declarations = timed(profile, 'find declarations', () => findDeclarations(declarationPaths, from, opts.allowMultiple))

  if (!declarations.length) {
    if (opts.scope)
      throw new Error(`ripast rename: no declaration of "${from}" in ${opts.scope}`)
    throw new Error(`ripast rename: no declaration of "${from}" found in project`)
  }

  const uniqueFiles = new Set(declarations.map(d => relative(cwd, d.filePath)))
  if (uniqueFiles.size > 1 && !opts.allowMultiple) {
    throw new Error(`ripast rename: "${from}" is declared in multiple files (${[...uniqueFiles].join(', ')}). Pass --scope <file> to pick one, or --all to rename every occurrence.`)
  }

  const server = await timedAsync(profile, 'server start', () => startTsServer(cwd, { tsconfig: tsconfigPath ?? undefined }))
  try {
    const editsByPath = new Map<string, Map<string, LspTextEdit>>()
    await timedAsync(profile, 'rename transform', async () => {
      for (const decl of declarations) {
        const edits = await server.rename(decl.filePath, decl.pos, to)
        for (const [path, fileEdits] of edits) {
          const unique = editsByPath.get(path) ?? new Map<string, LspTextEdit>()
          for (const edit of fileEdits) {
            const { start, end } = edit.range
            unique.set(`${start.line}:${start.character}:${end.line}:${end.character}:${edit.newText}`, edit)
          }
          editsByPath.set(path, unique)
        }
      }
    })

    const changes: FileChange[] = timed(profile, 'collect changes', () => {
      const out: FileChange[] = []
      for (const [path, edits] of editsByPath) {
        if (isVue(path))
          continue
        const before = readFileSync(path, 'utf8')
        const after = applyLspEdits(before, [...edits.values()])
        if (after !== before)
          out.push({ path, rel: relative(cwd, path), before, after })
      }
      return out
    })

    const vueAdapter = vueEnabled && tsconfigPath ? await loadAdapter('vue') : null
    if (vueAdapter && tsconfigPath && timed(profile, 'vue prefilter', () => vueAdapter.hasFilesContaining(cwd, from))) {
      const vueChanges = await timedAsync(profile, 'vue rename', () => vueAdapter.applyRename(tsconfigPath, cwd, from, to, declarations))
      for (const vc of vueChanges) {
        if (!changes.some(c => c.path === vc.path))
          changes.push(vc)
      }
    }

    if (vueAdapter?.autoImportScopes) {
      const scopes = timed(profile, 'auto-import scopes', () => vueAdapter.autoImportScopes!(cwd))
      if (declarations.some(decl => decl._tag === 'TopLevel' && isInsideAutoImportScope(decl.filePath, scopes))) {
        removeVueLocalBindingChanges(changes, from)
        const fallbackChanges = timed(profile, 'nuxt rename fallback', () => applyNuxtBareIdentifierRename(vueAdapter, cwd, from, to, changes))
        mergeFileChanges(changes, fallbackChanges)
        for (const decl of declarations) {
          if (decl._tag === 'TopLevel' && isInsideAutoImportScope(decl.filePath, scopes))
            vueAdapter.validateAutoImportRename?.({ cwd, symbol: from, fromAbs: decl.filePath, changes, scopes })
        }
      }
      if (scopes.size)
        vueAdapter.filterGeneratedChanges?.(cwd, changes)
    }

    const regressions: Regression[] = []
    if (verifyMode !== 'none') {
      const scriptChanges = changes.filter(c => !isVue(c.path))
      const verifyFiles = verifyScope(verifyMode, cwd, scriptCandidates, scriptChanges.map(c => c.path), opts.glob)
      regressions.push(...await timedAsync(profile, 'verify', () => findRegressions(server, scriptChanges, verifyFiles)))
    }

    if (vueAdapter && verifyMode !== 'none' && tsconfigPath && changes.some(c => isVue(c.path))) {
      const vueRegs = await vueAdapter.regressions(tsconfigPath, cwd, changes)
      regressions.push(...vueRegs)
    }

    const warnings = timed(profile, 'stale consumer scan', () => detectStaleConsumers(cwd, from, changes, opts.glob))

    return { changes, scanned: candidatePaths.length, regressions, warnings }
  }
  finally {
    server.dispose()
  }
}

const isVue = isVuePath

// After a rename, the server's file set is bounded by the project it discovers.
// A symbol re-exported through a package barrel and consumed from a file
// outside that set (sibling test dirs, other packages) keeps the old name and
// the server never sees it. Re-scan with rg and flag any file that still
// imports the old name but was not rewritten.
function detectStaleConsumers(cwd: string, from: string, changes: FileChange[], glob: string | string[] | undefined): string[] {
  const rewritten = new Set(changes.map(c => c.path))
  const stale: string[] = []
  for (const path of rgFiles(from, { cwd, glob })) {
    if (rewritten.has(path))
      continue
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    }
    catch {
      continue
    }
    const { program } = parseSourceFile(path, text, cwd)
    const importsName = program?.body.some((node: any) => {
      if (!node.source || (node.type !== 'ImportDeclaration' && node.type !== 'ExportNamedDeclaration'))
        return false
      return node.specifiers.some((specifier: any) => {
        const imported = specifier.type === 'ImportSpecifier' ? specifier.imported : specifier.local
        return (imported?.name ?? imported?.value) === from
      })
    })
    if (importsName)
      stale.push(relative(cwd, path))
  }
  if (!stale.length)
    return []
  const shown = stale.slice(0, 10)
  const more = stale.length > 10 ? ` (+${stale.length - 10} more)` : ''
  return [`"${from}" is still imported by ${stale.length} file(s) not rewritten (likely consumed via a package re-export, outside the TypeScript project): ${shown.join(', ')}${more}. Rename those imports manually or widen --glob.`]
}

function applyNuxtBareIdentifierRename(vueAdapter: { isGeneratedPath?: (cwd: string, path: string) => boolean }, cwd: string, from: string, to: string, changes: FileChange[]): FileChange[] {
  const byPath = new Map(changes.map(change => [change.path, change]))
  const out: FileChange[] = []
  for (const path of rgFiles(from, { cwd })) {
    if (vueAdapter.isGeneratedPath?.(cwd, path))
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
    if (isVue(change.path) && scriptDeclaresBinding(change.before, from, false))
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
      if (NAMED_DECLARATION_TYPES.has(node.type) && node.id?.name === name) {
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
        if (NAMED_DECLARATION_TYPES.has(parent.type) && parent.id === node)
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

/** Prefer top-level declarations; fall back to local declarations. */
function findDeclarations(paths: string[], name: string, allowMultiple = false): Declaration[] {
  const out: Declaration[] = []
  const locals: Declaration[] = []
  for (const path of paths) {
    const source = readFileSync(path, 'utf8')
    const { program } = parseSource(path, source)
    for (const decl of listTopLevelDeclarations(program)) {
      if (decl.name === name)
        out.push({ _tag: 'TopLevel', filePath: path, source, pos: decl.nameStart })
    }
    walk(program, {
      enter(node: any) {
        if ((node.type === 'VariableDeclarator' || NAMED_DECLARATION_TYPES.has(node.type)) && node.id?.name === name)
          locals.push({ _tag: 'Local', filePath: path, source, pos: node.id.start })
      },
    })
  }
  // Keep top-level renames from changing unrelated local shadows.
  if (out.length)
    return out
  if (!allowMultiple && locals.length > new Set(locals.map(d => d.filePath)).size)
    throw new Error(`ripast rename: "${name}" has multiple declarations in one file. Pass --all to rename every occurrence.`)
  return locals
}
