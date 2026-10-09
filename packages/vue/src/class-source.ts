import type { CssClassSourceFile, RenameMap } from 'ripide-api/adapter'
import { parseSync } from 'oxc-parser'
import { applyTextEdits, cssSyntax, encodeAttributeValue, mapIncludesAny, rewriteClassString, rewriteCss, rewriteScriptWithin, rewriteStringsInProgram, visitClassTokens, visitCss, visitProgramClassStrings } from 'ripide-api/adapter'
import { parseFile } from './parse.ts'

const CLASS_EXPRESSION_PREFIX = 'cn('
export function visitFrameworkClasses(file: CssClassSourceFile, visit: (text: string) => void, parseDescriptor: DescriptorParser): void {
  const parsed = parseFile(file.abs, file.cwd)
  if (parsed.program)
    visitProgramClassStrings(parsed.program, visit)
  visitVueTemplateClassAttrs(file.source, visit, parseDescriptor)
  visitVueStyleBlocks(file.source, (body, lang) => visitCss(body, text => visitClassTokens(text, visit), cssSyntax(lang)), parseDescriptor)
}
function parseClassExpression(expression: string): {
  source: string
  program: any | null
} {
  const source = `${CLASS_EXPRESSION_PREFIX}${expression})`
  const { program, errors } = parseSync('ripide-class-expression.ts', source)
  return { source, program: errors.length ? null : program }
}
function visitVueClassAttributes(source: string, visit: (value: string, start: number, end: number, dynamic: boolean) => void, parseDescriptor: DescriptorParser): void {
  const ast = parseDescriptor(source).template?.ast
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
    for (const child of node.children ?? [])
      walk(child)
  }
  if (ast)
    walk(ast)
}
function visitVueTemplateClassAttrs(source: string, visit: (text: string) => void, parseDescriptor: DescriptorParser): void {
  visitVueClassAttributes(source, (value, _start, _end, dynamic) => {
    if (!dynamic) {
      visit(value)
    }
    else {
      const { program } = parseClassExpression(value)
      if (program)
        visitProgramClassStrings(program, visit)
    }
  }, parseDescriptor)
}
function visitVueStyleBlocks(source: string, visit: (body: string, lang: string) => void, parseDescriptor: DescriptorParser): void {
  for (const style of parseDescriptor(source).styles)
    visit(style.content, style.lang ?? 'css')
}
export function rewriteFrameworkClasses(file: CssClassSourceFile, map: RenameMap, parseDescriptor: DescriptorParser): string {
  let out = file.source
  const parsed = parseFile(file.abs, file.cwd)
  if (parsed.program)
    out = rewriteScriptWithin(out, parsed.scriptStart, parsed.scriptEnd, parsed.scriptSource, parsed.program, map)
  out = rewriteVueTemplateClassAttrs(out, map, parseDescriptor)
  out = rewriteVueStyleBlocks(out, map, parseDescriptor)
  return out
}
function rewriteVueTemplateClassAttrs(source: string, map: RenameMap, parseDescriptor: DescriptorParser): string {
  const edits: {
    start: number
    end: number
    replacement: string
  }[] = []
  visitVueClassAttributes(source, (value, start, end, dynamic) => {
    if (!dynamic && !mapIncludesAny(value, map))
      return
    const replacement = dynamic ? rewriteDynamicClassExpr(value, map) : rewriteClassString(value, map)
    if (replacement !== value) {
      const quote = source[start - 1]
      const encoded = encodeAttributeValue(replacement, dynamic ? quote : undefined)
      edits.push({ start, end, replacement: !dynamic && quote !== '"' && quote !== '\'' ? `"${encoded}"` : encoded })
    }
  }, parseDescriptor)
  return applyTextEdits(source, edits)
}
function rewriteDynamicClassExpr(expr: string, map: RenameMap): string {
  const { source, program } = parseClassExpression(expr)
  if (!program)
    return expr
  return rewriteStringsInProgram(source, program, map, 0).slice(CLASS_EXPRESSION_PREFIX.length, -1)
}
function rewriteVueStyleBlocks(source: string, map: RenameMap, parseDescriptor: DescriptorParser): string {
  const edits: {
    start: number
    end: number
    replacement: string
  }[] = []
  for (const style of parseDescriptor(source).styles) {
    if (!mapIncludesAny(style.content, map))
      continue
    const replacement = rewriteCss(style.content, map, cssSyntax(style.lang ?? 'css'))
    if (replacement !== style.content)
      edits.push({ start: style.loc.start.offset, end: style.loc.end.offset, replacement })
  }
  return applyTextEdits(source, edits)
}
export type DescriptorParser = (source: string) => {
  template?: {
    ast?: any
  } | null
  styles: {
    content: string
    lang?: string
    loc: {
      start: {
        offset: number
      }
      end: {
        offset: number
      }
    }
  }[]
}
