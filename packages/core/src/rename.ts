import type { EngineServices } from './engine.ts'
import type { ProfileSink } from './profile.ts'
import type { VerifyMode } from './project.ts'
import type { LspTextEdit, TsServer } from './ts-server.ts'
import type { FileChange } from './util.ts'
import type { Verification } from './verification.ts'
import type { Regression } from './verify.ts'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { isOnlyBindingIdentifier, isReferenceIdentifier, ScopeTracker, walk } from 'oxc-walker'
import { listTopLevelDeclarations, NAMED_DECLARATION_TYPES, parseSource, unrelatedVariableIdentifierOffsets } from './declarations.ts'
import { timed, timedAsync } from './profile.ts'
import { assertSourceSupport, findTsconfig, isExtensionPath, isInsideAutoImportScope, resolveVerificationOptions, verifyScope } from './project.ts'
import { recoverPropertyReferences } from './rename-property-references.ts'
import { applyLspEdits, offsetOfPosition, startTsServer } from './ts-server.ts'
import { applyTextEdits, findFiles, findFilesMany, parseSourceFile, posToLineCol } from './util.ts'
import { createVerification } from './verification.ts'
import { findExtensionRegressions, findRegressions } from './verify.ts'

export interface RenameOptions {
  engine?: EngineServices
  cwd?: string
  /** Configured project used for renames and verification. */
  tsconfig?: string
  glob?: string | string[]
  verifyMode?: VerifyMode
  scope?: string
  allowMultiple?: boolean
  profile?: ProfileSink
}

export interface RenameResult {
  changes: FileChange[]
  scanned: number
  regressions: Regression[]
  verification: Verification
  warnings: string[]
}

interface Declaration {
  _tag: 'TopLevel' | 'Local'
  filePath: string
  source: string
  pos: number
}

export async function runRename(from: string, to: string, opts: RenameOptions = {}): Promise<RenameResult> {
  return (await planNativeRename(from, to, opts)).result
}

/** Internal verification context stays separate from the public mutation result. */
export async function planNativeRename(from: string, to: string, opts: RenameOptions = {}): Promise<{ result: RenameResult, verificationChanges: (changes: FileChange[]) => FileChange[] }> {
  const verifyMode = resolveVerificationOptions(opts)
  const cwd = opts.cwd ?? process.cwd()
  const engine = opts.engine
  assertSourceSupport(cwd, engine)
  engine?.assertOperation({ operation: 'rename', from, to }, cwd)
  const profile = opts.profile
  const tsconfigPath = timed(profile, 'find tsconfig', () => opts.tsconfig ? resolve(cwd, opts.tsconfig) : findTsconfig(cwd))
  const candidatePaths = timed(profile, 'candidate files', () => findFilesMany([from, '\\u'], { cwd, engine, glob: opts.glob }))
  const scriptCandidates = candidatePaths.filter(path => !isExtensionFile(path, engine))

  const declarationPaths = opts.scope
    ? scriptCandidates.filter(path => path === resolve(cwd, opts.scope!))
    : scriptCandidates
  const declarations = timed(profile, 'find declarations', () => findDeclarations(declarationPaths, from, opts.allowMultiple))

  if (!declarations.length) {
    if (opts.scope)
      throw new Error(`ripide rename: no declaration of "${from}" in ${opts.scope}`)
    throw new Error(`ripide rename: no declaration of "${from}" found in project`)
  }

  const uniqueFiles = new Set(declarations.map(d => relative(cwd, d.filePath)))
  if (uniqueFiles.size > 1 && !opts.allowMultiple) {
    throw new Error(`ripide rename: "${from}" is declared in multiple files (${[...uniqueFiles].join(', ')}). Pass --scope <file> to pick one, or --all to rename every occurrence.`)
  }

  if (from !== to) {
    for (const path of scriptCandidates) {
      const source = readFileSync(path, 'utf8')
      if (!source.includes('\\u'))
        continue
      const program = parseSource(path, source).program
      const selectedPositions = new Set(declarations.filter(declaration => declaration.filePath === path).map(declaration => declaration.pos))
      const unrelated = unrelatedVariableIdentifierOffsets(program, from, selectedPositions)
      walk(program, {
        enter(node: any) {
          if (node.type !== 'Identifier' || node.name !== from || !source.slice(node.start, node.end).includes('\\u'))
            return
          if (!selectedPositions.has(node.start) && !unrelated.has(node.start))
            throw new Error(`ripide rename: TypeScript cannot resolve escaped references to "${from}" in ${relative(cwd, path)}`)
        },
      })
    }
  }

  const adapter = engine?.adapter ?? null
  const scopes = adapter?.autoImportScopes?.(cwd) ?? new Set<string>()
  const autoImportSites = declarations.filter(decl => decl._tag === 'TopLevel' && isInsideAutoImportScope(decl.filePath, scopes))
  const autoImportPlan = autoImportSites.length
    ? timed(profile, 'implicit rename plan', () => adapter?.planAutoImportRename?.({ cwd, from, to, sites: autoImportSites }))
    : undefined

  const server = await timedAsync(profile, 'server start', () => startTsServer(cwd, { tsconfig: tsconfigPath ?? undefined }))
  try {
    for (const path of scriptCandidates) server.open(path, readFileSync(path, 'utf8'))
    const editsByPath = new Map<string, Map<string, LspTextEdit>>()
    await timedAsync(profile, 'rename transform', async () => {
      for (const decl of declarations) {
        const edits = await server.rename(decl.filePath, decl.pos, to)
        if (!edits.size && from !== to)
          throw new Error(`ripide rename: TypeScript could not rename declaration "${from}" in ${relative(cwd, decl.filePath)}`)
        for (const [path, fileEdits] of edits) {
          const unique = editsByPath.get(path) ?? new Map<string, LspTextEdit>()
          for (const edit of fileEdits) {
            const { start, end } = edit.range
            unique.set(`${start.line}:${start.character}:${end.line}:${end.character}:${edit.newText}`, edit)
          }
          editsByPath.set(path, unique)
        }
      }
      await recoverPropertyReferences(server, scriptCandidates, declarations, from, to, editsByPath)
    })

    const changes: FileChange[] = await timedAsync(profile, 'collect changes', async () => {
      const out: FileChange[] = []
      for (const path of new Set([...editsByPath.keys(), ...scriptCandidates])) {
        if (isExtensionFile(path, engine))
          continue
        const before = readFileSync(path, 'utf8')
        const fileEdits = await preserveConsumerBindings(server, path, before, [...(editsByPath.get(path)?.values() ?? [])], from, to, declarations, editsByPath)
        const after = autoImportPlan
          ? applyTextEdits(before, autoImportPlan.transformEdits(path, before, fileEdits.map(edit => ({
              start: offsetOfPosition(before, edit.range.start),
              end: offsetOfPosition(before, edit.range.end),
              replacement: edit.newText,
            }))))
          : applyLspEdits(before, fileEdits)
        if (after !== before)
          out.push({ path, rel: relative(cwd, path), before, after })
      }
      return out
    })

    if (adapter && tsconfigPath && timed(profile, 'extension prefilter', () => adapter.hasFilesContaining(cwd, from))) {
      const extensionChanges = await timedAsync(profile, 'extension rename', () => adapter.applyRename(tsconfigPath, cwd, from, to, declarations, autoImportPlan))
      for (const vc of extensionChanges) {
        if (!changes.some(c => c.path === vc.path))
          changes.push(vc)
      }
    }

    if (adapter?.autoImportScopes) {
      if (autoImportSites.length) {
        for (const change of autoImportPlan?.changes ?? []) {
          if (!changes.some(existing => existing.path === change.path))
            changes.push(change)
        }
        for (const decl of autoImportSites)
          adapter.validateAutoImportRename?.({ cwd, symbol: from, to, fromAbs: decl.filePath, changes, scopes })
      }
      if (scopes.size)
        adapter.filterGeneratedChanges?.(cwd, changes)
    }

    const verification = createVerification(verifyMode, !!changes.length)
    const regressions: Regression[] = []
    const projectVerificationChanges = (finalChanges: FileChange[]): FileChange[] => autoImportPlan?.verificationChanges(finalChanges) ?? []
    const verificationChanges = [...changes, ...projectVerificationChanges(changes)]
    if (verifyMode !== 'none' && changes.length) {
      const scriptChanges = verificationChanges.filter(c => !isExtensionFile(c.path, engine))
      const verifyFiles = verifyScope(verifyMode, cwd, scriptCandidates, scriptChanges.map(c => c.path), engine)
      regressions.push(...await timedAsync(profile, 'verify', () => findRegressions(server, scriptChanges, verifyFiles, verification.typescript)))
    }

    if (verifyMode === 'project') {
      regressions.push(...await timedAsync(profile, 'extension verify', () => findExtensionRegressions(cwd, verificationChanges, tsconfigPath, engine, verification.extension)))
    }
    else if (adapter && verifyMode !== 'none' && tsconfigPath && changes.some(c => isExtensionFile(c.path, engine))) {
      const extensionRegressions = await timedAsync(profile, 'extension verify', () => adapter.regressions(tsconfigPath, cwd, verificationChanges, verification.extension(adapter.name)))
      regressions.push(...extensionRegressions)
    }

    const warnings = timed(profile, 'stale consumer scan', () => detectStaleConsumers(cwd, from, changes, opts.glob, autoImportPlan?.unrelatedGeneratedImports, engine))

    return { result: { changes, scanned: candidatePaths.length, regressions, verification: verification.result(), warnings }, verificationChanges: projectVerificationChanges }
  }
  finally {
    server.dispose()
  }
}

const isExtensionFile = (path: string, engine?: EngineServices) => isExtensionPath(path, engine)

// A shorthand binding has two names: the source property and its local value.
// Preserve the local name when the renamed declaration belongs to the source.
async function preserveConsumerBindings(server: TsServer, path: string, source: string, edits: LspTextEdit[], from: string, to: string, declarations: Declaration[], editsByPath: Map<string, Map<string, LspTextEdit>>): Promise<LspTextEdit[]> {
  if (from === to)
    return edits
  const selectedPositions = new Set(declarations.filter(declaration => declaration.filePath === path).map(declaration => declaration.pos))
  const selectedSites = new Set(declarations.map(declaration => `${declaration.filePath}:${declaration.pos}`))
  const shorthandOffsets = new Set<number>()
  const externalReferenceOffsets = new Set<number>()
  const { program, comments } = parseSource(path, source)
  walk(program, {
    enter(node: any) {
      if (node.type === 'ExportNamedDeclaration' && node.source) {
        for (const specifier of node.specifiers ?? []) {
          if (specifier.local)
            externalReferenceOffsets.add(specifier.local.start)
        }
      }
      if (node.type === 'TSImportType' && node.qualifier) {
        walk(node.qualifier, {
          enter(qualifier: any) {
            if (qualifier.type === 'Identifier')
              externalReferenceOffsets.add(qualifier.start)
          },
        })
      }
      if (node.type !== 'ObjectPattern')
        return
      for (const property of node.properties ?? []) {
        if (property.shorthand && property.key?.type === 'Identifier' && property.key.name === from && !selectedPositions.has(property.key.start))
          shorthandOffsets.add(property.key.start)
      }
    },
  })
  if (!shorthandOffsets.size)
    return edits
  const definitionMatches = new Map<string, boolean>()
  const aliasOffsetsByPath = new Map<string, Set<number>>()
  function aliasOffsets(sitePath: string): Set<number> {
    const cached = aliasOffsetsByPath.get(sitePath)
    if (cached)
      return cached
    const offsets = new Set<number>()
    const sourceText = server.textOf(sitePath)
    const changed = new Set([...(editsByPath.get(sitePath)?.values() ?? [])]
      .filter(edit => edit.newText === to)
      .map(edit => offsetOfPosition(sourceText, edit.range.start)))
    if (changed.size) {
      walk(parseSource(sitePath, sourceText).program, {
        enter(node: any, parent: any) {
          if (node.type !== 'Identifier')
            return
          if (parent?.type === 'ExportSpecifier' && changed.has(parent.exported.start))
            offsets.add(node.start)
          if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(parent?.type) && changed.has(parent.local.start))
            offsets.add(node.start)
        },
      })
    }
    aliasOffsetsByPath.set(sitePath, offsets)
    return offsets
  }
  async function matchesSelectedDeclaration(sitePath: string, start: number, ancestors = new Set<string>()): Promise<boolean> {
    const key = `${sitePath}:${start}`
    if (selectedSites.has(key))
      return true
    if (ancestors.has(key))
      return false
    const cached = definitionMatches.get(key)
    if (cached !== undefined)
      return cached
    const definitions = await server.definition(sitePath, start)
    const nextAncestors = new Set([...ancestors, key])
    let matches = definitions.length > 0
    for (const definition of definitions) {
      const target = `${definition.path}:${definition.start}`
      if (selectedSites.has(target))
        continue
      if (!aliasOffsets(definition.path).has(definition.start) || !await matchesSelectedDeclaration(definition.path, definition.start, nextAncestors)) {
        matches = false
        break
      }
    }
    definitionMatches.set(key, matches)
    return matches
  }
  const renamedPropertyOffsets = new Set<number>()
  for (const start of shorthandOffsets) {
    if (await matchesSelectedDeclaration(path, start))
      renamedPropertyOffsets.add(start)
  }
  if (!renamedPropertyOffsets.size)
    return edits
  const tracker = new ScopeTracker({ preserveExitedScopes: true })
  walk(program, { scopeTracker: tracker })
  tracker.freeze()
  // Multiple var declarations share one binding. The tracker keeps its last
  // declaration, so resolve shorthand sites before preserving that binding.
  const consumerDeclarationOffsets = new Set<number>()
  walk(program, {
    scopeTracker: tracker,
    enter(node: any) {
      if (node.type !== 'Identifier' || !renamedPropertyOffsets.has(node.start))
        return
      const declaration = tracker.getDeclaration(from)
      if (declaration)
        consumerDeclarationOffsets.add(declaration.node.start)
    },
  })
  const localOffsets = new Set<number>()
  const typeQueryOffsets = new Set<number>()
  walk(program, {
    scopeTracker: tracker,
    enter(node: any, parent: any) {
      if (node.type === 'TSTypeQuery') {
        let root = node.exprName
        while (root?.type === 'TSQualifiedName') root = root.left
        if (root?.type === 'Identifier')
          typeQueryOffsets.add(root.start)
      }
      if (node.name !== from || externalReferenceOffsets.has(node.start))
        return
      const jsxReference = node.type === 'JSXIdentifier' && (
        parent?.type === 'JSXMemberExpression'
          ? parent.object === node
          : (parent?.type === 'JSXOpeningElement' || parent?.type === 'JSXClosingElement')
            && parent.name === node && !/^[a-z]/.test(node.name)
      )
      const identifierReference = node.type === 'Identifier'
        && (isOnlyBindingIdentifier(node, parent) || isReferenceIdentifier(node, parent, { mode: 'value' }) || typeQueryOffsets.has(node.start))
      if (!jsxReference && !identifierReference)
        return
      const declaration = tracker.getDeclaration(from)
      if (declaration && consumerDeclarationOffsets.has(declaration.node.start))
        localOffsets.add(node.start)
    },
  })
  // The script AST excludes JSDoc. Resolve comment edits with the language
  // server so local types keep their binding and module qualifiers still change.
  for (const edit of edits) {
    const start = offsetOfPosition(source, edit.range.start)
    const end = offsetOfPosition(source, edit.range.end)
    if (edit.newText !== to || source.slice(start, end) !== from || !comments.some(comment => comment.start <= start && end <= comment.end))
      continue
    const definitions = await server.definition(path, start)
    if (definitions.length && definitions.every(site => site.path === path && (renamedPropertyOffsets.has(site.start) || localOffsets.has(site.start))))
      localOffsets.add(start)
  }
  const preservedEdits = edits.flatMap((edit) => {
    const start = offsetOfPosition(source, edit.range.start)
    const end = offsetOfPosition(source, edit.range.end)
    if (source.slice(start, end) !== from || edit.newText !== to)
      return [edit]
    if (renamedPropertyOffsets.has(start))
      return [{ ...edit, newText: `${to}: ${source.slice(start, end)}` }]
    return localOffsets.has(start) ? [] : [edit]
  })
  const editedPositions = new Set(edits.map(edit => offsetOfPosition(source, edit.range.start)))
  for (const start of renamedPropertyOffsets) {
    if (editedPositions.has(start) || source.slice(start, start + from.length) !== from)
      continue
    const first = posToLineCol(source, start)
    const last = posToLineCol(source, start + from.length)
    preservedEdits.push({
      range: {
        start: { line: first.line - 1, character: first.col - 1 },
        end: { line: last.line - 1, character: last.col - 1 },
      },
      newText: `${to}: ${from}`,
    })
  }
  return preservedEdits
}

// After a rename, the server's file set is bounded by the project it discovers.
// A symbol re-exported through a package barrel and consumed from a file
// outside that set (sibling test dirs, other packages) keeps the old name and
// the server never sees it. Search candidate files again and flag any file that still
// imports the old name but was not rewritten.
function detectStaleConsumers(cwd: string, from: string, changes: FileChange[], glob: string | string[] | undefined, unrelatedGeneratedImports?: Set<string>, engine?: EngineServices): string[] {
  const rewritten = new Set(changes.map(c => c.path))
  const stale: string[] = []
  for (const path of findFiles(from, { cwd, glob, engine })) {
    if (rewritten.has(path))
      continue
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    }
    catch {
      continue
    }
    const { program } = parseSourceFile(path, text, cwd, engine)
    const importsName = program?.body.some((node: any) => {
      if (!node.source || (node.type !== 'ImportDeclaration' && node.type !== 'ExportNamedDeclaration'))
        return false
      if (node.source.value === '#imports' && unrelatedGeneratedImports?.has(path))
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

/** Prefer top-level declarations; fall back to local declarations. */
function findDeclarations(paths: string[], name: string, allowMultiple = false): Declaration[] {
  const out: Declaration[] = []
  const locals: Declaration[] = []
  const parameters: Declaration[] = []
  for (const path of paths) {
    const source = readFileSync(path, 'utf8')
    const { program } = parseSource(path, source)
    for (const decl of listTopLevelDeclarations(program)) {
      if (decl.name === name)
        out.push({ _tag: 'TopLevel', filePath: path, source, pos: decl.nameStart })
    }
    const addPattern = (pattern: any, tag: Declaration['_tag'], list = tag === 'TopLevel' ? out : locals): void => {
      if (!pattern)
        return
      if (pattern.type === 'Identifier') {
        if (pattern.name === name) {
          if (!list.some(decl => decl.filePath === path && decl.pos === pattern.start))
            list.push({ _tag: tag, filePath: path, source, pos: pattern.start })
        }
      }
      else if (pattern.type === 'ObjectPattern') {
        for (const property of pattern.properties ?? []) addPattern(property.value ?? property.argument, tag, list)
      }
      else if (pattern.type === 'ArrayPattern') {
        for (const element of pattern.elements ?? []) addPattern(element, tag, list)
      }
      else if (pattern.type === 'AssignmentPattern') {
        addPattern(pattern.left, tag, list)
      }
      else if (pattern.type === 'RestElement') {
        addPattern(pattern.argument, tag, list)
      }
      else if (pattern.type === 'TSParameterProperty') {
        addPattern(pattern.parameter, tag, list)
      }
    }
    for (const statement of program.body ?? []) {
      const node = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
      if (node?.type === 'VariableDeclaration') {
        for (const declarator of node.declarations) addPattern(declarator.id, 'TopLevel')
      }
      if (node?.type === 'TSModuleDeclaration')
        addPattern(node.id, 'TopLevel')
    }
    walk(program, {
      enter(node: any) {
        if (node.type === 'VariableDeclarator' || NAMED_DECLARATION_TYPES.has(node.type) || node.type === 'FunctionExpression' || node.type === 'ClassExpression' || node.type === 'TSModuleDeclaration' || node.type === 'TSImportEqualsDeclaration')
          addPattern(node.id, 'Local')
        if (node.type === 'TSTypeParameter')
          addPattern(node.name, 'Local', parameters)
        if (node.type === 'TSMappedType')
          addPattern(node.key, 'Local', parameters)
        if (node.type === 'ImportSpecifier' || node.type === 'ImportDefaultSpecifier' || node.type === 'ImportNamespaceSpecifier')
          addPattern(node.local, 'Local', parameters)
        for (const parameter of node.params ?? []) addPattern(parameter, 'Local', parameters)
        if (node.type === 'CatchClause')
          addPattern(node.param, 'Local', parameters)
      },
    })
  }
  if (allowMultiple)
    return [...new Map([...parameters, ...locals, ...out].map(declaration => [`${declaration.filePath}:${declaration.pos}`, declaration])).values()]
  // Keep top-level renames from changing unrelated local shadows.
  if (out.length)
    return out
  if (!locals.length)
    locals.push(...parameters)
  if (locals.length > new Set(locals.map(d => d.filePath)).size)
    throw new Error(`ripide rename: "${name}" has multiple declarations in one file. Pass --all to rename every occurrence.`)
  return locals
}
