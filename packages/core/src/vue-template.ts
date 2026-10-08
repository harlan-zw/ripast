import type { TextEdit } from './util.ts'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'
import { applyTextEdits } from './util.ts'

export interface TemplateExpression {
  code: string
  offsetInSource: number
}

const NODE_INTERPOLATION = 5
const NODE_DIRECTIVE = 7
const NODE_ELEMENT = 1
const NODE_SIMPLE_EXPRESSION = 4
const NODE_COMPOUND_EXPRESSION = 8

export function hyphenateVueName(s: string): string {
  return s.replace(/\B([A-Z])/g, '-$1').toLowerCase()
}

interface Edit { start: number, end: number, replacement: string }

export function rewriteTemplateReferences(source: string, oldName: string, newName: string): string {
  let descriptor: any
  try {
    descriptor = parseSfc(source).descriptor
  }
  catch {
    return source
  }
  const tmpl = descriptor.template
  if (!tmpl?.ast)
    return source
  const isComponentName = /^[A-Z]/.test(oldName)
  const oldKebab = hyphenateVueName(oldName)
  const newKebab = hyphenateVueName(newName)
  // Skip kebab tag rewrites when oldKebab is a native HTML element (e.g. Button -> button).
  // Otherwise we'd corrupt every native `<button>` / `<header>` / `<section>` in the project.
  const kebabConflictsWithNative = HTML_ELEMENT_NAMES.has(oldKebab)
  const edits: Edit[] = []

  function rewriteTag(node: any, oldTag: string, newTag: string): void {
    const elStart = node.loc.start.offset
    const elSource = node.loc.source as string
    const openTagStart = elStart + 1
    const openTagEnd = openTagStart + oldTag.length
    if (source.slice(openTagStart, openTagEnd) === oldTag)
      edits.push({ start: openTagStart, end: openTagEnd, replacement: newTag })
    if (!node.isSelfClosing) {
      const closeMarker = `</${oldTag}`
      const closeIdx = elSource.lastIndexOf(closeMarker)
      if (closeIdx >= 0) {
        const after = elSource.charAt(closeIdx + closeMarker.length)
        if (after === '' || /[\s>]/.test(after)) {
          const closeStart = elStart + closeIdx + 2
          const closeEnd = closeStart + oldTag.length
          if (source.slice(closeStart, closeEnd) === oldTag)
            edits.push({ start: closeStart, end: closeEnd, replacement: newTag })
        }
      }
    }
  }

  function collectVForBindings(forParseResult: any, out: string[]): void {
    if (!forParseResult)
      return
    for (const key of ['value', 'key', 'index']) {
      const v = forParseResult[key]
      if (typeof v?.content !== 'string')
        continue
      const m = v.content.match(/[A-Z_$][\w$]*/gi)
      if (m) {
        for (const id of m) out.push(id)
      }
    }
  }

  function visitExpression(expr: any, scopes: string[][]): void {
    if (!expr)
      return
    if (expr.type === NODE_COMPOUND_EXPRESSION) {
      for (const c of expr.children ?? []) {
        if (c && typeof c === 'object')
          visitExpression(c, scopes)
      }
      return
    }
    if (expr.type !== NODE_SIMPLE_EXPRESSION)
      return
    if (typeof expr.content !== 'string' || !expr.content.includes(oldName))
      return
    const exprStartInSource = expr.loc?.start?.offset
    if (exprStartInSource === undefined)
      return
    let program: any
    try {
      program = parseSync('expr.ts', expr.content).program
    }
    catch {
      return
    }
    if (!program)
      return
    walk(program, {
      enter(n: any, parent: any) {
        if (n.type !== 'Identifier' || n.name !== oldName)
          return
        if (parent) {
          if (parent.type === 'MemberExpression' && !parent.computed && parent.property === n)
            return
          if ((parent.type === 'Property' || parent.type === 'ObjectProperty') && !parent.computed && parent.key === n && parent.value !== n)
            return
          if (parent.type === 'ImportSpecifier')
            return
        }
        if (scopes.some(s => s.includes(oldName)))
          return
        const start = exprStartInSource + n.start
        const end = exprStartInSource + n.end
        if (source.slice(start, end) !== oldName)
          return
        edits.push({ start, end, replacement: newName })
      },
    })
  }

  function visit(node: any, scopes: string[][]): void {
    if (!node || typeof node !== 'object')
      return
    if (node.type === NODE_ELEMENT) {
      const vfor = (node.props ?? []).find((p: any) => p.type === NODE_DIRECTIVE && p.name === 'for')
      const newScope: string[] = []
      if (vfor?.forParseResult)
        collectVForBindings(vfor.forParseResult, newScope)
      const innerScopes = newScope.length ? [...scopes, newScope] : scopes

      if (isComponentName) {
        if (node.tag === oldName)
          rewriteTag(node, oldName, newName)
        else if (oldKebab !== oldName && node.tag === oldKebab && !kebabConflictsWithNative)
          rewriteTag(node, oldKebab, newKebab)
      }

      for (const prop of node.props ?? []) {
        if (prop === vfor) {
          if (vfor.forParseResult?.source)
            visitExpression(vfor.forParseResult.source, innerScopes)
          continue
        }
        visit(prop, innerScopes)
      }
      for (const c of node.children ?? []) visit(c, innerScopes)
      return
    }
    if (node.type === NODE_INTERPOLATION) {
      visitExpression(node.content, scopes)
      return
    }
    if (node.type === NODE_DIRECTIVE) {
      if (node.exp)
        visitExpression(node.exp, scopes)
      if (node.arg && node.arg.isStatic === false)
        visitExpression(node.arg, scopes)
      return
    }
    if (node.type === NODE_SIMPLE_EXPRESSION) {
      visitExpression(node, scopes)
      return
    }
    if (node.type === NODE_COMPOUND_EXPRESSION) {
      for (const c of node.children ?? []) visit(c, scopes)
      return
    }
    for (const c of node.children ?? []) visit(c, scopes)
  }

  visit(tmpl.ast, [])

  if (!edits.length)
    return source
  return applyTextEdits(source, edits)
}

export interface TemplateSelector {
  tag: string
  attrs: { name: string, value?: string }[]
}

export function parseTemplateSelector(input: string): TemplateSelector {
  const trimmed = input.trim()
  if (!trimmed)
    throw new Error('ripast: empty selector')
  const tagMatch = trimmed.match(/^([A-Z][\w-]*)/i)
  if (!tagMatch)
    throw new Error(`ripast: invalid selector "${input}" (expected tag name, optionally with [attr] or [attr=value] predicates)`)
  const tag = tagMatch[1]!
  const rest = trimmed.slice(tag.length)
  const attrs: { name: string, value?: string }[] = []
  const attrRe = /\[([A-Z_:][\w:-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]+)))?\]/gi
  let consumed = 0
  for (const m of rest.matchAll(attrRe)) {
    if (m.index !== consumed)
      throw new Error(`ripast: invalid selector "${input}" near "${rest.slice(consumed)}"`)
    consumed = m.index + m[0].length
    const value = m[2] ?? m[3] ?? m[4]
    attrs.push(value === undefined ? { name: m[1]! } : { name: m[1]!, value })
  }
  if (consumed !== rest.length)
    throw new Error(`ripast: invalid selector "${input}" (unexpected trailing "${rest.slice(consumed)}")`)
  return { tag, attrs }
}

function tagMatches(node: any, sel: TemplateSelector): boolean {
  if (node.type !== NODE_ELEMENT)
    return false
  if (node.tag !== sel.tag) {
    const kebab = hyphenateVueName(sel.tag)
    if (kebab === sel.tag || node.tag !== kebab)
      return false
  }
  for (const pred of sel.attrs) {
    const found = (node.props ?? []).find((p: any) =>
      (p.type === 6 /* ATTRIBUTE */ && p.name === pred.name)
      || (p.type === NODE_DIRECTIVE && p.name === 'bind' && p.arg?.content === pred.name),
    )
    if (!found)
      return false
    if (pred.value !== undefined) {
      if (found.type === 6) {
        if (found.value?.content !== pred.value)
          return false
      }
      else {
        return false // dynamic bind can't compare to literal string reliably
      }
    }
  }
  return true
}

export function parseVueTemplateAst(source: string): any | null {
  return parseTemplate(source)
}

function parseTemplate(source: string): any | null {
  let descriptor: any
  try {
    descriptor = parseSfc(source).descriptor
  }
  catch {
    return null
  }
  return descriptor.template?.ast ?? null
}

function getLineIndent(source: string, offset: number): { indent: string, lineStart: number, isAllWhitespace: boolean } {
  let lineStart = offset
  while (lineStart > 0 && source.charCodeAt(lineStart - 1) !== 10)
    lineStart--
  const indent = source.slice(lineStart, offset)
  return { indent, lineStart, isAllWhitespace: /^[ \t]*$/.test(indent) }
}

function findOpenTagEnd(source: string, node: any): number {
  const elStart = node.loc.start.offset
  if (node.children?.length) {
    const firstChildStart = node.children[0].loc.start.offset
    const upToChild = source.slice(elStart, firstChildStart)
    const gt = upToChild.lastIndexOf('>')
    if (gt >= 0)
      return elStart + gt + 1
  }
  const elEnd = node.loc.end.offset
  const slice = source.slice(elStart, elEnd)
  const gt = slice.indexOf('>')
  if (gt < 0)
    return elEnd
  return elStart + gt + 1
}

function findCloseTagStart(source: string, node: any): number {
  const elStart = node.loc.start.offset
  const elEnd = node.loc.end.offset
  const slice = source.slice(elStart, elEnd)
  const idx = slice.lastIndexOf(`</${node.tag}`)
  if (idx < 0) {
    const kebab = hyphenateVueName(node.tag)
    const idx2 = slice.lastIndexOf(`</${kebab}`)
    if (idx2 >= 0)
      return elStart + idx2
    return elEnd
  }
  return elStart + idx
}

export interface TemplateMatchOptions {
  rootOnly?: boolean
}

function collectMatches(ast: any, sel: TemplateSelector, recurseIntoMatches: boolean, opts: TemplateMatchOptions = {}): any[] {
  const out: any[] = []
  if (opts.rootOnly) {
    for (const c of ast.children ?? []) {
      if (c && typeof c === 'object' && tagMatches(c, sel))
        out.push(c)
    }
    return out
  }
  function visit(node: any): void {
    if (!node || typeof node !== 'object')
      return
    if (tagMatches(node, sel)) {
      out.push(node)
      if (!recurseIntoMatches)
        return
    }
    for (const c of node.children ?? []) visit(c)
  }
  visit(ast)
  return out
}

export function wrapTemplateElements(source: string, selector: TemplateSelector, wrapperInner: string, opts: TemplateMatchOptions = {}): string {
  const ast = parseTemplate(source)
  if (!ast)
    return source
  const wrapperTag = wrapperInner.trim().split(/\s/)[0]
  if (!wrapperTag)
    throw new Error('ripast: empty wrapper tag')
  const matches = collectMatches(ast, selector, false, opts)
  if (!matches.length)
    return source
  const edits: TextEdit[] = []
  for (const node of matches) {
    const start = node.loc.start.offset
    const end = node.loc.end.offset
    const { indent, isAllWhitespace } = getLineIndent(source, start)
    if (isAllWhitespace) {
      const inner = source.slice(start, end).replace(/\n/g, '\n  ')
      edits.push({
        start,
        end,
        replacement: `<${wrapperInner}>\n${indent}  ${inner}\n${indent}</${wrapperTag}>`,
      })
    }
    else {
      edits.push({
        start,
        end,
        replacement: `<${wrapperInner}>${source.slice(start, end)}</${wrapperTag}>`,
      })
    }
  }
  return applyTextEdits(source, edits)
}

export function unwrapTemplateElements(source: string, selector: TemplateSelector, opts: TemplateMatchOptions = {}): string {
  const ast = parseTemplate(source)
  if (!ast)
    return source
  // Apply disjoint outer edits first. Revisit nested matches after their parents
  // have been removed, so a parent replacement cannot overwrite a child edit.
  const matches = collectMatches(ast, selector, false, opts)
  const hasNestedMatches = collectMatches(ast, selector, true, opts).length > matches.length
  if (!matches.length)
    return source
  const edits: TextEdit[] = []
  for (const node of matches) {
    const start = node.loc.start.offset
    const end = node.loc.end.offset
    if (node.isSelfClosing || !node.children?.length) {
      const { isAllWhitespace, lineStart } = getLineIndent(source, start)
      if (isAllWhitespace) {
        let lineEnd = end
        if (source[lineEnd] === '\n')
          lineEnd++
        edits.push({ start: lineStart, end: lineEnd, replacement: '' })
      }
      else {
        edits.push({ start, end, replacement: '' })
      }
      continue
    }
    const openEnd = findOpenTagEnd(source, node)
    const closeStart = findCloseTagStart(source, node)
    let innerStart = openEnd
    let innerEnd = closeStart
    if (source[innerStart] === '\n')
      innerStart++
    while (innerEnd > innerStart && (source[innerEnd - 1] === ' ' || source[innerEnd - 1] === '\t'))
      innerEnd--
    if (innerEnd > innerStart && source[innerEnd - 1] === '\n')
      innerEnd--
    let inner = source.slice(innerStart, innerEnd)
    inner = inner.replace(/^ {2}/gm, '')
    const { lineStart, isAllWhitespace } = getLineIndent(source, start)
    if (isAllWhitespace) {
      let lineEnd = end
      if (source[lineEnd] === '\n')
        lineEnd++
      edits.push({ start: lineStart, end: lineEnd, replacement: `${inner}\n` })
    }
    else {
      edits.push({ start, end, replacement: inner })
    }
  }
  const output = applyTextEdits(source, edits)
  return hasNestedMatches ? unwrapTemplateElements(output, selector, opts) : output
}

export function extractTemplateExpressions(source: string): TemplateExpression[] {
  let descriptor: any
  try {
    descriptor = parseSfc(source).descriptor
  }
  catch {
    return []
  }
  const tmpl = descriptor.template
  if (!tmpl?.ast)
    return []
  const out: TemplateExpression[] = []
  visit(tmpl.ast, out)
  return out
}

function visit(node: any, out: TemplateExpression[]): void {
  if (!node || typeof node !== 'object')
    return
  if (node.type === NODE_SIMPLE_EXPRESSION) {
    if (!node.isStatic && typeof node.content === 'string' && node.content.trim() && node.loc?.start?.offset !== undefined) {
      const argumentBracket = node.loc.source === `[${node.content}]` ? 1 : 0
      out.push({ code: node.content, offsetInSource: node.loc.start.offset + argumentBracket })
    }
    return
  }
  if (node.type === NODE_COMPOUND_EXPRESSION) {
    for (const c of node.children ?? []) visit(c, out)
    return
  }
  if (node.type === NODE_INTERPOLATION) {
    visit(node.content, out)
    return
  }
  if (node.type === NODE_DIRECTIVE) {
    if (node.exp)
      visit(node.exp, out)
    if (node.arg)
      visit(node.arg, out)
    return
  }
  if (node.type === NODE_ELEMENT) {
    for (const prop of node.props ?? []) visit(prop, out)
    for (const c of node.children ?? []) visit(c, out)
    return
  }
  for (const c of node.children ?? []) visit(c, out)
}

const HTML_ELEMENT_NAMES = new Set([
  'a',
  'abbr',
  'address',
  'area',
  'article',
  'aside',
  'audio',
  'b',
  'base',
  'bdi',
  'bdo',
  'blockquote',
  'body',
  'br',
  'button',
  'canvas',
  'caption',
  'cite',
  'code',
  'col',
  'colgroup',
  'data',
  'datalist',
  'dd',
  'del',
  'details',
  'dfn',
  'dialog',
  'div',
  'dl',
  'dt',
  'em',
  'embed',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'header',
  'hgroup',
  'hr',
  'html',
  'i',
  'iframe',
  'img',
  'input',
  'ins',
  'kbd',
  'label',
  'legend',
  'li',
  'link',
  'main',
  'map',
  'mark',
  'menu',
  'meta',
  'meter',
  'nav',
  'noscript',
  'object',
  'ol',
  'optgroup',
  'option',
  'output',
  'p',
  'param',
  'picture',
  'pre',
  'progress',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'script',
  'search',
  'section',
  'select',
  'slot',
  'small',
  'source',
  'span',
  'strong',
  'style',
  'sub',
  'summary',
  'sup',
  'table',
  'tbody',
  'td',
  'template',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'time',
  'title',
  'tr',
  'track',
  'u',
  'ul',
  'var',
  'video',
  'wbr',
])
