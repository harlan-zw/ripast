import type { RenameMap } from './css-class-token.ts'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { walk } from 'oxc-walker'
import { rewriteClassString, visitClassTokens } from './css-class-token.ts'
import { applyTextEdits, parseFile, rgFiles } from './util.ts'

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
  const cwd = opts.cwd ?? process.cwd()
  const glob = opts.glob ?? defaultCssClassGlobs()
  const fileSet = new Set<string>()
  for (const key of map.keys()) {
    for (const file of rgFiles(key, { cwd, glob, fixedStrings: true }))
      fileSet.add(file)
  }
  return readSourceFiles([...fileSet], cwd)
}

export function visitCssClassTokensInFile(file: CssClassSourceFile, visit: (bare: string) => void): void {
  if (isVue(file.abs)) {
    visitVue(file, text => visitClassTokens(text, visit))
  }
  else if (isCss(file.abs)) {
    visitCss(file.source, visit)
  }
  else {
    visitScript(file, text => visitClassTokens(text, visit))
  }
}

export function rewriteCssClassTokensInFile(file: CssClassSourceFile, map: RenameMap): string {
  if (isVue(file.abs))
    return rewriteVue(file, map)
  if (isCss(file.abs))
    return rewriteCss(file.source, map)
  return rewriteScript(file, map)
}

function readSourceFiles(files: string[], cwd: string): CssClassSourceFile[] {
  const out: CssClassSourceFile[] = []
  for (const abs of files) {
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

function visitScript(file: CssClassSourceFile, visit: (text: string) => void): void {
  const parsed = parseFile(file.abs, file.cwd)
  if (parsed.program)
    visitProgramStrings(parsed.program, visit)
}

function visitProgramStrings(program: any, visit: (text: string) => void): void {
  walk(program, {
    enter(node: any) {
      if (node.type === 'Literal' && typeof node.value === 'string')
        visit(node.value)
      else if (node.type === 'TemplateElement' && typeof node.value?.raw === 'string')
        visit(node.value.raw)
    },
  })
}

function visitVue(file: CssClassSourceFile, visit: (text: string) => void): void {
  const parsed = parseFile(file.abs, file.cwd)
  if (parsed.program)
    visitProgramStrings(parsed.program, visit)
  visitVueTemplateClassAttrs(file.source, visit)
  visitVueStyleBlocks(file.source, body => visitCss(body, text => visitClassTokens(text, visit)))
}

const TEMPLATE_BLOCK_RE = /<template(?:\s[^>]*)?>([\s\S]*?)<\/template>/gi
const CLASS_ATTR_RE = /\b(:?class)\s*=\s*(["'])([\s\S]*?)\2/g
const NESTED_STRING_RE = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g

function visitVueTemplateClassAttrs(source: string, visit: (text: string) => void): void {
  for (const tmpl of source.matchAll(TEMPLATE_BLOCK_RE)) {
    const body = tmpl[1]
    for (const match of body.matchAll(CLASS_ATTR_RE)) {
      const name = match[1]
      const value = match[3]
      if (name === 'class') {
        visit(value)
      }
      else {
        for (const nested of value.matchAll(NESTED_STRING_RE))
          visit(nested[2])
      }
    }
  }
}

const STYLE_BLOCK_RE = /<style(?:\s[^>]*)?>([\s\S]*?)<\/style>/gi

function visitVueStyleBlocks(source: string, visit: (body: string) => void): void {
  for (const match of source.matchAll(STYLE_BLOCK_RE))
    visit(match[1])
}

const APPLY_RE = /@apply[ \t]+(\S[^;}\n]*)/g

function visitCss(source: string, onToken: (bare: string) => void): void {
  for (const match of source.matchAll(APPLY_RE))
    visitClassTokens(match[1], onToken)
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
  walk(program, {
    enter(node: any) {
      if (node.type === 'Literal' && typeof node.value === 'string') {
        if (!mapIncludesAny(node.value, map))
          return
        const rewritten = rewriteClassString(node.value, map)
        if (rewritten !== node.value)
          edits.push({ start: node.start + offset + 1, end: node.end + offset - 1, replacement: rewritten })
      }
      else if (node.type === 'TemplateElement' && typeof node.value?.raw === 'string') {
        const raw: string = node.value.raw
        if (!mapIncludesAny(raw, map))
          return
        const rewritten = rewriteClassString(raw, map)
        if (rewritten !== raw)
          edits.push({ start: node.start + offset, end: node.end + offset, replacement: rewritten })
      }
    },
  })
  return applyTextEdits(source, edits)
}

function rewriteVue(file: CssClassSourceFile, map: RenameMap): string {
  let out = file.source
  const parsed = parseFile(file.abs, file.cwd)
  if (parsed.program && mapIncludesAny(parsed.scriptSource, map))
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
  return source.replace(TEMPLATE_BLOCK_RE, (full, body) => {
    const rewrittenBody = body.replace(CLASS_ATTR_RE, (match: string, name: string, quote: string, value: string) => {
      if (!mapIncludesAny(value, map))
        return match
      if (name === 'class')
        return `${name}=${quote}${rewriteClassString(value, map)}${quote}`
      return `${name}=${quote}${rewriteDynamicClassExpr(value, map)}${quote}`
    })
    return full.replace(body, rewrittenBody)
  })
}

function rewriteDynamicClassExpr(expr: string, map: RenameMap): string {
  return expr.replace(NESTED_STRING_RE, (match, quote, inner) => {
    if (!mapIncludesAny(inner, map))
      return match
    return quote + rewriteClassString(inner, map) + quote
  })
}

function rewriteVueStyleBlocks(source: string, map: RenameMap): string {
  return source.replace(STYLE_BLOCK_RE, (full, body) => {
    if (!mapIncludesAny(body, map))
      return full
    return full.replace(body, rewriteCss(body, map))
  })
}

const APPLY_REWRITE_RE = /(@apply[ \t]+)(\S[^;}\n]*)/g

function rewriteCss(source: string, map: RenameMap): string {
  return source.replace(APPLY_REWRITE_RE, (_match, prefix, tokens) => prefix + rewriteClassString(tokens, map))
}
