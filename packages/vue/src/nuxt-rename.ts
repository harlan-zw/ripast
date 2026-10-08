import type { AutoImportRenamePlan, FrameworkAdapter, TextEdit } from '@ripast/core/adapter'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { applyTextEdits, rgFiles } from '@ripast/core/adapter'
import ts from '@typescript/typescript6'
import { compileScript, compileTemplate, parse, registerTS } from '@vue/compiler-sfc'
import { loadNuxtBindingNames, nuxtConsumerContext } from './nuxt-bindings.ts'
import { inspectScript, inspectSetup } from './nuxt-consumers.ts'
import { isGeneratedNuxtPath } from './nuxt-paths.ts'

interface Reference {
  name: string
  start: number
  end: number
  free: boolean
  shorthand: boolean
}

export const planNuxtAutoImportRename: NonNullable<FrameworkAdapter['planAutoImportRename']> = ({ cwd, from, to, sites }) => {
  const plans = new Map<string, { before: string, references: Reference[], edits: TextEdit[] }>()
  const changes: AutoImportRenamePlan['changes'] = []
  const providers = new Set(sites.map(site => site.filePath))
  const bindings = new Map<string, ReturnType<typeof loadNuxtBindingNames>[]>()
  let runtimeBinding: boolean | undefined
  for (const path of rgFiles('', { cwd, listAll: true })) {
    if (providers.has(path) || isGeneratedNuxtPath(cwd, path))
      continue
    const before = readFileSync(path, 'utf8')
    if (!before.includes(from) && !before.includes('\\u'))
      continue
    const references = renameReferences(path, before, new Set([from]))
    if (!references.length)
      continue
    const context = nuxtConsumerContext(path, cwd)
    let active = bindings.get(context)
    if (!active) {
      active = sites.map(site => loadNuxtBindingNames(context, from, site.filePath))
      bindings.set(context, active)
    }
    if (active.some(binding => binding._tag === 'Unknown'))
      throw new Error(`ripast rename: cannot resolve auto-import metadata for "${from}" in ${context}. Run Nuxt prepare first.`)
    const ownsName = active.some(binding => binding._tag === 'Resolved' && binding.names.includes(from))
    const edits = ownsName
      ? references.filter(reference => reference.free).map(reference => ({
          start: reference.start,
          end: reference.end,
          replacement: reference.shorthand ? `${before.slice(reference.start, reference.end)}: ${to}` : to,
        }))
      : []
    if (edits.length) {
      runtimeBinding ??= hasLibraryValue(to)
      if (runtimeBinding)
        throw new Error(`ripast rename: "${to}" has a runtime binding. Use an explicit import alias first.`)
      if (hasGeneratedName(context, to))
        throw new Error(`ripast rename: "${to}" has a Nuxt binding in ${context}. Use an explicit import alias first.`)
      const after = applyTextEdits(before, edits)
      const freeTargets = new Set(renameReferences(path, after, new Set([to])).filter(reference => reference.free).map(reference => reference.start))
      let shift = 0
      for (const edit of edits) {
        const targetStart = edit.start + shift + edit.replacement.length - to.length
        if (!freeTargets.has(targetStart))
          throw new Error(`ripast rename: "${to}" would capture a Nuxt reference in ${relative(cwd, path)}. Use an explicit import alias first.`)
        shift += edit.replacement.length - (edit.end - edit.start)
      }
      changes.push({ path, rel: relative(cwd, path), before, after })
    }
    plans.set(path, { before, references, edits })
  }
  return {
    changes,
    transformEdits(path, source, semanticEdits) {
      const plan = plans.get(path)
      if (!plan)
        return semanticEdits
      if (source !== plan.before)
        throw new Error(`ripast rename: source changed while planning ${relative(cwd, path)}`)
      // Semantic edits still own explicit imports. Local and implicit references use this scope plan.
      return [...semanticEdits.filter(edit => !plan.references.some(reference => edit.start < reference.end && edit.end > reference.start)), ...plan.edits]
    },
  }
}

function hasLibraryValue(name: string): boolean {
  const path = '/__ripast_globals__.ts'
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
        if (!property && !label && !imported)
          out.push({ name: node.text, start: node.getStart(file) + offset, end: node.end + offset, free: !binding, shorthand })
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
    throw new Error(`ripast rename: cannot inspect an external Nuxt template in ${path}. Use an inline template first.`)
  if (descriptor.script?.src || descriptor.scriptSetup?.src)
    throw new Error(`ripast rename: cannot inspect an external Nuxt script in ${path}. Use an inline script first.`)
  if (descriptor.template?.lang && descriptor.template.lang !== 'html')
    throw new Error(`ripast rename: cannot inspect the Nuxt template language in ${path}. Use an HTML template first.`)
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
          if (local?.declarations?.some(declaration => ts.isImportSpecifier(declaration) || ts.isImportClause(declaration) || ts.isNamespaceImport(declaration)))
            return
          if (hasPropsMacro && !propsBindings && !local && !normalBindings[name]) {
            registerTS(() => ts)
            propsBindings = compileScript(descriptor, { id: path, fs: { fileExists: ts.sys.fileExists, readFile: file => ts.sys.readFile(file) } }).bindings ?? {}
          }
          const start = descriptor.template!.loc.start.offset + node.loc.start.offset
          const shorthand = parent?.type === 8 && index !== undefined && typeof parent.children[index - 1] === 'string'
            && parent.children[index - 1].endsWith(`${raw}: `)
          templateReferences.set(start, {
            name,
            start,
            end: descriptor.template!.loc.start.offset + node.loc.end.offset,
            free: node.content === `_ctx.${name}` && !local && !normalBindings[name] && propsBindings?.[name] !== 'props' && propsBindings?.[name] !== 'props-aliased',
            shorthand,
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

function hasGeneratedName(cwd: string, name: string): boolean {
  for (const path of [join(cwd, '.nuxt/imports.d.ts'), join(cwd, '.nuxt/types/imports.d.ts')]) {
    if (!existsSync(path))
      continue
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
