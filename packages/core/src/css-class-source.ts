import type { RenameMap } from './css-class-token.ts'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { parseSync } from 'oxc-parser'
import { completeClassBounds, rewriteClassString, visitClassTokens } from './css-class-token.ts'
import { applyTextEdits, parseFile, rgFiles, rgFilesMany } from './util.ts'

export interface CssClassSourceOptions {
  cwd?: string
  glob?: string | string[]
}

export interface CssClassSourceFile {
  abs: string
  rel: string
  source: string
  cwd: string
}

const CSS_EXTS = ['.css', '.scss', '.sass', '.less', '.postcss', '.pcss']
const CODE_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

function defaultCssClassGlobs(): string[] {
  return [...CODE_EXTS, '.vue', ...CSS_EXTS].map(e => `*${e}`)
}

export function readCssClassSourceFiles(opts: CssClassSourceOptions = {}): CssClassSourceFile[] {
  const cwd = opts.cwd ?? process.cwd()
  const glob = opts.glob ?? defaultCssClassGlobs()
  return readSourceFiles(rgFiles('', { cwd, glob, fixedStrings: false, listAll: true }), cwd)
}

export function readCssClassSourceFilesForMap(map: RenameMap, opts: CssClassSourceOptions = {}): CssClassSourceFile[] {
  if (!map.size)
    return []
  const cwd = opts.cwd ?? process.cwd()
  const glob = opts.glob ?? defaultCssClassGlobs()
  // Escapes and static expressions can split a class key across source text.
  return readSourceFiles(rgFilesMany([...map.keys(), '\\', '&', '+', '`'], { cwd, glob }), cwd)
}

export function visitCssClassTokensInFile(file: CssClassSourceFile, visit: (bare: string) => void): void {
  if (isVue(file.abs)) {
    visitVue(file, text => visitClassTokens(text, visit))
  }
  else if (isCss(file.abs)) {
    visitCss(file.source, visit, cssSyntax(file.abs))
  }
  else {
    visitScript(file, text => visitClassTokens(text, visit))
  }
}

export function rewriteCssClassTokensInFile(file: CssClassSourceFile, map: RenameMap): string {
  if (isVue(file.abs))
    return rewriteVue(file, map)
  if (isCss(file.abs))
    return rewriteCss(file.source, map, cssSyntax(file.abs))
  return rewriteScript(file, map)
}

function readSourceFiles(files: string[], cwd: string): CssClassSourceFile[] {
  const out: CssClassSourceFile[] = []
  for (const abs of files) {
    if (!isCssClassSourcePath(abs))
      continue
    const source = safeRead(abs)
    if (source == null)
      continue
    out.push({ abs, rel: abs.slice(cwd.length + 1), source, cwd })
  }
  return out
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  }
  catch {
    return null
  }
}

function isCss(path: string): boolean {
  return CSS_EXTS.some(ext => path.endsWith(ext))
}

function isVue(path: string): boolean {
  return path.endsWith('.vue')
}

function isCssClassSourcePath(path: string): boolean {
  return isVue(path) || isCss(path) || CODE_EXTS.some(ext => path.endsWith(ext))
}

function visitScript(file: CssClassSourceFile, visit: (text: string) => void): void {
  const parsed = parseFile(file.abs, file.cwd)
  if (parsed.program)
    visitProgramClassStrings(parsed.program, visit)
}

type ScriptStringSite = (
  | { _tag: 'Literal', node: any }
  | { _tag: 'Template', node: any, templateKind: 'cooked' | 'raw' | 'unknown' }
  | { _tag: 'ObjectKey', node: any, shorthand: boolean }
  | { _tag: 'Concatenation', node: any }
) & { value: string, bounds: { start: number, end: number } }

function classText(value: string): { value: string, bounds: { start: number, end: number } } {
  return { value, bounds: { start: 0, end: value.length } }
}

function visitProgramClassStrings(program: any, visit: (text: string) => void): void {
  visitProgramClassStringSites(program, (site) => {
    visit(site.value.slice(site.bounds.start, site.bounds.end))
  })
}

function visitProgramClassStringSites(program: any, visit: (site: ScriptStringSite) => void): void {
  walkProgram(program, false, false, visit)
}

function visitVue(file: CssClassSourceFile, visit: (text: string) => void): void {
  const parsed = parseFile(file.abs, file.cwd)
  if (parsed.program)
    visitProgramClassStrings(parsed.program, visit)
  visitVueTemplateClassAttrs(file.source, visit)
  visitVueStyleBlocks(file.source, (body, lang) => visitCss(body, text => visitClassTokens(text, visit), cssSyntax(lang)))
}

const CLASS_CALLEE_RE = /^(?:cva|cn|clsx|classNames|classnames|twJoin|twMerge)$/
const CLASS_ATTR_RE_SCRIPT = /^(?:class|className)$/
const CLASS_NAME_RE = /(?:^|[-_])(?:cls|class|classes|className|classList|activeClass|inactiveClass|exactActiveClass|ui|slots|variants|compoundVariants|defaultVariants)(?:$|[-_])/i
const CLASS_OBJECT_NAME_RE = /^(?:cls|class|classes|className|classList)$/i

function walkProgram(node: any, classContext: boolean, classObjectKeyContext: boolean, visit: (site: ScriptStringSite) => void): void {
  if (!node || typeof node !== 'object')
    return

  if (node.type === 'ConditionalExpression') {
    walkProgram(node.test, false, false, visit)
    walkProgram(node.consequent, classContext, classObjectKeyContext, visit)
    walkProgram(node.alternate, classContext, classObjectKeyContext, visit)
    return
  }

  if (node.type === 'LogicalExpression') {
    walkProgram(node.left, node.operator === '&&' ? false : classContext, node.operator === '&&' ? false : classObjectKeyContext, visit)
    walkProgram(node.right, classContext, classObjectKeyContext, visit)
    return
  }

  if (node.type === 'BinaryExpression') {
    const concatenation = node.operator === '+' && classContext
    if (!concatenation) {
      walkProgram(node.left, false, false, visit)
      walkProgram(node.right, false, false, visit)
      return
    }
    const value = staticClassString(node)
    if (value !== undefined) {
      visit({ _tag: 'Concatenation', node, ...classText(value) })
      return
    }
    walkProgram(node.left, concatenation, false, boundaryVisit(visit, hasClassBoundary(node.right, 'start'), 'end'))
    walkProgram(node.right, concatenation, false, boundaryVisit(visit, hasClassBoundary(node.left, 'end'), 'start'))
    return
  }

  if (node.type === 'TemplateLiteral' || node.type === 'TaggedTemplateExpression') {
    const tagged = node.type === 'TaggedTemplateExpression'
    const template = tagged ? node.quasi : node
    const staticValue = !tagged && classContext && template.expressions.length ? staticClassString(template) : undefined
    if (staticValue !== undefined) {
      visit({ _tag: 'Concatenation', node, ...classText(staticValue) })
      return
    }
    const rawTag = tagged && node.tag.type === 'MemberExpression' && !node.tag.computed && node.tag.object?.name === 'String' && node.tag.property?.name === 'raw'
    const templateKind = tagged ? rawTag ? 'raw' : 'unknown' : 'cooked'
    if (classContext) {
      for (const [index, quasi] of template.quasis.entries()) {
        const value = templateKind === 'cooked' ? quasi.value.cooked : quasi.value.raw
        if (typeof value !== 'string')
          continue
        const startSafe = index === 0 || hasClassBoundary(template.expressions[index - 1], 'end')
        const endSafe = index === template.quasis.length - 1 || hasClassBoundary(template.expressions[index], 'start')
        visit({ _tag: 'Template', node: quasi, templateKind, value, bounds: completeClassBounds(value, startSafe, endSafe) })
      }
    }
    for (const [index, expression] of template.expressions.entries()) {
      const left = template.quasis[index].value
      const right = template.quasis[index + 1].value
      const before = templateKind === 'cooked' ? left.cooked : left.raw
      const after = templateKind === 'cooked' ? right.cooked : right.raw
      const startSafe = typeof before === 'string' && (/\s$/.test(before) || (index === 0 && !before))
      const endSafe = typeof after === 'string' && (/^\s/.test(after) || (index === template.expressions.length - 1 && !after))
      walkProgram(expression, classContext, false, boundaryVisit(boundaryVisit(visit, startSafe, 'start'), endSafe, 'end'))
    }
    return
  }

  if (node.type === 'Literal' && typeof node.value === 'string') {
    if (classContext)
      visit({ _tag: 'Literal', node, ...classText(node.value) })
    return
  }
  if (node.type === 'TemplateElement' && typeof node.value?.raw === 'string') {
    if (classContext)
      visit({ _tag: 'Template', node, templateKind: 'unknown', ...classText(node.value.raw) })
    return
  }

  if (node.type === 'CallExpression') {
    const nextClassContext = classContext || isClassCallee(node.callee)
    const cva = node.callee.type === 'Identifier' && node.callee.name === 'cva'
    walkProgram(node.callee, false, false, visit)
    for (const [index, arg] of (node.arguments ?? []).entries()) {
      if (cva && index === 1 && arg.type === 'ObjectExpression') {
        for (const property of arg.properties) {
          if (property.type !== 'Property')
            continue
          const name = nodeName(property.key)
          if (name === 'variants')
            walkProgram(property.value, true, false, visit)
          else if (name === 'compoundVariants')
            walkProgram(property.value, false, false, visit)
        }
      }
      else {
        walkProgram(arg, nextClassContext, nextClassContext, visit)
      }
    }
    return
  }

  if (node.type === 'VariableDeclarator') {
    walkProgram(node.id, false, false, visit)
    walkProgram(node.init, classContext || isClassName(node.id), CLASS_OBJECT_NAME_RE.test(nodeName(node.id) ?? ''), visit)
    return
  }

  if (node.type === 'Property') {
    const keyMatches = isClassName(node.key)
    const valueContext = classContext || keyMatches
    if (classObjectKeyContext) {
      if (!node.computed && node.key.type === 'Identifier') {
        visit({ _tag: 'ObjectKey', node: node.key, shorthand: Boolean(node.shorthand), ...classText(node.key.name) })
      }
      else {
        walkProgram(node.key, true, false, visit)
      }
      walkProgram(node.value, false, false, visit)
      return
    }
    else {
      walkProgram(node.key, false, false, visit)
    }
    walkProgram(node.value, valueContext, false, visit)
    return
  }

  if (node.type === 'JSXAttribute') {
    const attrContext = classContext || isClassName(node.name) || isJsxClassAttr(node.name)
    walkProgram(node.value, attrContext, false, visit)
    return
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'range')
      continue
    if (Array.isArray(value)) {
      for (const child of value)
        walkProgram(child, classContext, classObjectKeyContext, visit)
    }
    else {
      walkProgram(value, classContext, classObjectKeyContext, visit)
    }
  }
}

function staticClassString(node: any): string | undefined {
  if (node?.type === 'ParenthesizedExpression')
    return staticClassString(node.expression)
  if (node?.type === 'Literal' && typeof node.value === 'string')
    return node.value
  if (node?.type === 'TemplateLiteral') {
    let value = ''
    for (const [index, quasi] of node.quasis.entries()) {
      if (typeof quasi.value.cooked !== 'string')
        return undefined
      value += quasi.value.cooked
      if (index < node.expressions.length) {
        const expression = staticClassString(node.expressions[index])
        if (expression === undefined)
          return undefined
        value += expression
      }
    }
    return value
  }
  if (node?.type !== 'BinaryExpression' || node.operator !== '+')
    return undefined
  const left = staticClassString(node.left)
  const right = staticClassString(node.right)
  return left === undefined || right === undefined ? undefined : left + right
}

function hasClassBoundary(node: any, edge: 'start' | 'end'): boolean {
  if (node?.type === 'ParenthesizedExpression')
    return hasClassBoundary(node.expression, edge)
  const value = staticClassString(node)
  if (value !== undefined)
    return !value || /\s/.test(edge === 'start' ? value[0] : value.at(-1)!)
  return node?.type === 'ConditionalExpression' && hasClassBoundary(node.consequent, edge) && hasClassBoundary(node.alternate, edge)
}

function boundaryVisit(visit: (site: ScriptStringSite) => void, safe: boolean, edge: 'start' | 'end'): (site: ScriptStringSite) => void {
  if (safe)
    return visit
  return (site) => {
    const value = site.value.slice(site.bounds.start, site.bounds.end)
    const bounds = completeClassBounds(value, edge !== 'start', edge !== 'end')
    visit({ ...site, bounds: { start: site.bounds.start + bounds.start, end: site.bounds.start + bounds.end } })
  }
}

function isClassCallee(node: any): boolean {
  if (!node)
    return false
  if (node.type === 'Identifier')
    return CLASS_CALLEE_RE.test(node.name)
  if (node.type === 'MemberExpression')
    return isClassName(node.property)
  return false
}

function isJsxClassAttr(node: any): boolean {
  return node?.type === 'JSXIdentifier' && CLASS_ATTR_RE_SCRIPT.test(node.name)
}

function isClassName(node: any): boolean {
  const name = nodeName(node)
  return !!name && CLASS_NAME_RE.test(name)
}

function nodeName(node: any): string | null {
  if (!node)
    return null
  if (node.type === 'Identifier' || node.type === 'JSXIdentifier')
    return node.name
  if (node.type === 'Literal' && typeof node.value === 'string')
    return node.value
  if (node.type === 'PrivateIdentifier')
    return node.name
  return null
}

const CLASS_EXPRESSION_PREFIX = 'cn('

function parseClassExpression(expression: string): { source: string, program: any | null } {
  const source = `${CLASS_EXPRESSION_PREFIX}${expression})`
  const { program, errors } = parseSync('ripast-class-expression.ts', source)
  return { source, program: errors.length ? null : program }
}

function visitVueClassAttributes(source: string, visit: (value: string, start: number, end: number, dynamic: boolean) => void): void {
  const ast = parseSfc(source).descriptor.template?.ast
  function walk(node: any): void {
    for (const prop of node.props ?? []) {
      if (prop.type === 6 && prop.name === 'class' && prop.value) {
        const { start, end, source: raw } = prop.value.loc
        const quoted = raw.startsWith('"') || raw.startsWith('\'')
        visit(prop.value.content, start.offset + Number(quoted), end.offset - Number(quoted), false)
      }
      else if (prop.type === 7 && prop.name === 'bind' && prop.arg?.isStatic && prop.arg.content === 'class' && prop.exp) {
        const { start, end } = prop.exp.loc
        visit(prop.exp.content, start.offset, end.offset, true)
      }
    }
    for (const child of node.children ?? []) walk(child)
  }
  if (ast)
    walk(ast)
}

function visitVueTemplateClassAttrs(source: string, visit: (text: string) => void): void {
  visitVueClassAttributes(source, (value, _start, _end, dynamic) => {
    if (!dynamic) {
      visit(value)
    }
    else {
      const { program } = parseClassExpression(value)
      if (program)
        visitProgramClassStrings(program, visit)
    }
  })
}

function visitVueStyleBlocks(source: string, visit: (body: string, lang: string) => void): void {
  for (const style of parseSfc(source).descriptor.styles)
    visit(style.content, style.lang ?? 'css')
}

interface CssSyntax {
  lineComments: boolean
  indented: boolean
}

function cssSyntax(path: string): CssSyntax {
  const lang = path.split('.').at(-1)
  return { lineComments: lang === 'scss' || lang === 'sass' || lang === 'less', indented: lang === 'sass' }
}

function visitCss(source: string, onToken: (bare: string) => void, syntax: CssSyntax): void {
  visitCssApplyRanges(source, syntax, (start, end) => visitClassTokens(source.slice(start, end), onToken))
}

function visitCssApplyRanges(source: string, syntax: CssSyntax, visit: (start: number, end: number) => void): void {
  let applyStart = -1
  let depth = 0
  let quote = ''
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (depth && char === '\\') {
      i++
      continue
    }
    if (quote) {
      if (char === '\\')
        i++
      else if (char === quote)
        quote = ''
      continue
    }
    if (syntax.lineComments && char === '/' && source[i + 1] === '/' && !depth) {
      if (applyStart !== -1)
        visit(applyStart, i)
      const end = source.indexOf('\n', i + 2)
      i = end === -1 ? source.length : end - 1
      if (applyStart !== -1)
        applyStart = i + 1
      continue
    }
    if (char === '/' && source[i + 1] === '*' && !depth) {
      if (applyStart !== -1)
        visit(applyStart, i)
      const end = source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : end + 1
      if (applyStart !== -1)
        applyStart = i + 1
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      continue
    }
    if (applyStart === -1) {
      if (source.startsWith('@apply', i) && /\s/.test(source[i + 6] ?? '')) {
        i += 6
        applyStart = i
      }
      continue
    }
    if (!depth && char === '!') {
      const end = cssImportantEnd(source, i, syntax)
      if (end !== undefined) {
        visit(applyStart, i)
        i = end - 1
        applyStart = end
        continue
      }
    }
    if (char === '[') {
      depth++
    }
    else if (char === ']' && depth) {
      depth--
    }
    else if (!depth && (char === ';' || char === '}' || char === '{' || (syntax.indented && (char === '\n' || char === '\r')))) {
      visit(applyStart, i)
      applyStart = -1
    }
  }
  if (applyStart !== -1)
    visit(applyStart, source.length)
}

function cssImportantEnd(source: string, start: number, syntax: CssSyntax): number | undefined {
  let cursor = start + 1
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      if (syntax.indented && /[\r\n]/.test(source[cursor]))
        return undefined
      cursor++
    }
    else if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2)
      if (end === -1)
        return undefined
      cursor = end + 2
    }
    else {
      break
    }
  }
  if (source.slice(cursor, cursor + 9).toLowerCase() !== 'important')
    return undefined
  const end = cursor + 9
  if (end === source.length || /[\s;}]/.test(source[end]) || source.startsWith('/*', end) || (syntax.lineComments && source.startsWith('//', end)))
    return end
  return undefined
}

function mapIncludesAny(input: string, map: RenameMap): boolean {
  for (const key of map.keys()) {
    if (input.includes(key))
      return true
  }
  return false
}

function rewriteScript(file: CssClassSourceFile, map: RenameMap): string {
  const parsed = parseFile(file.abs, file.cwd)
  if (!parsed.program)
    return file.source
  return rewriteStringsInProgram(file.source, parsed.program, map, 0)
}

function rewriteStringsInProgram(source: string, program: any, map: RenameMap, offset: number): string {
  const edits: { start: number, end: number, replacement: string }[] = []
  visitProgramClassStringSites(program, (site) => {
    const { node } = site
    const rewritten = site.value.slice(0, site.bounds.start)
      + rewriteClassString(site.value.slice(site.bounds.start, site.bounds.end), map)
      + site.value.slice(site.bounds.end)
    if (rewritten === site.value)
      return
    if (site._tag === 'Concatenation') {
      edits.push({ start: node.start + offset, end: node.end + offset, replacement: encodeStringLiteral(rewritten, '"') })
    }
    else if (site._tag === 'ObjectKey') {
      edits.push({ start: node.start + offset, end: node.end + offset, replacement: encodeStringLiteral(rewritten, '"') + (site.shorthand ? `: ${node.name}` : '') })
    }
    else if (site._tag === 'Literal') {
      edits.push({ start: node.start + offset, end: node.end + offset, replacement: encodeStringLiteral(rewritten, source[node.start + offset]) })
    }
    else if (site._tag === 'Template' && typeof node.value?.raw === 'string') {
      const { templateKind } = site
      if (templateKind === 'unknown')
        return
      // Raw tags expose source escapes. Refuse replacements that introduce template syntax.
      if (templateKind === 'raw' && ([...map.values()].some(replacement => /`|\$\{/.test(replacement)) || /(?:^|[^\\])(?:\\\\)*\\$/.test(rewritten)))
        return
      const range = templateContentRange(source, node, offset)
      if (!range)
        return
      const replacement = templateKind === 'cooked' ? JSON.stringify(rewritten).slice(1, -1).replace(/`/g, '\\`').replace(/\$\{/g, '\\${') : rewritten
      edits.push({ ...range, replacement })
    }
  })
  return applyTextEdits(source, edits)
}

function templateContentRange(source: string, node: any, offset: number): { start: number, end: number } | null {
  const start = node.start + offset
  const end = node.end + offset
  if (source.slice(start, end) === node.value.raw)
    return { start, end }
  const contentStart = start + 1
  const contentEnd = end - (node.tail ? 1 : 2)
  if ((source[start] === '`' || source[start] === '}') && source.slice(contentStart, contentEnd) === node.value.raw && source.slice(contentEnd, end) === (node.tail ? '`' : '${'))
    return { start: contentStart, end: contentEnd }
  return null
}

function rewriteVue(file: CssClassSourceFile, map: RenameMap): string {
  let out = file.source
  const parsed = parseFile(file.abs, file.cwd)
  if (parsed.program)
    out = rewriteScriptWithin(out, parsed.scriptStart, parsed.scriptEnd, parsed.scriptSource, parsed.program, map)
  out = rewriteVueTemplateClassAttrs(out, map)
  out = rewriteVueStyleBlocks(out, map)
  return out
}

function rewriteScriptWithin(full: string, start: number, end: number, scriptSource: string, program: any, map: RenameMap): string {
  const rewritten = rewriteStringsInProgram(scriptSource, program, map, 0)
  if (rewritten === scriptSource)
    return full
  return full.slice(0, start) + rewritten + full.slice(end)
}

function rewriteVueTemplateClassAttrs(source: string, map: RenameMap): string {
  const edits: { start: number, end: number, replacement: string }[] = []
  visitVueClassAttributes(source, (value, start, end, dynamic) => {
    if (!dynamic && !mapIncludesAny(value, map))
      return
    const replacement = dynamic ? rewriteDynamicClassExpr(value, map) : rewriteClassString(value, map)
    if (replacement !== value) {
      const quote = source[start - 1]
      const encoded = encodeAttributeValue(replacement, dynamic ? quote : undefined)
      edits.push({ start, end, replacement: !dynamic && quote !== '"' && quote !== '\'' ? `"${encoded}"` : encoded })
    }
  })
  return applyTextEdits(source, edits)
}

function encodeAttributeValue(value: string, quote?: string): string {
  let encoded = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  if (quote !== '\'')
    encoded = encoded.replace(/"/g, '&quot;')
  if (quote !== '"')
    encoded = encoded.replace(/'/g, '&#39;')
  return encoded
}

function encodeStringLiteral(value: string, quote: string): string {
  const encoded = JSON.stringify(value)
  return quote === '\'' ? `'${encoded.slice(1, -1).replace(/'/g, '\\\'')}'` : encoded
}

function rewriteDynamicClassExpr(expr: string, map: RenameMap): string {
  const { source, program } = parseClassExpression(expr)
  if (!program)
    return expr
  return rewriteStringsInProgram(source, program, map, 0).slice(CLASS_EXPRESSION_PREFIX.length, -1)
}

function rewriteVueStyleBlocks(source: string, map: RenameMap): string {
  const edits: { start: number, end: number, replacement: string }[] = []
  for (const style of parseSfc(source).descriptor.styles) {
    if (!mapIncludesAny(style.content, map))
      continue
    const replacement = rewriteCss(style.content, map, cssSyntax(style.lang ?? 'css'))
    if (replacement !== style.content)
      edits.push({ start: style.loc.start.offset, end: style.loc.end.offset, replacement })
  }
  return applyTextEdits(source, edits)
}

function rewriteCss(source: string, map: RenameMap, syntax: CssSyntax): string {
  const edits: { start: number, end: number, replacement: string }[] = []
  visitCssApplyRanges(source, syntax, (start, end) => {
    const value = source.slice(start, end)
    const replacement = rewriteClassString(value, map)
    if (replacement !== value)
      edits.push({ start, end, replacement })
  })
  return applyTextEdits(source, edits)
}
