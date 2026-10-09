import type { EngineHooks, FrameworkAdapter, OperationContext, OperationName } from './adapter.ts'
import type { VerifyMode } from './project.ts'
import type { RenameFileResult } from './rename-file.ts'
import type { FileChange } from './util.ts'
import { resolve } from 'node:path'
import process from 'node:process'
import { createHooks } from 'hookable'
import { assertOperationSupport } from './capabilities.ts'
import { buildComponentDetail, buildComponentInventory } from './components.ts'
import { runCssClassRename } from './css-class-rename.ts'
import { runCssClassFileScan, runCssClassScan } from './css-class-scan.ts'
import { listTopLevelDeclarations } from './declarations.ts'
import { runDelete } from './delete.ts'
import { runDoctor } from './doctor.ts'
import { runMove } from './move.ts'
import { findTsconfig, resolveVerifyMode } from './project.ts'
import { runRenameFile } from './rename-file.ts'
import { runRename } from './rename.ts'
import { runReplace } from './replace.ts'
import { buildDeclarationTree, buildScanGraph, buildUnusedDeclarations, scan } from './scan.ts'
import { startTsServer } from './ts-server.ts'
import { commitChanges, parseFile, rgFiles } from './util.ts'
import { findRegressions } from './verify.ts'

export interface EngineOptions {
  extensions?: readonly FrameworkAdapter[]
}
/** No discovery, resolution or global registration occurs at SDK creation. */
export function createEngine(options: EngineOptions = {}) {
  const extensions = [...options.extensions ?? []]
  const owners = new Map<string, string>()
  const services = new Set<string>()
  const hooks = createHooks<EngineHooks>()
  for (const extension of extensions) {
    for (const suffix of extension.suffixes) {
      if (!suffix.startsWith('.') || [...owners.keys()].some(owned => owned.endsWith(suffix) || suffix.endsWith(owned)) || /\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/.test(suffix))
        throw new Error(`Duplicate or invalid suffix ownership: ${suffix}`)
      owners.set(suffix, extension.name)
    }
    if (extension.semanticService) {
      if (services.has(extension.semanticService))
        throw new Error(`Duplicate semantic service ownership: ${extension.semanticService}`)
      services.add(extension.semanticService)
    }
  }
  for (const extension of extensions) {
    if (extension.setup?.constructor.name === 'AsyncFunction')
      throw new Error(`Extension setup must be synchronous: ${extension.name}`)
    const initialized: unknown = extension.setup?.(hooks)
    if (initialized instanceof Promise) {
      initialized.catch(error => process.stderr.write(`Extension initialization failed: ${String(error)}\n`))
      throw new Error(`Extension setup must be synchronous: ${extension.name}`)
    }
    if (extension.verifyPlan)
      hooks.hook('operation:verify', extension.verifyPlan)
  }
  const inject = <T extends object>(opts?: T): T & EngineOptions => ({ ...opts, extensions }) as T & EngineOptions
  const guard = (operation: OperationName, cwd: string) => {
    assertOperationSupport(operation, cwd, extensions)
    for (const extension of extensions) {
      if (rgFiles('', { cwd, glob: extension.suffixes.map(suffix => `*${suffix}`), listAll: true }).length
        && !extension.operations?.includes(operation)) {
        throw new Error(`Extension does not support ${operation}: ${extension.name}`)
      }
    }
  }
  const finish = async <T extends {
    changes: FileChange[]
    regressions: OperationContext['regressions']
  }>(result: T, operation: OperationName, args: string[], cwd: string, opts?: {
    verify?: boolean | VerifyMode
    tsconfig?: string
  }): Promise<T> => {
    const context = { operation, args, cwd, changes: result.changes, regressions: result.regressions }
    const original = new Map(result.changes.map(change => [change.path, change.after]))
    await hooks.callHook('operation:plan', context)
    const paths = new Set<string>()
    for (const change of context.changes) {
      if (paths.has(change.path))
        throw new Error(`Duplicate extension plan: ${change.path}`)
      paths.add(change.path)
    }
    if (resolveVerifyMode(opts?.verify) !== 'none') {
      const added = context.changes.filter(change => original.get(change.path) !== change.after)
      if (added.length) {
        const scriptChanges = context.changes.filter(change => !extensions.some(extension => extension.suffixes.some(suffix => change.path.endsWith(suffix))))
        if (scriptChanges.length) {
          const server = await startTsServer(cwd, { tsconfig: opts?.tsconfig })
          try {
            context.regressions.push(...await findRegressions(server, scriptChanges, rgFiles('', { cwd, listAll: true })))
          }
          finally {
            server.dispose()
          }
        }
        for (const extension of extensions) {
          if (!added.some(change => extension.suffixes.some(suffix => change.path.endsWith(suffix))))
            continue
          if (extension.regressions) {
            const tsconfig = opts?.tsconfig ?? findTsconfig(cwd)
            if (!tsconfig)
              throw new Error(`Extension verification requires a tsconfig: ${extension.name}`)
            context.regressions.push(...await extension.regressions(tsconfig, cwd, context.changes))
          }
          else if (!extension.verifyPlan) {
            throw new Error(`Extension cannot verify its plan: ${extension.name}`)
          }
        }
      }
      await hooks.callHook('operation:verify', context)
    }
    return result
  }
  return {
    scan: (pattern: string, opts?: Parameters<typeof scan>[1]) => scan(pattern, inject(opts)),
    buildScanGraph: (pattern: string, opts?: Parameters<typeof buildScanGraph>[1]) => buildScanGraph(pattern, inject(opts)),
    buildDeclarationTree: (opts?: Parameters<typeof buildDeclarationTree>[0]) => buildDeclarationTree(inject(opts)),
    buildUnusedDeclarations: (opts?: Parameters<typeof buildUnusedDeclarations>[0]) => buildUnusedDeclarations(inject(opts)),
    async runRename(from: string, to: string, opts?: Parameters<typeof runRename>[2]) {
      const cwd = opts?.cwd ?? process.cwd()
      guard('rename', cwd)
      // A parser extension may own a declaration that the script server cannot see.
      const scope = opts?.scope
      const owner = scope ? extensions.find(extension => extension.suffixes.some(suffix => scope.endsWith(suffix))) : undefined
      if (owner) {
        const changes: FileChange[] = []
        if (owner.applyRename) {
          const tsconfig = opts?.tsconfig ?? findTsconfig(cwd)
          if (!tsconfig)
            throw new Error('Extension rename requires a tsconfig')
          const file = parseFile(resolve(cwd, scope!), cwd, extensions)
          const declarations = listTopLevelDeclarations(file.program).filter(declaration => declaration.name === from)
          if (!declarations.length)
            throw new Error(`No declaration of ${from} in ${scope}`)
          changes.push(...await owner.applyRename(tsconfig, cwd, from, to, declarations.map(declaration => ({ filePath: file.path, source: file.fullSource, pos: declaration.nameStart + file.scriptStart }))))
        }
        const result = await finish({ changes, regressions: [], scanned: 1, warnings: [] }, 'rename', [from, to, scope!], cwd, opts)
        if (from !== to && !result.changes.length)
          throw new Error(`Extension produced no rename plan: ${owner.name}`)
        return result
      }
      return finish(await runRename(from, to, inject(opts)), 'rename', [from, to], cwd, opts)
    },
    async runMove(symbol: string, from: string, to: string, opts?: Parameters<typeof runMove>[3]) {
      const cwd = opts?.cwd ?? process.cwd()
      guard('move', cwd)
      return finish(await runMove(symbol, from, to, inject(opts)), 'move', [symbol, from, to], cwd, opts)
    },
    async runDelete(symbol: string, from: string, opts?: Parameters<typeof runDelete>[2]) {
      const cwd = opts?.cwd ?? process.cwd()
      guard('delete', cwd)
      return finish(await runDelete(symbol, from, inject(opts)), 'delete', [symbol, from], cwd, opts)
    },
    async runRenameFile(from: string, to: string, opts?: Parameters<typeof runRenameFile>[2]) {
      const cwd = opts?.cwd ?? process.cwd()
      guard('rename-file', cwd)
      return finish(await runRenameFile(from, to, inject(opts)), 'rename-file', [from, to], cwd, opts)
    },
    async runReplace(from: string, to: string, opts?: Parameters<typeof runReplace>[2]) {
      const cwd = opts?.cwd ?? process.cwd()
      guard('replace', cwd)
      return finish(await runReplace(from, to, inject(opts)), 'replace', [from, to], cwd, opts)
    },
    runCssClassRename: (map: Parameters<typeof runCssClassRename>[0], opts?: Parameters<typeof runCssClassRename>[1]) => runCssClassRename(map, inject(opts)),
    runCssClassScan: (opts?: Parameters<typeof runCssClassScan>[0]) => runCssClassScan(inject(opts)),
    runCssClassFileScan: (opts?: Parameters<typeof runCssClassFileScan>[0]) => runCssClassFileScan(inject(opts)),
    runDoctor: (opts?: Parameters<typeof runDoctor>[0]) => runDoctor(inject(opts)),
    buildComponentInventory: (opts?: Parameters<typeof buildComponentInventory>[0]) => buildComponentInventory(inject(opts)),
    buildComponentDetail: (name: string, opts?: Parameters<typeof buildComponentDetail>[1]) => buildComponentDetail(name, inject(opts)),
    /** The sole commit boundary. Planning hooks cannot write through the engine. */
    apply(result: {
      changes: FileChange[]
      regressions: OperationContext['regressions']
    } | RenameFileResult) {
      if (result.regressions.length)
        throw new Error('Verification failed; refusing to apply changes')
      if ('fileMove' in result) {
        commitChanges({ _tag: 'FileRename', changes: result.changes, from: result.fileMove.from, to: result.fileMove.to, before: result.sourceBefore, after: result.selfChange?.after ?? result.sourceBefore })
      }
      else {
        commitChanges({ _tag: 'Changes', changes: result.changes })
      }
    },
  }
}
export type Engine = ReturnType<typeof createEngine>
