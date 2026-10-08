import type { VerifyMode } from './project.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { parse } from '@vue/compiler-sfc'
import { walk } from 'oxc-walker'
import { detectFrameworks, loadAdapter } from './adapter.ts'
import { listTopLevelDeclarations, parseSource, removeDeclaration } from './declarations.ts'
import { listImports, pruneUnusedImports } from './imports.ts'
import { isInsideAutoImportScope } from './nuxt.ts'
import { isVuePath, projectScriptFiles, resolveVerifyMode } from './project.ts'
import { startTsServer } from './ts-server.ts'
import { posToLineCol, rgFiles } from './util.ts'
import { findRegressions } from './verify.ts'

export interface DeleteOptions {
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
}

export async function runDelete(symbol: string, fromPath: string, opts: DeleteOptions = {}): Promise<DeleteResult> {
  const cwd = opts.cwd ?? process.cwd()
  const verifyMode = resolveVerifyMode(opts.verify)
  const fromAbs = resolve(cwd, fromPath)
  // Escaped identifiers and namespace use need not contain the symbol's text.
  const candidatePaths = rgFiles('', { cwd, listAll: true })

  const before = readFileSync(fromAbs, 'utf8')
  const parsed = parseSource(fromAbs, before)
  const decl = listTopLevelDeclarations(parsed.program).find(d =>
    d.name === symbol && !d.isDefault && (d.kind !== 'variable' || d.declaratorCount === 1),
  )
  if (!decl) {
    throw new Error(
      `ripast delete: no top-level declaration named "${symbol}" in ${fromPath} `
      + `(supported: function, class, interface, type, enum, const/let/var with single declarator)`,
    )
  }

  const nuxt = decl.exported && (detectFrameworks(cwd).includes('nuxt')
    || ['.nuxt', 'nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mts', 'nuxt.config.mjs'].some(path => existsSync(join(cwd, path))))
  const nuxtAdapter = nuxt ? await loadAdapter('nuxt') : null
  let inspectedScopes = false
  if (nuxt) {
    if (!nuxtAdapter?.autoImportScopes || !nuxtAdapter.inspectAutoImportConsumers)
      throw new Error('ripast delete: cannot inspect Nuxt auto-imports without @ripast/vue. Install @ripast/vue before deleting exported declarations.')
    const scopes = nuxtAdapter.autoImportScopes(cwd)
    inspectedScopes = isInsideAutoImportScope(fromAbs, scopes)
    if (inspectedScopes) {
      const consumers = nuxtAdapter.inspectAutoImportConsumers({ cwd, symbol, fromAbs, files: candidatePaths, scopes })
      if (consumers.length)
        throw new Error(`ripast delete: cannot prove "${symbol}" is unused through Nuxt auto-imports in ${consumers.join(', ')}. Use explicit imports first.`)
    }
  }

  const server = await startTsServer(cwd)
  try {
    const vueScripts = new Map<string, string>()
    const scripts: { path: string, source: string, script: string, imports: ReturnType<typeof listImports> }[] = []
    for (const path of candidatePaths) {
      const source = readFileSync(path, 'utf8')
      let script = source
      let scriptPath = path
      if (!isVuePath(path)) {
        server.open(path, source)
      }
      else {
        const { descriptor, errors } = parse(source, { filename: path })
        if (errors.length) {
          const failure = errors[0]!
          const position = 'loc' in failure ? failure.loc?.start : undefined
          throw new Error(`ripast delete: cannot inspect ${relative(cwd, path)}:${position?.line ?? 1}:${position?.column ?? 1} because its Vue source has parse errors.`)
        }
        const blocks = [descriptor.script, descriptor.scriptSetup].filter(block => block !== null)
        for (const block of blocks) {
          const location = `${relative(cwd, path)}:${block.loc.start.line}:${block.loc.start.column}`
          if (block.src)
            throw new Error(`ripast delete: cannot inspect an external script at ${location}. Use an inline script first.`)
          if (block.lang && !['ts', 'tsx', 'js', 'jsx'].includes(block.lang))
            throw new Error(`ripast delete: cannot inspect the script language at ${location}. Use JavaScript or TypeScript first.`)
        }
        const extension = blocks.some(block => block.lang === 'tsx' || block.lang === 'jsx') ? 'tsx' : 'ts'
        scriptPath = inspectionPath(path, extension)
        const text = source.replace(/[^\r\n]/g, ' ').split('')
        for (const block of blocks) {
          for (let i = 0; i < block.content.length; i++)
            text[block.loc.start.offset + i] = block.content[i]!
        }
        script = text.join('')
        server.open(scriptPath, script)
        vueScripts.set(scriptPath, path)
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
      if (!nuxtAdapter?.isGeneratedPath?.(cwd, path)) {
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
          throw new Error(`ripast delete: cannot resolve a dynamic import at ${location}. Use a resolvable named import first.`)
        const importText = `import * as __RipastDynamic from ${script.slice(module.start, module.end)}`
        const access = `__RipastDynamic.${symbol}`
        const probe = `${importText}\n${access};\ntype __RipastDynamicType = ${access};`
        const probePath = inspectionPath(path, 'ts')
        server.open(probePath, probe)
        for (const offset of [probe.indexOf(access), probe.lastIndexOf(access)]) {
          const definitions = await server.definition(probePath, offset + '__RipastDynamic.'.length)
          if (definitions.some(site => site.path === fromAbs && site.start >= decl.start && site.start < decl.end))
            throw new Error(`ripast delete: cannot prove "${symbol}" is unused through a dynamic import at ${location}. Use named imports first.`)
        }
        const moduleOffset = parseSource(probePath, importText).program.body[0].source.start + 1
        if (!(await server.definition(probePath, moduleOffset)).length)
          throw new Error(`ripast delete: cannot resolve a dynamic import at ${location}. Use a resolvable named import first.`)
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
        const probe = `${importText}\n${access};\ntype __RipastNamespace = ${access};`
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
          throw new Error(`ripast delete: cannot prove "${symbol}" is unused through a namespace import at ${relative(cwd, path)}:${line}:${col}. Use named imports first.`)
        }
        if (!resolvedExport) {
          const moduleOffset = parseSource(probePath, importText).program.body[0].source.start + 1
          const modules = await server.definition(probePath, moduleOffset)
          if (!modules.length) {
            const { line, col } = posToLineCol(source, namespace.start)
            throw new Error(`ripast delete: cannot resolve a namespace import at ${relative(cwd, path)}:${line}:${col}. Use a resolvable import first.`)
          }
        }
        inspectedNamespaces.add(inspectionKey)
      }
    }
    const references: DeleteReference[] = []
    for (const ref of await server.references(fromAbs, decl.nameStart)) {
      // Generated references stay live evidence unless consumer inspection already proved the provider unused.
      if (nuxtAdapter?.isGeneratedPath?.(cwd, ref.path) && inspectedScopes)
        continue
      if (ref.path === fromAbs && ref.start >= decl.start && ref.start < decl.end)
        continue
      references.push({ file: relative(cwd, vueScripts.get(ref.path) ?? ref.path), line: ref.line, col: ref.col })
    }
    references.sort((a, b) => `${a.file}\0${a.line}\0${a.col}`.localeCompare(`${b.file}\0${b.line}\0${b.col}`))
    if (references.length) {
      const preview = references.slice(0, 20).map(ref => `${ref.file}:${ref.line}:${ref.col}`).join('\n')
      const extra = references.length > 20 ? `\n... ${references.length - 20} more` : ''
      throw new Error(`ripast delete: "${symbol}" still has ${references.length} reference${references.length === 1 ? '' : 's'}\n\n${preview}${extra}\n\nUse ripast scan ${symbol} to inspect usages.`)
    }

    const after = pruneUnusedImports(removeDeclaration(before, parsed.comments, decl), fromAbs)
    const changes: FileChange[] = after === before
      ? []
      : [{ path: fromAbs, rel: relative(cwd, fromAbs), before, after }]

    const regressions = verifyMode === 'none'
      ? []
      : await findRegressions(server, changes, verifyMode === 'project' ? projectScriptFiles(cwd) : [fromAbs])

    return { changes, scanned: new Set([...candidatePaths, fromAbs]).size, regressions }
  }
  finally {
    server.dispose()
  }
}

function inspectionPath(path: string, extension: 'ts' | 'tsx'): string {
  let candidate = `${path}.${randomUUID()}.${extension}`
  while (existsSync(candidate))
    candidate = `${path}.${randomUUID()}.${extension}`
  return candidate
}
