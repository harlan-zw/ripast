import type { ImportBinding, ImportInfo } from './imports.ts'
import type { TsServer } from './ts-server.ts'
import type { TextEdit } from './util.ts'
import { readFileSync } from 'node:fs'
import { walk } from 'oxc-walker'
import { listTopLevelDeclarations } from './declarations.ts'
import { computeSpecifier, isImportEmpty, listImports, localNameOf, parseProgram, renderImport } from './imports.ts'
import { applyTextEdits } from './util.ts'

interface ExportIdentity {
  definitions: Set<string>
  isTypeOnly: boolean
}

interface SourceReplacement {
  filePath: string
  importName: string
  isTypeOnly: boolean
  declarationFiles: readonly string[]
}

/** Resolve exported identities before edits. Imported aliases retain their local names. */
export async function createSourceReplacement(server: TsServer, sourcePath: string, from: string, target: SourceReplacement, projectStyle: (path: string) => string, targetImport?: string) {
  const cache = new Map<string, Map<string, ExportIdentity>>()
  const visiting = new Set<string>()
  const key = (site: { path: string, start: number, end: number }) => `${site.path}:${site.start}:${site.end}`
  const definitions = async (path: string, offset: number) => new Set((await server.definition(path, offset)).map(key))
  const identityAt = async (path: string, offset: number, explicitType = false): Promise<ExportIdentity> => {
    const sites = await server.definition(path, offset)
    const isTypeOnly = explicitType || (sites.length > 0 && sites.every((site) => {
      const declaration = listTopLevelDeclarations(parseProgram(site.path, server.textOf(site.path))).find(item => item.start <= site.start && site.start < item.end)
      return declaration?.kind === 'type' || declaration?.kind === 'interface'
    }))
    return { definitions: new Set(sites.map(key)), isTypeOnly }
  }
  const modulePath = async (path: string, offset: number) => {
    const sites = await server.definition(path, offset)
    const paths = [...new Set(sites.map(site => site.path))]
    if (paths.length !== 1)
      throw new Error(`ripide replace: cannot resolve one source module in ${path}`)
    return paths[0]
  }
  const exportsOf = async (path: string): Promise<Map<string, ExportIdentity>> => {
    const cached = cache.get(path)
    if (cached)
      return cached
    if (visiting.has(path))
      throw new Error(`ripide replace: source replacement cannot resolve a cyclic barrel in ${path}`)
    visiting.add(path)
    const text = readFileSync(path, 'utf8')
    const program = parseProgram(path, text)
    server.open(path, text)
    const explicit = new Map<string, ExportIdentity>()
    const stars: { path: string, isTypeOnly: boolean }[] = []
    for (const declaration of listTopLevelDeclarations(program)) {
      if (declaration.exported)
        explicit.set(declaration.isDefault ? 'default' : declaration.name, await identityAt(path, declaration.nameStart))
    }
    for (const statement of program.body) {
      if (statement.type === 'ExportNamedDeclaration' && !statement.declaration) {
        for (const specifier of statement.specifiers)
          explicit.set(specifier.exported.name ?? specifier.exported.value, await identityAt(path, specifier.local.start, statement.exportKind === 'type' || specifier.exportKind === 'type'))
      }
      if (statement.type === 'ExportDefaultDeclaration' && statement.declaration.type === 'Identifier')
        explicit.set('default', await identityAt(path, statement.declaration.start))
      if (statement.type === 'ExportAllDeclaration' && !statement.exported)
        stars.push({ path: await modulePath(path, statement.source.start + 1), isTypeOnly: statement.exportKind === 'type' })
    }
    const result = new Map(explicit)
    for (const star of stars) {
      for (const [name, identity] of await exportsOf(star.path)) {
        if (name === 'default' || explicit.has(name))
          continue
        const existing = result.get(name)
        result.set(name, { definitions: new Set([...existing?.definitions ?? [], ...identity.definitions]), isTypeOnly: (identity.isTypeOnly || star.isTypeOnly) && (existing?.isTypeOnly ?? true) })
      }
    }
    visiting.delete(path)
    cache.set(path, result)
    return result
  }
  const source = (await exportsOf(sourcePath)).get(from)
  if (!source?.definitions.size)
    throw new Error(`ripide replace: no resolved export "${from}" in ${sourcePath}`)
  if (source.definitions.size !== 1)
    throw new Error(`ripide replace: source export "${from}" has multiple definitions in ${sourcePath}`)
  const matches = (identity: Pick<ExportIdentity, 'definitions'>) => {
    const selected = [...identity.definitions].some(definition => source.definitions.has(definition))
    if (selected && [...identity.definitions].some(definition => !source.definitions.has(definition)))
      throw new Error(`ripide replace: source export "${from}" has ambiguous providers`)
    return selected
  }
  const matchesAt = async (path: string, offset: number) => matches({ definitions: await definitions(path, offset) })
  // A wrapper can reach the old provider through several imports and barrels.
  // Retargeting any module in that closure can introduce runtime recursion.
  const dependencies = new Set<string>()
  const queue = [...target.declarationFiles]
  for (const path of queue) {
    if (dependencies.has(path))
      continue
    dependencies.add(path)
    if (/\.d\.[cm]?ts$/.test(path))
      throw new Error(`ripide replace: cannot prove a declaration-only replacement dependency in ${path}`)
    const text = readFileSync(path, 'utf8')
    server.open(path, text)
    const program = parseProgram(path, text)
    walk(program, {
      enter(node: any) {
        if (node.type === 'ImportExpression' || (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require'))
          throw new Error(`ripide replace: cannot prove a dynamic replacement dependency in ${path}`)
      },
    })
    for (const statement of program.body) {
      if (!statement.source || !['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(statement.type))
        continue
      const sites = await server.definition(path, statement.source.start + 1)
      if (!sites.length)
        throw new Error(`ripide replace: cannot resolve a replacement dependency in ${path}`)
      for (const site of sites)
        queue.push(site.path)
    }
  }
  return async (path: string, text: string): Promise<string> => {
    const program = parseProgram(path, text)
    server.open(path, text)
    const imports = listImports(text, path, program)
    const edits: TextEdit[] = []
    const additions: string[] = []
    const relativeStyle = (specifier: string) => specifier.startsWith('.') && !/[?#]/.test(specifier) && !/\.(?:json|vue|css|scss|sass|less|svg|png|jpe?g|webp|woff2?|wasm)$/.test(specifier)
    const importPath = (style: string) => targetImport ?? computeSpecifier(path, target.filePath, relativeStyle(style) ? style : imports.find(imp => relativeStyle(imp.specifier))?.specifier ?? projectStyle(path))
    for (const imp of imports) {
      if (imp.namespaceImport) {
        const module = await modulePath(path, imp.namespaceImport.start)
        if ([...(await exportsOf(module)).values()].some(matches))
          throw new Error(`ripide replace: source replacement cannot retarget namespace import "${imp.namespaceImport.name}" in ${path}`)
      }
      const selected: ImportBinding[] = []
      for (const binding of imp.named) {
        if (await matchesAt(path, binding.localStart))
          selected.push(binding)
      }
      const selectedDefault = imp.defaultImport && await matchesAt(path, imp.defaultImport.start)
      if (!selected.length && !selectedDefault)
        continue
      const current: ImportInfo = { ...imp, named: imp.named.filter(binding => !selected.includes(binding)), defaultImport: selectedDefault ? undefined : imp.defaultImport }
      edits.push({ start: imp.start, end: imp.end, replacement: isImportEmpty(current) ? '' : renderImport(current) })
      const bindings = selected.map(binding => ({ local: localNameOf(binding), type: imp.isTypeOnly || binding.isTypeOnly || target.isTypeOnly }))
      if (selectedDefault)
        bindings.push({ local: imp.defaultImport!.name, type: imp.isTypeOnly || target.isTypeOnly })
      for (const binding of bindings) {
        additions.push(renderImport({ ...imp, specifier: importPath(imp.specifier), isTypeOnly: binding.type, named: [{ name: target.importName, alias: binding.local === target.importName ? undefined : binding.local, isTypeOnly: false, localStart: -1 }], defaultImport: undefined, namespaceImport: undefined, sideEffectOnly: false }))
      }
    }
    const explicitNames = new Set<string>()
    for (const declaration of listTopLevelDeclarations(program)) {
      if (declaration.exported)
        explicitNames.add(declaration.isDefault ? 'default' : declaration.name)
    }
    for (const statement of program.body) {
      if (statement.type === 'ExportNamedDeclaration') {
        for (const specifier of statement.specifiers)
          explicitNames.add(specifier.exported.name ?? specifier.exported.value)
      }
    }
    const exported = await exportsOf(path)
    const forwarded = new Set<string>()
    for (const statement of program.body) {
      if (statement.type === 'ExportNamedDeclaration' && statement.source) {
        const selected: any[] = []
        for (const specifier of statement.specifiers) {
          if (await matchesAt(path, specifier.local.start))
            selected.push(specifier)
        }
        if (!selected.length)
          continue
        const remaining = statement.specifiers.filter((specifier: any) => !selected.includes(specifier))
        const prefix = statement.exportKind === 'type' ? 'export type' : 'export'
        const tail = text.slice(statement.source.start, statement.source.end)
        edits.push({ start: statement.start, end: statement.end, replacement: remaining.length ? `${prefix} { ${remaining.map((specifier: any) => text.slice(specifier.start, specifier.end)).join(', ')} } from ${tail}` : '' })
        for (const specifier of selected) {
          const name = specifier.exported.name ?? specifier.exported.value
          const type = (await identityAt(path, specifier.local.start, statement.exportKind === 'type' || specifier.exportKind === 'type')).isTypeOnly || target.isTypeOnly
          const exportedName = text.slice(specifier.exported.start, specifier.exported.end)
          additions.push(`export${type ? ' type' : ''} { ${target.importName}${target.importName === name ? '' : ` as ${exportedName}`} } from ${JSON.stringify(importPath(statement.source.value))}`)
        }
      }
      if (statement.type === 'ExportAllDeclaration') {
        const module = await modulePath(path, statement.source.start + 1)
        const identities = await exportsOf(module)
        if (statement.exported && [...identities.values()].some(matches))
          throw new Error(`ripide replace: source replacement cannot retarget an exported namespace in ${path}`)
        for (const [name] of identities) {
          if (name === 'default' || explicitNames.has(name) || forwarded.has(name))
            continue
          const identity = exported.get(name)
          if (!identity || !matches(identity))
            continue
          forwarded.add(name)
          additions.push(`export${target.isTypeOnly || identity.isTypeOnly || statement.exportKind === 'type' ? ' type' : ''} { ${target.importName}${name === target.importName ? '' : ` as ${JSON.stringify(name)}`} } from ${JSON.stringify(importPath(statement.source.value))}`)
        }
      }
    }
    if (!edits.length && !additions.length)
      return text
    if (dependencies.has(path))
      throw new Error(`ripide replace: source replacement would retarget a replacement dependency in ${path}`)
    return `${[...new Set(additions)].join('\n')}\n${applyTextEdits(text, edits)}`
  }
}
