import type { Hookable } from 'hookable'
import type { Program } from 'oxc-parser'
import type { FrameworkAdapter, SourceExpression } from './adapter.ts'
import type { CssClassSourceFile } from './css-class-source.ts'
import type { RenameMap } from './css-class-token.ts'
import type { DeleteOptions } from './delete.ts'
import type { MoveOptions } from './move.ts'
import type { RenameFileOptions, RenameFileResult } from './rename-file.ts'
import type { RenameOptions, RenameResult } from './rename.ts'
import type { ReplaceOptions } from './replace.ts'
import type { ScanOptions } from './scan.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import process from 'node:process'
import { createHooks } from 'hookable'
import { buildComponentDetail, buildComponentInventory } from './components.ts'
import { runCssClassFileScan, runCssClassScan } from './css-class-scan.ts'
import { runDelete } from './delete.ts'
import { runDoctor } from './doctor.ts'
import { runMove } from './move.ts'
import { assertSourceSupport, findTsconfig, projectScriptFiles, resolveVerifyMode } from './project.ts'
import { runRenameFile, verifyFileRename } from './rename-file.ts'
import { runRename } from './rename.ts'
import { runReplace } from './replace.ts'
import { buildDeclarationTree, buildScanGraph, buildUnusedDeclarations, scan } from './scan.ts'
import { startTsServer } from './ts-server.ts'
import { rgFiles, writeChanges, writeFileRename } from './util.ts'
import { findRegressions } from './verify.ts'

export interface SourceRegion {
  _tag: 'Script'
  /** Contiguous authored script. Positions are relative to start, never generated code. */
  source: string
  start: number
  filename: string
}
export interface AuthoredProgram { _tag: 'Authored', program: Program }
export type ParsedSource = SourceRegion | AuthoredProgram
export type Operation = 'rename' | 'move' | 'delete' | 'renameFile' | 'replace'
export type OperationRequest
  = | { operation: 'rename' | 'replace', from: string, to: string }
    | { operation: 'move', symbol: string, from: string, to: string }
    | { operation: 'delete', symbol: string, from: string }
    | { operation: 'renameFile', from: string, to: string }
export type OperationContext = OperationRequest & { cwd: string }
export type PlanContext = OperationContext & { changes: FileChange[] }
export interface EngineHooks {
  'operation:before': (context: OperationContext) => void | Promise<void>
  /** Handlers run serially in extension order. Conflicting authored edits refuse. */
  'plan:ready': (context: PlanContext) => void | Promise<void>
  /** Runs after plan hooks, before any commit. A thrown failure preserves bytes. */
  'verify:before': (context: PlanContext) => void | Promise<void>
}
export interface Extension {
  name: string
  suffixes: readonly string[]
  parse: (input: { path: string, source: string, cwd: string }) => ParsedSource
  css?: { visit: (file: CssClassSourceFile, visit: (bare: string) => void) => void, rewrite: (file: CssClassSourceFile, map: RenameMap) => string }
  configPaths?: readonly string[]
  expressions?: (source: string) => SourceExpression[]
  /** Offset-preserving source used for import and reference inspection. */
  inspect?: (input: { path: string, source: string }) => { source: string, filename: string }
  /** Semantic ownership is separate from synchronous parsing. */
  semantic?: FrameworkAdapter
  operations?: readonly Operation[]
  supports?: (request: OperationRequest, cwd: string) => boolean
  verify?: (input: PlanContext) => Promise<Regression[]>
  planRename?: (input: { from: string, to: string, options: RenameOptions, services: EngineServices }) => Promise<RenameResult>
  setup?: (hooks: Hookable<EngineHooks>) => void
}
export interface EngineServices {
  suffixes: readonly string[]
  extensions: readonly Extension[]
  adapter: FrameworkAdapter | null
  owns: (path: string) => boolean
  parse: (path: string, source: string, cwd: string) => ParsedSource | undefined
  expressions: (path: string, source: string) => SourceExpression[]
  inspect: (path: string, source: string) => { source: string, filename: string }
  assertOperation: (request: OperationRequest, cwd: string) => void
}
export interface EngineOptions { extensions?: readonly Extension[], requiredSuffixes?: readonly string[] }
export type Engine = ReturnType<typeof createEngine>

/** Construct an isolated engine. No package loading or process registrations occur here. */
export function createEngine(options: EngineOptions = {}) {
  const extensions = [...options.extensions ?? []]
  const owners = new Map<string, Extension>()
  const semanticOwners = new Map<string, string>()
  const names = new Set<string>()
  for (const extension of extensions) {
    if (names.has(extension.name))
      throw new Error(`Duplicate extension ownership: ${extension.name}`)
    names.add(extension.name)
    if (!extension.name || !extension.suffixes.length)
      throw new Error('Extension needs a name and suffix ownership')
    for (const suffix of extension.suffixes) {
      if (!/^\.[\w-]+$/.test(suffix) || owners.has(suffix) || /^(?:\.ts|\.tsx|\.js|\.jsx|\.mts|\.cts|\.mjs|\.cjs)$/.test(suffix))
        throw new Error(`Duplicate or invalid suffix ownership: ${suffix}`)
      owners.set(suffix, extension)
    }
    if (extension.semantic) {
      if (semanticOwners.has(extension.semantic.name))
        throw new Error(`Duplicate semantic ownership: ${extension.name}`)
      semanticOwners.set(extension.semantic.name, extension.name)
    }
  }
  for (const suffix of options.requiredSuffixes ?? []) {
    if (!owners.has(suffix))
      throw new Error(`Required extension missing for ${suffix}`)
  }
  const hooks = createHooks<EngineHooks>()
  for (const extension of extensions) {
    if (extension.setup?.constructor.name === 'AsyncFunction')
      throw new Error(`Extension setup must be synchronous: ${extension.name}`)
    const initialized: unknown = extension.setup?.(hooks)
    if (initialized instanceof Promise) {
      initialized.catch(error => process.stderr.write(`Extension initialization failed: ${String(error)}\n`))
      throw new Error(`Extension setup must be synchronous: ${extension.name}`)
    }
  }
  const owner = (path: string) => owners.get(extname(path))
  const services: EngineServices = {
    suffixes: [...owners.keys()],
    extensions,
    adapter: combineAdapters(extensions.flatMap(extension => extension.semantic ? [extension.semantic] : [])),
    owns: path => Boolean(owner(path)),
    parse(path, source, cwd) {
      const region = owner(path)?.parse({ path, source, cwd })
      if (region?._tag === 'Script' && (!Number.isInteger(region.start) || region.start < 0 || source.slice(region.start, region.start + region.source.length) !== region.source))
        throw new Error(`Extension returned non-authored source for ${path}`)
      return region
    },
    expressions: (path, source) => owner(path)?.expressions?.(source) ?? [],
    inspect: (path, source) => owner(path)?.inspect?.({ path, source }) ?? { source, filename: path },
    assertOperation(request, cwd) {
      const operation = request.operation
      for (const extension of extensions) {
        if (!rgFiles('', { cwd, glob: extension.suffixes.map(suffix => `*${suffix}`), listAll: true }).length)
          continue
        const supported = extension.operations?.includes(operation)
          ?? Boolean(extension.semantic && (operation !== 'replace'))
        if (!supported || extension.supports?.(request, cwd) === false)
          throw new Error(`Extension ${extension.name} does not support ${operation}; consumers cannot be omitted`)
      }
    },
  }
  const plans = new WeakMap<object, { fingerprint: string, movedSource: string | null }>()
  async function execute<T extends { changes: FileChange[], regressions: Regression[] }>(request: OperationRequest, opts: { cwd?: string, tsconfig?: string, verify?: boolean | 'none' | 'touched' | 'project' }, action: () => Promise<T>): Promise<T> {
    const cwd = opts.cwd ?? process.cwd()
    const tsconfig = opts.tsconfig ? resolve(cwd, opts.tsconfig) : findTsconfig(cwd)
    assertSourceSupport(cwd, services)
    services.assertOperation(request, cwd)
    await hooks.callHook('operation:before', { ...request, cwd })
    const result = await action()
    const originalPlan = JSON.stringify(result.changes)
    const context = { ...request, cwd, changes: result.changes }
    await hooks.callHook('plan:ready', context)
    validateChanges(result.changes)
    await hooks.callHook('verify:before', context)
    validateChanges(result.changes)
    if (resolveVerifyMode(opts.verify) !== 'none') {
      // Hook-added plans share the same verification boundary as native plans.
      const scripts = result.changes.filter(change => !services.owns(change.path))
      if (scripts.length && (JSON.stringify(result.changes) !== originalPlan || extensions.some(extension => extension.planRename))) {
        const server = await startTsServer(cwd, { tsconfig: tsconfig ?? undefined })
        try {
          if (isFileRenameResult(result)) {
            result.regressions.push(...await verifyFileRename(server, cwd, result.fileMove.from, result.fileMove.to, result.changes, result.selfChange, resolveVerifyMode(opts.verify), (consumer, specifier) => services.adapter?.isPlannedImportTarget?.(cwd, consumer, specifier, result.fileMove.to) ?? false))
          }
          else {
            result.regressions.push(...await findRegressions(server, scripts, projectScriptFiles(cwd, undefined, services)))
          }
        }
        finally { server.dispose() }
      }
      for (const extension of extensions) {
        if (extension.verify) {
          result.regressions.push(...await extension.verify(context))
        }
        else if (extension.semantic && result.changes.length) {
          const config = tsconfig
          if (!config && rgFiles('', { cwd, glob: extension.suffixes.map(suffix => `*${suffix}`), listAll: true }).length)
            throw new Error(`Extension ${extension.name} verification requires a tsconfig`)
          if (config)
            result.regressions.push(...await extension.semantic.regressions(config, cwd, result.changes))
        }
        else if (result.changes.some(change => extension.suffixes.some(suffix => change.path.endsWith(suffix)))) {
          throw new Error(`Extension ${extension.name} cannot verify its plan`)
        }
      }
    }
    result.regressions = [...new Map(result.regressions.map(regression => [JSON.stringify(regression), regression])).values()]
    plans.set(result, { fingerprint: JSON.stringify(result), movedSource: isFileRenameResult(result) ? readFileSync(result.fileMove.from, 'utf8') : null })
    return result
  }
  return {
    services,
    scan: (pattern: string, opts: ScanOptions = {}) => scan(pattern, { ...opts, engine: services }),
    graph: (pattern: string, opts: ScanOptions = {}) => buildScanGraph(pattern, { ...opts, engine: services }),
    declarations: (opts: Parameters<typeof buildDeclarationTree>[0] = {}) => buildDeclarationTree({ ...opts, engine: services }),
    unused: (opts: Parameters<typeof buildUnusedDeclarations>[0] = {}) => buildUnusedDeclarations({ ...opts, engine: services }),
    runCssClassScan: (opts: Parameters<typeof runCssClassScan>[0] = {}) => runCssClassScan({ ...opts, engine: services }),
    runCssClassFileScan: (opts: Parameters<typeof runCssClassFileScan>[0] = {}) => runCssClassFileScan({ ...opts, engine: services }),
    runDoctor: (opts: Parameters<typeof runDoctor>[0] = {}) => runDoctor({ ...opts, engine: services }),
    buildComponentInventory: (opts: Parameters<typeof buildComponentInventory>[0] = {}) => buildComponentInventory({ ...opts, engine: services }),
    buildComponentDetail: (name: string, opts: Parameters<typeof buildComponentDetail>[1] = {}) => buildComponentDetail(name, { ...opts, engine: services }),
    rename: (from: string, to: string, opts: RenameOptions = {}) => execute({ operation: 'rename', from, to }, opts, async () => {
      const planners = extensions.filter(extension => extension.planRename && rgFiles(from, { cwd: opts.cwd, glob: extension.suffixes.map(suffix => `*${suffix}`) }).length)
      const coreBindings = scan(from, { cwd: opts.cwd, engine: services }).some(hit => !services.owns(hit.file) && hit.kind === 'identifier-binding')
      const results: RenameResult[] = []
      if (coreBindings || !planners.length)
        results.push(await runRename(from, to, { ...opts, engine: services }))
      for (const extension of planners)
        results.push(await extension.planRename!({ from, to, options: opts, services }))
      return combineRenameResults(results)
    }),
    move: (symbol: string, from: string, to: string, opts: MoveOptions = {}) => execute({ operation: 'move', symbol, from, to }, opts, () => runMove(symbol, from, to, { ...opts, engine: services })),
    delete: (symbol: string, from: string, opts: DeleteOptions = {}) => execute({ operation: 'delete', symbol, from }, opts, () => runDelete(symbol, from, { ...opts, engine: services })),
    renameFile: (from: string, to: string, opts: RenameFileOptions = {}) => execute({ operation: 'renameFile', from, to }, opts, () => runRenameFile(from, to, { ...opts, engine: services })),
    replace: (from: string, to: string, opts: ReplaceOptions = {}) => execute({ operation: 'replace', from, to }, opts, () => runReplace(from, to, { ...opts, engine: services })),
    /** All extension planning and verification completes before this atomic write boundary. */
    commit(result: { changes: FileChange[], regressions: Regression[] } | RenameFileResult) {
      const plan = plans.get(result)
      if (!plan || plan.fingerprint !== JSON.stringify(result))
        throw new Error('Plan changed after verification; changes were refused')
      if (result.regressions.length)
        throw new Error('Verification failed; changes were refused')
      validateChanges(result.changes)
      if (isFileRenameResult(result))
        writeFileRename(result, plan.movedSource!)
      else writeChanges(result.changes)
    },
  }
}

function validateChanges(changes: FileChange[]): void {
  const seen = new Map<string, FileChange>()
  for (const change of changes) {
    const previous = seen.get(change.path)
    if (previous && (previous.before !== change.before || previous.after !== change.after))
      throw new Error(`Conflicting extension edits for ${change.path}`)
    seen.set(change.path, change)
  }
}
function mergePlans(plans: FileChange[][]): FileChange[] {
  const changes = plans.flat()
  validateChanges(changes)
  return [...new Map(changes.map(change => [change.path, change])).values()]
}
function combineRenameResults(results: RenameResult[]): RenameResult {
  return { changes: mergePlans(results.map(result => result.changes)), regressions: results.flatMap(result => result.regressions), warnings: results.flatMap(result => result.warnings), scanned: results.reduce((sum, result) => sum + result.scanned, 0) }
}
function combineAdapters(adapters: FrameworkAdapter[]): FrameworkAdapter | null {
  if (!adapters.length)
    return null
  if (adapters.length === 1)
    return adapters[0]!
  // Implicit binding policy has one owner. Multiple parsers and semantic services may coexist.
  const policies = adapters.filter(adapter => adapter.autoImportScopes)
  if (policies.length > 1)
    throw new Error('Duplicate implicit-binding policy ownership')
  return {
    ...policies[0],
    name: adapters.map(adapter => adapter.name).join(', '),
    hasFilesContaining: (cwd, pattern) => adapters.some(adapter => adapter.hasFilesContaining(cwd, pattern)),
    applyRename: async (...args) => mergePlans(await Promise.all(adapters.map(adapter => adapter.applyRename(...args)))),
    applyImportRewrite: async (...args) => mergePlans(await Promise.all(adapters.map(adapter => adapter.applyImportRewrite(...args)))),
    applyFileRenameEdits: async (...args) => mergePlans(await Promise.all(adapters.map(adapter => adapter.applyFileRenameEdits(...args)))),
    regressions: async (...args) => (await Promise.all(adapters.map(adapter => adapter.regressions(...args)))).flat(),
    isGeneratedPath: (cwd, path) => adapters.some(adapter => adapter.isGeneratedPath?.(cwd, path)),
    filterGeneratedChanges(cwd, changes) {
      for (const adapter of adapters) adapter.filterGeneratedChanges?.(cwd, changes)
    },
    isPlannedImportTarget: (...args) => adapters.some(adapter => adapter.isPlannedImportTarget?.(...args)),
    addExplicitImports: ctx => mergePlans(adapters.map(adapter => adapter.addExplicitImports?.(ctx) ?? [])),
    async finalizeFileRename(...args) {
      const results = []
      for (const adapter of adapters) {
        const result = await adapter.finalizeFileRename?.(...args)
        if (result)
          results.push(result)
      }
      return { changes: mergePlans(results.map(result => result.changes)), warnings: results.flatMap(result => result.warnings) }
    },
    listComponents: (cwd, opts) => adapters.flatMap(adapter => adapter.listComponents?.(cwd, opts) ?? []),
    findComponentUsages: (names, opts) => adapters.flatMap(adapter => adapter.findComponentUsages?.(names, opts) ?? []),
  }
}

function isFileRenameResult(result: { changes: FileChange[], regressions: Regression[] }): result is RenameFileResult {
  return 'fileMove' in result && 'selfChange' in result
}
