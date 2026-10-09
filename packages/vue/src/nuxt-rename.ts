import type { AutoImportRenamePlan, FrameworkAdapter, TextEdit } from 'ripide-api/adapter'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import ts from '@typescript/typescript6'
import { compileScript, compileTemplate, parse, registerTS } from '@vue/compiler-sfc'
import { applyTextEdits } from 'ripide-api/adapter'
import { loadNuxtBindingNames, nuxtConsumerContext, nuxtImportMetadataPaths } from './nuxt-bindings.ts'
import { inspectScript, inspectSetup } from './nuxt-consumers.ts'
import { isGeneratedNuxtPath } from './nuxt-paths.ts'
import { nuxtRenameVerificationChanges } from './nuxt-rename-verification.ts'
import { rgVueFiles } from './source.ts'

interface Reference {
  name: string
  start: number
  end: number
  free: boolean
  shorthand: boolean
  vBindShorthand: boolean
}

export const planNuxtAutoImportRename: NonNullable<FrameworkAdapter['planAutoImportRename']> = ({ cwd, from, to, sites }) => {
  const plans = new Map<string, { before: string, references: Reference[], edits: TextEdit[] }>()
  const changes: AutoImportRenamePlan['changes'] = []
  const unrelatedGeneratedImports = new Set<string>()
  const providers = new Set(sites.map(site => site.filePath))
  const bindings = new Map<string, ReturnType<typeof loadNuxtBindingNames>[]>()
  let runtimeBinding: boolean | undefined
  for (const path of rgVueFiles('', { cwd, listAll: true })) {
    if (providers.has(path) || isGeneratedNuxtPath(cwd, path))
      continue
    const before = readFileSync(path, 'utf8')
    if (!before.includes(from) && !before.includes('\\u'))
      continue
    const references = renameReferences(path, before, new Set([from]))
    const importEdits = generatedImportEdits(path, before, from, to)
    if (!references.length && !importEdits.length)
      continue
    const context = nuxtConsumerContext(path, cwd)
    const key = nuxtImportMetadataPaths(context, path).join('|')
    let active = bindings.get(key)
    if (!active) {
      active = sites.map(site => loadNuxtBindingNames(context, from, site.filePath, path))
      bindings.set(key, active)
    }
    if (active.some(binding => binding._tag === 'Unknown')) {
      if (!references.some(reference => reference.free) && !importEdits.length) {
        plans.set(path, { before, references, edits: [] })
        continue
      }
      throw new Error(`ripide rename: cannot resolve auto-import metadata for "${from}" in ${context}. Run Nuxt prepare first.`)
    }
    const ownsName = active.some(binding => binding._tag === 'Resolved' && binding.names.includes(from))
    if (!ownsName && importEdits.length)
      unrelatedGeneratedImports.add(path)
    const edits = ownsName
      ? [...references.filter(reference => reference.free).map((reference) => {
          const replacement = reference.vBindShorthand
            ? `${before.slice(reference.start, reference.end)}="${to}"`
            : reference.shorthand ? `${before.slice(reference.start, reference.end)}: ${to}` : to
          return {
            start: reference.start,
            end: reference.end,
            replacement,
            targetOffset: reference.vBindShorthand ? replacement.length - to.length - 1 : replacement.length - to.length,
          }
        }), ...importEdits].sort((a, b) => a.start - b.start)
      : []
    if (edits.length) {
      runtimeBinding ??= hasLibraryValue(to)
      if (runtimeBinding)
        throw new Error(`ripide rename: "${to}" has a runtime binding. Use an explicit import alias first.`)
      if (hasGeneratedName(context, to, path))
        throw new Error(`ripide rename: "${to}" has a Nuxt binding in ${context}. Use an explicit import alias first.`)
      const after = applyTextEdits(before, edits)
      const freeTargets = new Set(renameReferences(path, after, new Set([to])).filter(reference => reference.free).map(reference => reference.start))
      let shift = 0
      for (const edit of edits) {
        const targetStart = edit.start + shift + edit.targetOffset
        if (!importEdits.includes(edit) && !freeTargets.has(targetStart))
          throw new Error(`ripide rename: "${to}" would capture a Nuxt reference in ${relative(cwd, path)}. Use an explicit import alias first.`)
        shift += edit.replacement.length - (edit.end - edit.start)
      }
      changes.push({ path, rel: relative(cwd, path), before, after })
    }
    plans.set(path, { before, references, edits })
  }
  return {
    changes,
    unrelatedGeneratedImports,
    verificationChanges: finalChanges => nuxtRenameVerificationChanges(cwd, new Set([...plans.keys(), ...sites.map(site => site.filePath)].map(path => nuxtConsumerContext(path, cwd))), providers, from, to, finalChanges),
    transformEdits(path, source, semanticEdits) {
      const plan = plans.get(path)
      if (!plan)
        return semanticEdits
      if (source !== plan.before)
        throw new Error(`ripide rename: source changed while planning ${relative(cwd, path)}`)
      // Semantic edits still own explicit imports. Local and implicit references use this scope plan.
      return [...semanticEdits.filter(edit => ![...plan.references, ...plan.edits].some(reference => edit.start < reference.end && edit.end > reference.start)), ...plan.edits]
    },
  }
}

/** Keep local aliases stable when the generated barrel exports a renamed provider. */
function generatedImportEdits(path: string, source: string, from: string, to: string): (TextEdit & { targetOffset: number })[] {
  const out: (TextEdit & { targetOffset: number })[] = []
  const inspect = (content: string, offset: number): void => {
    const file = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true)
    for (const statement of file.statements) {
      if ((!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement))
        || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier) || statement.moduleSpecifier.text !== '#imports') {
        continue
      }
      const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : statement.exportClause
      if (!bindings || (!ts.isNamedImports(bindings) && !ts.isNamedExports(bindings)))
        continue
      for (const element of bindings.elements) {
        const imported = element.propertyName ?? element.name
        if (imported.text !== from)
          continue
        const quoted = ts.isStringLiteral(imported)
        const replaceContent = quoted && !!element.propertyName
        const renamed = quoted ? `${content[imported.getStart(file)]}${to}${content[imported.getStart(file)]}` : to
        const replacement = element.propertyName ? to : `${renamed} as ${element.name.getText(file)}`
        out.push({ start: imported.getStart(file) + offset + Number(replaceContent), end: imported.end + offset - Number(replaceContent), replacement, targetOffset: 0 })
      }
    }
  }
  if (path.endsWith('.vue')) {
    const { descriptor } = parse(source, { filename: path })
    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (block)
        inspect(block.content, block.loc.start.offset)
    }
  }
  else {
    inspect(source, 0)
  }
  return out
}

function hasLibraryValue(name: string): boolean {
  const path = '/__ripide_globals__.ts'
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.Latest, types: [] }
  const host = ts.createCompilerHost(options)
  const getSourceFile = host.getSourceFile
  host.getSourceFile = (fileName, ...args) => fileName === path
    ? ts.createSourceFile(path, '', ts.ScriptTarget.Latest, true)
    : getSourceFile(fileName, ...args)
  const checker = ts.createProgram([path], options, host).getTypeChecker()
  return Boolean(checker.resolveName(name, undefined, ts.SymbolFlags.Value, false))
}

function renameReferences(path: string, source: string, names: Set<string>): Reference[] {
  const out: Reference[] = []
  const inspect = (file: ts.SourceFile, checker: ts.TypeChecker, root: ts.Node, offset: number): void => {
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier))
        return
      if (ts.isIdentifier(node) && names.has(node.text)) {
        const parent = node.parent
        const property = (ts.isPropertyAccessExpression(parent) && parent.name === node)
          || ((ts.isPropertyAssignment(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === node)
          || (ts.isJsxAttribute(parent) && parent.name === node)
        const label = (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node
        const shorthand = ts.isShorthandPropertyAssignment(parent)
        const binding = shorthand ? checker.getShorthandAssignmentValueSymbol(parent) : checker.getSymbolAtLocation(node)
        const imported = binding?.declarations?.some(declaration => ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration))
        if (!property && !label && (!imported || isGeneratedImportBinding(binding)))
          out.push({ name: node.text, start: node.getStart(file) + offset, end: node.end + offset, free: !binding, shorthand, vBindShorthand: false })
      }
      ts.forEachChild(node, visit)
    }
    visit(root)
  }
  if (!path.endsWith('.vue')) {
    const script = inspectScript(path, source)
    inspect(script.file, script.checker, script.file, 0)
    return out
  }
  const { descriptor, errors } = parse(source, { filename: path })
  if (errors.length)
    throw errors[0]
  if (descriptor.template?.src)
    throw new Error(`ripide rename: cannot inspect an external Nuxt template in ${path}. Use an inline template first.`)
  if (descriptor.script?.src || descriptor.scriptSetup?.src)
    throw new Error(`ripide rename: cannot inspect an external Nuxt script in ${path}. Use an inline script first.`)
  if (descriptor.template?.lang && descriptor.template.lang !== 'html')
    throw new Error(`ripide rename: cannot inspect the Nuxt template language in ${path}. Use an HTML template first.`)
  const extension = [descriptor.script?.lang, descriptor.scriptSetup?.lang].some(lang => lang === 'tsx' || lang === 'jsx') ? 'tsx' : 'ts'
  const normal = inspectScript(`${path}.${extension}`, descriptor.script?.content ?? '')
  if (descriptor.script)
    inspect(normal.file, normal.checker, normal.file, descriptor.script.loc.start.offset)
  const setup = inspectSetup(`${path}.setup.${extension}`, descriptor.script?.content ?? '', descriptor.scriptSetup?.content ?? '')
  if (descriptor.scriptSetup)
    inspect(setup.file, setup.checker, setup.body, descriptor.scriptSetup.loc.start.offset - setup.prefixLength)
  if (!descriptor.template)
    return out
  const normalBindings = descriptor.script ? compileScript({ ...descriptor, scriptSetup: null }, { id: path }).bindings ?? {} : {}
  const setupBody = setup.body
  let propsBindings: ReturnType<typeof compileScript>['bindings']
  let hasPropsMacro = false
  const findProps = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineProps')
      hasPropsMacro = true
    ts.forEachChild(node, findProps)
  }
  findProps(setup.body)
  const compiled = compileTemplate({ id: path, filename: path, source: descriptor.template.content })
  if (compiled.errors.length)
    throw compiled.errors[0]
  const seen = new Set<object>()
  const templateReferences = new Map<number, Reference>()
  const visitTemplate = (node: any, parent?: any, index?: number): void => {
    if (!node || typeof node !== 'object' || seen.has(node))
      return
    seen.add(node)
    if (node.type === 4 && typeof node.content === 'string' && !node.isStatic && node.loc?.source) {
      const name = node.content.startsWith('_ctx.') ? node.content.slice(5) : node.content
      if (names.has(name)) {
        const raw = descriptor.template!.content.slice(node.loc.start.offset, node.loc.end.offset)
        const token = ts.createSourceFile('reference.ts', raw, ts.ScriptTarget.Latest, true).statements[0]
        if (token && ts.isExpressionStatement(token) && ts.isIdentifier(token.expression) && token.expression.text === name) {
          const local = setup.checker.resolveName(name, setupBody, ts.SymbolFlags.Value | ts.SymbolFlags.Alias, false)
          if (local?.declarations?.some(declaration => ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)) && !isGeneratedImportBinding(local))
            return
          if (hasPropsMacro && !propsBindings && !local && !normalBindings[name]) {
            registerTS(() => ts)
            propsBindings = compileScript(descriptor, { id: path, fs: { fileExists: ts.sys.fileExists, readFile: file => ts.sys.readFile(file) } }).bindings ?? {}
          }
          const start = descriptor.template!.loc.start.offset + node.loc.start.offset
          const shorthand = parent?.type === 8 && index !== undefined && typeof parent.children[index - 1] === 'string'
            && parent.children[index - 1].endsWith(`${raw}: `)
          const vBindShorthand = descriptor.template!.content[node.loc.start.offset - 1] === ':'
          templateReferences.set(start, {
            name,
            start: start - Number(vBindShorthand),
            end: descriptor.template!.loc.start.offset + node.loc.end.offset,
            free: node.content === `_ctx.${name}` && !local && !normalBindings[name] && propsBindings?.[name] !== 'props' && propsBindings?.[name] !== 'props-aliased',
            shorthand,
            vBindShorthand,
          })
        }
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'ast' || key === 'loc')
        continue
      if (Array.isArray(value))
        value.forEach((child, childIndex) => visitTemplate(child, key === 'children' ? node : undefined, childIndex))
      else
        visitTemplate(value)
    }
  }
  visitTemplate(compiled.ast)
  out.push(...templateReferences.values())
  return out.sort((a, b) => a.start - b.start)
}

function isGeneratedImportBinding(binding: ts.Symbol | undefined): boolean {
  return binding?.declarations?.some((declaration) => {
    if (!ts.isImportSpecifier(declaration))
      return false
    const statement = declaration.parent.parent.parent
    return ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text === '#imports'
  }) ?? false
}

function hasGeneratedName(cwd: string, name: string, consumerPath: string): boolean {
  for (const path of nuxtImportMetadataPaths(cwd, consumerPath)) {
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    let found = false
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
        found = true
      ts.forEachChild(node, visit)
    }
    for (const statement of file.statements) {
      if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name) && statement.name.text === 'global')
        visit(statement)
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)
        && statement.exportClause.elements.some(element => element.name.text === name)) {
        found = true
      }
    }
    if (found)
      return true
  }
  return false
}
