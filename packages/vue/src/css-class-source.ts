import type { CssClassSourceFile, RenameMap } from 'ripide-api/adapter'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { parseSync } from 'oxc-parser'
import { applyTextEdits, cssSyntax, encodeAttributeValue, mapIncludesAny, parseFile, rewriteClassString, rewriteCss, rewriteStringsInProgram, visitClassTokens, visitCss, visitProgramClassStrings } from 'ripide-api/adapter'
import { parseAuthoredSource } from './source.ts'

const CLASS_EXPRESSION_PREFIX = 'cn('
export { rewriteVue as rewriteVueCssClassTokens }
export function visitVueCssClassTokens(file: CssClassSourceFile, visit: (bare: string) => void): void {
  visitVue(file, text => visitClassTokens(text, visit))
}

function visitVue(file: CssClassSourceFile, visit: (text: string) => void): void {
  const parsed = parseFile(file.abs, file.cwd, { parse: (path, source) => parseAuthoredSource({ path, source: source.includes('<script') || source.includes('<template') ? source : `<template></template>${source}` }) })
  if (parsed.program)
    visitProgramClassStrings(parsed.program, visit)
  visitVueTemplateClassAttrs(file.source, visit)
  visitVueStyleBlocks(file.source, (body, lang) => visitCss(body, text => visitClassTokens(text, visit), cssSyntax(lang)))
}

function parseClassExpression(expression: string): { source: string, program: any | null } {
  const source = `${CLASS_EXPRESSION_PREFIX}${expression})`
  const { program, errors } = parseSync('ripide-class-expression.ts', source)
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

function rewriteVue(file: CssClassSourceFile, map: RenameMap): string {
  let out = file.source
  const parsed = parseFile(file.abs, file.cwd, { parse: (path, source) => parseAuthoredSource({ path, source: source.includes('<script') || source.includes('<template') ? source : `<template></template>${source}` }) })
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
