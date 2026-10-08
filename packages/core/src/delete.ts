import type { VerifyMode } from './project.ts'
import type { FileChange } from './util.ts'
import type { Regression } from './verify.ts'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { parse } from '@vue/compiler-sfc'
import { walk } from 'oxc-walker'
import { listTopLevelDeclarations, parseSource, removeDeclaration } from './declarations.ts'
import { pruneUnusedImports } from './imports.ts'
import { isVuePath, projectScriptFiles, resolveVerifyMode } from './project.ts'
import { startTsServer } from './ts-server.ts'
import { rgFiles } from './util.ts'
import { findRegressions } from './verify.ts'
import { extractTemplateExpressions } from './vue-template.ts'

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
  const candidatePaths = rgFiles(symbol, { cwd })

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

  const server = await startTsServer(cwd)
  try {
    const vueScripts = new Map<string, string>()
    for (const path of candidatePaths) {
      if (!isVuePath(path)) {
        server.open(path)
        continue
      }
      const source = readFileSync(path, 'utf8')
      const { descriptor, errors } = parse(source, { filename: path })
      if (errors.length)
        throw new Error(`ripast delete: cannot inspect ${relative(cwd, path)} because its Vue source has parse errors.`)
      const blocks = [descriptor.script, descriptor.scriptSetup].filter(block => block !== null)
      let virtualPath = `${path}.${randomUUID()}.ts`
      while (existsSync(virtualPath))
        virtualPath = `${path}.${randomUUID()}.ts`
      const text = source.replace(/[^\r\n]/g, ' ').split('')
      for (const block of blocks) {
        for (let i = 0; i < block.content.length; i++)
          text[block.loc.start.offset + i] = block.content[i]!
      }
      // Only project template member accesses. Named imports already count as
      // references, including bindings used exclusively by the template.
      for (const expression of extractTemplateExpressions(source)) {
        const program = parseSource(virtualPath, expression.code).program
        walk(program, {
          enter(node: any) {
            if (node.type !== 'MemberExpression' || node.object.type !== 'Identifier')
              return
            const name = node.computed ? node.property.value : node.property.name
            if (name !== symbol)
              return
            const start = expression.offsetInSource + node.start
            const end = expression.offsetInSource + node.end
            let prefix = start - 1
            while (prefix >= 0 && /[\r\n]/.test(text[prefix]!))
              prefix--
            text[prefix] = ';'
            for (let i = start; i < end; i++)
              text[i] = source[i]!
            let suffix = end
            while (suffix < text.length && /[\r\n]/.test(text[suffix]!))
              suffix++
            text[suffix] = ';'
          },
        })
      }
      server.open(virtualPath, text.join(''))
      vueScripts.set(virtualPath, path)
    }
    const references: DeleteReference[] = []
    for (const ref of await server.references(fromAbs, decl.nameStart)) {
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
