import type { EngineServices } from './engine.ts'
import type { VerifyMode } from './project.ts'
import type { FileChange } from './util.ts'
import type { Verification } from './verification.ts'
import type { Regression } from './verify.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import process from 'node:process'
import { walk } from 'oxc-walker'
import { listTopLevelDeclarations, parseSource, removeDeclaration } from './declarations.ts'
import { listImports, pruneUnusedImports } from './imports.ts'
import { assertSourceSupport, findTsconfig, isExtensionPath, isInsideAutoImportScope, projectScriptFiles, resolveVerifyMode } from './project.ts'
import { startTsServer } from './ts-server.ts'
import { posToLineCol, rgFiles } from './util.ts'
import { createVerification } from './verification.ts'
import { findExtensionRegressions, findRegressions } from './verify.ts'

export interface DeleteOptions {
  engine?: EngineServices
  cwd?: string
  verify?: boolean | VerifyMode
}

export interface DeleteReference {
  file: string
  line: number
  col: number
}

export interface DeleteResult {
  changes: FileChange[]
  scanned: number
  regressions: Regression[]
  verification: Verification
}

export async function runDelete(symbol: string, fromPath: string, opts: DeleteOptions = {}): Promise<DeleteResult> {
  const cwd = opts.cwd ?? process.cwd()
  const engine = opts.engine
  assertSourceSupport(cwd, engine)
  engine?.assertOperation({ operation: 'delete', symbol, from: fromPath }, cwd)
  const verifyMode = resolveVerifyMode(opts.verify)
  const fromAbs = resolve(cwd, fromPath)
  // Escaped identifiers and namespace use need not contain the symbol's text.
  const candidatePaths = rgFiles('', { cwd, engine, listAll: true })

  const before = readFileSync(fromAbs, 'utf8')
  const parsed = parseSource(fromAbs, before)
  const decl = listTopLevelDeclarations(parsed.program).find(d =>
    d.name === symbol && !d.isDefault && (d.kind !== 'variable' || d.declaratorCount === 1),
  )
  if (!decl) {
    throw new Error(
      `ripide delete: no top-level declaration named "${symbol}" in ${fromPath} `
      + `(supported: function, class, interface, type, enum, const/let/var with single declarator)`,
    )
  }

  const adapter = engine?.adapter ?? null
  let inspectedScopes = false
  if (decl.exported && adapter?.autoImportScopes) {
    const scopes = adapter.autoImportScopes(cwd)
    inspectedScopes = isInsideAutoImportScope(fromAbs, scopes)
    if (inspectedScopes) {
      if (!adapter.inspectAutoImportConsumers)
        throw new Error('Cannot inspect implicit consumers before deletion')
      const consumers = adapter.inspectAutoImportConsumers({ cwd, symbol, fromAbs, files: candidatePaths, scopes })
      if (consumers.length)
        throw new Error(`ripide delete: cannot prove "${symbol}" is unused through auto-imports in ${consumers.join(', ')}. Use explicit imports first.`)
    }
  }

  const server = await startTsServer(cwd)
  try {
    const authoredScripts = new Map<string, string>()
    const scripts: { path: string, source: string, script: string, imports: ReturnType<typeof listImports> }[] = []
    for (const path of candidatePaths) {
      const source = readFileSync(path, 'utf8')
      let script = source
      let scriptPath = path
      if (!isExtensionPath(path, engine)) {
        server.open(path, source)
      }
      else {
        const inspected = engine!.inspect(path, source)
        scriptPath = inspected.filename
        script = inspected.source
        server.open(scriptPath, script)
        authoredScripts.set(scriptPath, path)
      }
      const imports = decl.exported ? listImports(script, scriptPath).filter(imp => imp.namespaceImport) : []
      if (decl.exported)
        scripts.push({ path, source, script, imports })
    }
    // Open every script before caching namespace resolution. Excluded scripts
    // can contribute ambient modules or augmentations to the same project.
    const inspectedNamespaces = new Set<string>()
    for (const { path, source, script, imports } of scripts) {
      const dynamicImports: any[] = []
      // Generated Nuxt metadata uses the consumer proof and reference checks below.
      if (!adapter?.isGeneratedPath?.(cwd, path)) {
        walk(parseSource(path, script).program, {
          enter(node: any) {
            if (node.type === 'ImportExpression' || node.type === 'TSImportType')
              dynamicImports.push(node.source)
          },
        })
      }
      for (const module of dynamicImports) {
        const { line, col } = posToLineCol(source, module.start)
        const location = `${relative(cwd, path)}:${line}:${col}`
        if (typeof module.value !== 'string')
          throw new Error(`ripide delete: cannot resolve a dynamic import at ${location}. Use a resolvable named import first.`)
        const importText = `import * as __RipIDEDynamic from ${script.slice(module.start, module.end)}`
        const access = `__RipIDEDynamic.${symbol}`
        const probe = `${importText}\n${access};\ntype __RipIDEDynamicType = ${access};`
        const probePath = inspectionPath(path, 'ts')
        server.open(probePath, probe)
        for (const offset of [probe.indexOf(access), probe.lastIndexOf(access)]) {
          const definitions = await server.definition(probePath, offset + '__RipIDEDynamic.'.length)
          if (definitions.some(site => site.path === fromAbs && site.start >= decl.start && site.start < decl.end))
            throw new Error(`ripide delete: cannot prove "${symbol}" is unused through a dynamic import at ${location}. Use named imports first.`)
        }
        const moduleOffset = parseSource(probePath, importText).program.body[0].source.start + 1
        if (!(await server.definition(probePath, moduleOffset)).length)
          throw new Error(`ripide delete: cannot resolve a dynamic import at ${location}. Use a resolvable named import first.`)
      }
      for (const imp of imports) {
        const namespace = imp.namespaceImport
        if (!namespace)
          continue
        // Probe the export through the namespace, including wildcard barrels.
        // Reflective and dynamic namespace usage cannot be proved unused.
        const importText = script.slice(imp.start, imp.end)
        const inspectionKey = `${dirname(path)}\0${importText}`
        if (inspectedNamespaces.has(inspectionKey))
          continue
        const access = `${namespace.name}.${symbol}`
        const probe = `${importText}\n${access};\ntype __RipIDENamespace = ${access};`
        const probePath = inspectionPath(path, 'ts')
        server.open(probePath, probe)
        const offsets = [probe.indexOf(access), probe.lastIndexOf(access)].map(offset => offset + namespace.name.length + 1)
        let resolvedExport = false
        for (const offset of offsets) {
          const definitions = await server.definition(probePath, offset)
          resolvedExport ||= definitions.length > 0
          if (!definitions.some(site => site.path === fromAbs && site.start >= decl.start && site.start < decl.end))
            continue
          const { line, col } = posToLineCol(source, namespace.start)
          throw new Error(`ripide delete: cannot prove "${symbol}" is unused through a namespace import at ${relative(cwd, path)}:${line}:${col}. Use named imports first.`)
        }
        if (!resolvedExport) {
          const moduleOffset = parseSource(probePath, importText).program.body[0].source.start + 1
          const modules = await server.definition(probePath, moduleOffset)
          if (!modules.length) {
            const { line, col } = posToLineCol(source, namespace.start)
            throw new Error(`ripide delete: cannot resolve a namespace import at ${relative(cwd, path)}:${line}:${col}. Use a resolvable import first.`)
          }
        }
        inspectedNamespaces.add(inspectionKey)
      }
    }
    const references: DeleteReference[] = []
    for (const ref of await server.references(fromAbs, decl.nameStart)) {
      // Generated references stay live evidence unless consumer inspection already proved the provider unused.
      if (adapter?.isGeneratedPath?.(cwd, ref.path) && inspectedScopes)
        continue
      if (ref.path === fromAbs && ref.start >= decl.start && ref.start < decl.end)
        continue
      references.push({ file: relative(cwd, authoredScripts.get(ref.path) ?? ref.path), line: ref.line, col: ref.col })
    }
    references.sort((a, b) => `${a.file}\0${a.line}\0${a.col}`.localeCompare(`${b.file}\0${b.line}\0${b.col}`))
    if (references.length) {
      const preview = references.slice(0, 20).map(ref => `${ref.file}:${ref.line}:${ref.col}`).join('\n')
      const extra = references.length > 20 ? `\n... ${references.length - 20} more` : ''
      throw new Error(`ripide delete: "${symbol}" still has ${references.length} reference${references.length === 1 ? '' : 's'}\n\n${preview}${extra}\n\nUse ripide scan ${symbol} to inspect usages.`)
    }

    const after = pruneUnusedImports(removeDeclaration(before, parsed.comments, decl), fromAbs)
    const changes: FileChange[] = after === before
      ? []
      : [{ path: fromAbs, rel: relative(cwd, fromAbs), before, after }]

    const verification = createVerification(verifyMode, !!changes.length)
    const regressions = verifyMode === 'none' || !changes.length
      ? []
      : await findRegressions(server, changes, verifyMode === 'project' ? projectScriptFiles(cwd, undefined, engine) : [fromAbs], verification.typescript)
    if (verifyMode === 'project')
      regressions.push(...await findExtensionRegressions(cwd, changes, findTsconfig(cwd), engine, verification.extension))

    return { changes, scanned: new Set([...candidatePaths, fromAbs]).size, regressions, verification: verification.result() }
  }
  finally {
    server.dispose()
  }
}

function inspectionPath(path: string, extension: 'ts' | 'tsx'): string {
  let candidate = `${path}.${randomUUID()}.${extension}`
  while (existsSync(candidate)) candidate = `${path}.${randomUUID()}.${extension}`
  return candidate
}
