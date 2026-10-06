import type { ImportInfo } from './imports.ts'
import type { VerifyMode } from './project.ts'
import type { TsServer } from './ts-server.ts'
import type { FileChange, TextEdit } from './util.ts'
import type { Regression } from './verify.ts'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { listTopLevelDeclarations, parseSource } from './declarations.ts'
import { addOrMergeImport, computeSpecifier, isImportEmpty, listImports, localNameOf, parseProgram, pruneUnusedImports, renderImport } from './imports.ts'
import { isVuePath, resolveVerifyMode, verifyScope } from './project.ts'
import { startTsServer } from './ts-server.ts'
import { applyTextEdits, rgFiles } from './util.ts'
import { findRegressions } from './verify.ts'

export interface ReplaceOptions {
  cwd?: string
  glob?: string | string[]
  verify?: boolean | VerifyMode
  targetScope?: string
}

export interface ReplaceResult {
  changes: FileChange[]
  scanned: number
  regressions: Regression[]
}

interface ReplacementTarget {
  filePath: string
  importName: string
  isTypeOnly: boolean
}

export async function runReplace(from: string, to: string, opts: ReplaceOptions = {}): Promise<ReplaceResult> {
  const cwd = opts.cwd ?? process.cwd()
  const verifyMode = resolveVerifyMode(opts.verify)
  const targetPaths = opts.targetScope
    ? [resolve(cwd, opts.targetScope)]
    : rgFiles(to, { cwd, glob: opts.glob }).filter(path => !isVuePath(path))
  const target = findReplacementTarget(targetPaths, to, cwd, opts.targetScope)
  // A wrapper may call the imported symbol it replaces. Rewriting it creates recursion.
  const candidatePaths = rgFiles(from, { cwd, glob: opts.glob }).filter(path => !isVuePath(path) && path !== target.filePath)

  const server = await startTsServer(cwd)
  try {
    const changes: FileChange[] = []
    for (const path of candidatePaths) {
      const before = readFileSync(path, 'utf8')
      const after = await replaceImportedSymbol(server, path, before, from, to, target)
      if (after !== before)
        changes.push({ path, rel: relative(cwd, path), before, after })
    }
    const regressions = verifyMode === 'none'
      ? []
      : await findRegressions(server, changes, verifyScope(verifyMode, cwd, candidatePaths, changes.map(c => c.path), opts.glob))
    return { changes, scanned: candidatePaths.length, regressions }
  }
  finally {
    server.dispose()
  }
}

function findReplacementTarget(paths: string[], symbol: string, cwd: string, targetScope?: string): ReplacementTarget {
  const scopeAbs = targetScope ? resolve(cwd, targetScope) : null
  const matches: ReplacementTarget[] = []
  for (const path of paths) {
    if (scopeAbs && path !== scopeAbs)
      continue
    const { program } = parseSource(path, readFileSync(path, 'utf8'))
    const decl = listTopLevelDeclarations(program).find(d => d.name === symbol && d.exported && !d.isDefault)
    if (decl)
      matches.push({ filePath: path, importName: symbol, isTypeOnly: decl.kind === 'interface' || decl.kind === 'type' })
  }
  if (!matches.length) {
    if (targetScope)
      throw new Error(`ripast replace: no exported declaration of "${symbol}" in ${targetScope}`)
    throw new Error(`ripast replace: no exported declaration of "${symbol}" found in project`)
  }
  const uniqueFiles = new Set(matches.map(m => relative(cwd, m.filePath)))
  if (uniqueFiles.size > 1) {
    throw new Error(
      `ripast replace: "${symbol}" is exported from multiple files (${[...uniqueFiles].join(', ')}). `
      + `Pass --target-scope <file> to pick one.`,
    )
  }
  return matches[0]
}

interface ImportedBinding {
  imp: ImportInfo
  kind: 'named' | 'default'
  name?: string
  offset: number
}

async function replaceImportedSymbol(server: TsServer, path: string, source: string, from: string, to: string, target: ReplacementTarget): Promise<string> {
  const program = parseProgram(path, source)
  const imports = listImports(source, path, program)
  const bindings: ImportedBinding[] = []
  for (const imp of imports) {
    for (const n of imp.named) {
      if (localNameOf(n) === from)
        bindings.push({ imp, kind: 'named', name: n.name, offset: n.localStart })
    }
    if (imp.defaultImport?.name === from)
      bindings.push({ imp, kind: 'default', offset: imp.defaultImport.start })
  }
  if (!bindings.length)
    return source

  server.open(path, source)
  const edits: TextEdit[] = []
  let replaced = false
  for (const binding of bindings) {
    for (const ref of await server.references(path, binding.offset)) {
      if (ref.path !== path || imports.some(i => ref.start >= i.start && ref.start < i.end))
        continue
      edits.push({ start: ref.start, end: ref.end, replacement: to })
      replaced = true
    }
  }

  const working = new Map<ImportInfo, ImportInfo>()
  for (const binding of bindings) {
    const current = working.get(binding.imp) ?? { ...binding.imp, named: [...binding.imp.named] }
    if (binding.kind === 'named')
      current.named = current.named.filter(n => localNameOf(n) !== from)
    else
      current.defaultImport = undefined
    working.set(binding.imp, current)
  }
  for (const [imp, current] of working) {
    if (isImportEmpty(current)) {
      const end = source[imp.end] === '\n' ? imp.end + 1 : imp.end
      edits.push({ start: imp.start, end, replacement: '' })
    }
    else {
      edits.push({ start: imp.start, end: imp.end, replacement: renderImport(current) })
    }
  }
  const stripped = applyTextEdits(source, edits)
  if (!replaced)
    return stripped

  const specifier = computeSpecifier(path, target.filePath, './placeholder.ts')
  const withImport = addOrMergeImport(stripped, path, specifier, {
    namedImports: [{ name: target.importName, alias: target.importName === to ? undefined : to, isTypeOnly: target.isTypeOnly }],
    isTypeOnly: target.isTypeOnly,
  })
  return pruneUnusedImports(withImport, path)
}
