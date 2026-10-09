import type { EngineServices } from './engine.ts'
import process from 'node:process'
import { walk } from 'oxc-walker'
import { parseFile, posToLineCol, rgFiles } from './util.ts'

export interface NamedReexport {
  /** Name in the source module. '*' for `export *`. */
  imported: string
  /** Local re-exported name. '*' for `export *`, or namespace for `export * as X`. */
  exported: string
  /** Module specifier. */
  source: string
  typeOnly: boolean
  /** 1-based line in the file's full source (post-SFC-offset). */
  line: number
}

export interface NamedImport {
  imported: string
  local: string
  source: string
  typeOnly: boolean
  /** 1-based line in the file's full source (post-SFC-offset). */
  line: number
}

export interface DoctorIndexFile {
  file: string
  /** Top-level exported names declared in this file (excludes `default`). */
  exportedNames: Set<string>
  /** Top-level named re-exports from another module. */
  namedReexports: NamedReexport[]
  /** Imports with specifiers (for inconsistent-import-path check). */
  imports: NamedImport[]
}

export interface DoctorIndex {
  engine?: EngineServices
  files: DoctorIndexFile[]
}

export function buildDoctorIndex(opts: { engine?: EngineServices, cwd?: string, glob?: string | string[] } = {}): DoctorIndex {
  const cwd = opts.cwd ?? process.cwd()
  const files = rgFiles('', { cwd, engine: opts.engine, glob: opts.glob, fixedStrings: false, listAll: true })
  const out: DoctorIndexFile[] = []
  for (const abs of files) {
    const file = parseFile(abs, cwd, opts.engine)
    if (!file.program)
      continue
    out.push(extractFileIndex(file.rel, file.program, file.fullSource, file.scriptStart))
  }
  return { files: out, engine: opts.engine }
}

function extractFileIndex(rel: string, program: any, fullSource: string, scriptStart: number): DoctorIndexFile {
  const exportedNames = new Set<string>()
  const namedReexports: NamedReexport[] = []
  const imports: NamedImport[] = []
  const lineOf = (start: number): number => posToLineCol(fullSource, scriptStart + start).line

  for (const node of program?.body ?? []) {
    if (node.type === 'ImportDeclaration') {
      const source = node.source?.value
      if (typeof source !== 'string')
        continue
      const typeOnly = node.importKind === 'type'
      const line = lineOf(node.start)
      for (const spec of node.specifiers ?? []) {
        if (spec.type === 'ImportSpecifier') {
          imports.push({
            imported: spec.imported?.name ?? spec.imported?.value ?? spec.local?.name,
            local: spec.local?.name,
            source,
            typeOnly: typeOnly || spec.importKind === 'type',
            line,
          })
        }
        else if (spec.type === 'ImportDefaultSpecifier') {
          imports.push({ imported: 'default', local: spec.local?.name, source, typeOnly, line })
        }
        else if (spec.type === 'ImportNamespaceSpecifier') {
          imports.push({ imported: '*', local: spec.local?.name, source, typeOnly, line })
        }
      }
      if (!node.specifiers?.length)
        imports.push({ imported: '', local: '', source, typeOnly, line })
      continue
    }

    if (node.type === 'ExportAllDeclaration') {
      const source = node.source?.value
      if (typeof source !== 'string')
        continue
      const exported = node.exported?.name ?? '*'
      namedReexports.push({
        imported: '*',
        exported,
        source,
        typeOnly: node.exportKind === 'type',
        line: lineOf(node.start),
      })
      continue
    }

    if (node.type === 'ExportNamedDeclaration') {
      const source = node.source?.value
      const typeOnly = node.exportKind === 'type'
      // re-exports with `from`
      if (typeof source === 'string') {
        const line = lineOf(node.start)
        for (const spec of node.specifiers ?? []) {
          const importedName = spec.local?.name ?? spec.local?.value
          const exportedName = spec.exported?.name ?? spec.exported?.value
          if (!importedName || !exportedName)
            continue
          namedReexports.push({
            imported: importedName,
            exported: exportedName,
            source,
            typeOnly: typeOnly || spec.exportKind === 'type',
            line,
          })
          exportedNames.add(exportedName)
        }
        continue
      }
      // local exports: declaration or specifier list
      if (node.declaration) {
        collectDeclarationNames(node.declaration, exportedNames)
      }
      else {
        for (const spec of node.specifiers ?? []) {
          const exportedName = spec.exported?.name ?? spec.exported?.value
          if (exportedName)
            exportedNames.add(exportedName)
        }
      }
      continue
    }

    if (node.type === 'ExportDefaultDeclaration')
      exportedNames.add('default')
  }

  // Catch dynamic imports too for import-path consistency
  walk(program, {
    enter(node: any) {
      if (node.type === 'ImportExpression' && node.source?.type === 'Literal' && typeof node.source.value === 'string') {
        imports.push({ imported: '*', local: '', source: node.source.value, typeOnly: false, line: lineOf(node.start) })
      }
    },
  })

  return { file: rel, exportedNames, namedReexports, imports }
}

function collectDeclarationNames(decl: any, out: Set<string>): void {
  if (!decl)
    return
  if (decl.id?.name) {
    out.add(decl.id.name)
    return
  }
  if (decl.type === 'VariableDeclaration') {
    for (const d of decl.declarations ?? []) {
      if (d.id?.name)
        out.add(d.id.name)
    }
  }
}
