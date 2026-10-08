import ts from '@typescript/typescript6'
import { compileScript, compileTemplate, parse, registerTS } from '@vue/compiler-sfc'

type ScriptBlock = 'script' | 'scriptSetup'

/** Resolve only consumer-local bindings. Nuxt supplies unresolved names at runtime. */
export function unboundNuxtSymbols(path: string, source: string, symbols: Set<string>, purpose: 'Move' | 'Delete' | 'Rename' = 'Move'): Map<string, ScriptBlock> {
  const needed = new Map<string, ScriptBlock>()
  if (!path.endsWith('.vue')) {
    const { file, checker } = inspectScript(path, source)
    for (const name of unresolvedReferences(file, checker, symbols))
      needed.set(name, 'script')
    return needed
  }
  const { descriptor, errors } = parse(source, { filename: path })
  if (errors.length)
    throw errors[0]
  if (descriptor.template?.src)
    throw new Error(`ripast ${purpose.toLowerCase()}: cannot inspect an external Nuxt template in ${path}. Use an inline template first.`)
  const extension = [descriptor.script?.lang, descriptor.scriptSetup?.lang].some(lang => lang === 'tsx' || lang === 'jsx') ? 'tsx' : 'ts'
  const normal = inspectScript(`${path}.${extension}`, descriptor.script?.content ?? '')
  for (const name of unresolvedReferences(normal.file, normal.checker, symbols))
    needed.set(name, 'script')
  // Normal module bindings are visible inside setup. Setup bindings stay inside its function.
  const setup = inspectSetup(`${path}.setup.${extension}`, descriptor.script?.content ?? '', descriptor.scriptSetup?.content ?? '')
  for (const name of unresolvedReferences(setup.body, setup.checker, symbols)) {
    if (!needed.has(name))
      needed.set(name, 'scriptSetup')
  }
  if (!descriptor.template)
    return needed
  // The normal-script compiler analyzes options bindings without resolving setup macro types.
  const normalBindings = descriptor.script
    ? compileScript({ ...descriptor, scriptSetup: null }, { id: path }).bindings ?? {}
    : {}
  const compiled = compileTemplate({ id: path, filename: path, source: descriptor.template.content })
  if (compiled.errors.length)
    throw compiled.errors[0]
  const template = inspectScript(`${path}.template.ts`, compiled.code)
  const setupBody = setup.body
  let propsBindings: ReturnType<typeof compileScript>['bindings']
  let hasPropsMacro = false
  const findPropsMacro = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'defineProps')
      hasPropsMacro = true
    ts.forEachChild(node, findPropsMacro)
  }
  findPropsMacro(setup.body)
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && symbols.has(node.name.text)) {
      const context = template.checker.getSymbolAtLocation(node.expression)
      const isRenderContext = context?.declarations?.some(declaration => ts.isParameter(declaration)
        && ts.isFunctionDeclaration(declaration.parent) && declaration.parent.name?.text === 'render'
        && declaration.name.getText(template.file) === '_ctx')
      const name = node.name.text
      const local = setup.checker.resolveName(name, setupBody, ts.SymbolFlags.Value | ts.SymbolFlags.Alias, false)
      if (isRenderContext && !local && !normalBindings[name]) {
        if (hasPropsMacro && !propsBindings) {
          // Resolve macro types only when a possible prop could be captured by a new import.
          registerTS(() => ts)
          propsBindings = compileScript(descriptor, {
            id: path,
            fs: { fileExists: ts.sys.fileExists, readFile: file => ts.sys.readFile(file) },
          }).bindings ?? {}
        }
        if (propsBindings?.[name] === 'props' || propsBindings?.[name] === 'props-aliased') {
          if (purpose === 'Move' && needed.has(name))
            throw new Error(`ripast move: "${name}" is a Nuxt prop in ${path}. Use an explicit import alias before moving it.`)
        }
        else if (!needed.has(name)) {
          needed.set(name, descriptor.scriptSetup ? 'scriptSetup' : 'script')
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(template.file)
  return needed
}

export function inspectScript(path: string, source: string) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const host: ts.CompilerHost = {
    getSourceFile: name => name === path ? file : undefined,
    getDefaultLibFileName: () => '',
    writeFile: () => {},
    getCurrentDirectory: () => '/',
    getDirectories: () => [],
    fileExists: name => name === path,
    readFile: name => name === path ? source : undefined,
    getCanonicalFileName: name => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  }
  const program = ts.createProgram([path], { allowJs: true, noLib: true, noResolve: true }, host)
  return { file, checker: program.getTypeChecker() }
}

export function inspectSetup(path: string, normal: string, source: string) {
  const prefix = `${normal}\n;(function () {\n`
  const script = inspectScript(path, `${prefix}${source}\n})`)
  const statement = script.file.statements[script.file.statements.length - 1]!
  if (!ts.isExpressionStatement(statement) || !ts.isParenthesizedExpression(statement.expression)
    || !ts.isFunctionExpression(statement.expression.expression)) {
    throw new Error(`ripast: cannot inspect the Vue setup scope in ${path}`)
  }
  return { ...script, body: statement.expression.expression.body, prefixLength: prefix.length }
}

function unresolvedReferences(root: ts.Node, checker: ts.TypeChecker, symbols: Set<string>): Set<string> {
  const needed = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && node.moduleSpecifier))
      return
    if (ts.isIdentifier(node) && symbols.has(node.text)) {
      const parent = node.parent
      const property = ts.isPropertyAccessExpression(parent) && parent.name === node
      const label = (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) && parent.label === node
      if (!property && !label) {
        const binding = ts.isShorthandPropertyAssignment(parent)
          ? checker.getShorthandAssignmentValueSymbol(parent)
          : checker.getSymbolAtLocation(node)
        if (!binding)
          needed.add(node.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(root)
  return needed
}
