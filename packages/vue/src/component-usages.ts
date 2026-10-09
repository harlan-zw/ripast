import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import process from 'node:process'
import { posToLineCol } from 'ripide-api/adapter'
import { rgFilesMany } from './discovery.ts'
import { parseSourceFile } from './parse.ts'
import { hyphenateVueName, parseVueTemplateAst } from './vue-template.ts'

export type UsageForm = 'tag-pascal' | 'tag-kebab' | 'resolveComponent' | 'dynamic-is-literal' | 'dynamic-is-binding'
export interface ComponentUsage {
  name: string
  file: string
  rel: string
  line: number
  col: number
  form: UsageForm
  /** Dynamic binding only: the bound identifier or expression text. */
  binding?: string
}
export interface FindUsagesOptions {
  cwd?: string
  glob?: string | string[]
}
const NODE_ELEMENT = 1
const NODE_DIRECTIVE = 7
const ATTRIBUTE = 6
const DEFAULT_GLOB = ['*.vue', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs']
export function findComponentUsages(names: string[], opts: FindUsagesOptions = {}): ComponentUsage[] {
  const cwd = opts.cwd ?? process.cwd()
  const aliasIndex = buildAliasIndex(names)
  const candidates = candidateFiles(cwd, aliasIndex, opts.glob)
  const out: ComponentUsage[] = []
  for (const abs of candidates) {
    const source = readOrEmpty(abs)
    if (!source)
      continue
    if (abs.endsWith('.vue'))
      collectFromSfc(abs, source, cwd, aliasIndex, out)
    collectFromScript(abs, source, cwd, aliasIndex, out)
  }
  return out.sort(sortUsages)
}
interface AliasIndex {
  /** Canonical name for any tag-name lookup (PascalCase or kebab). */
  byTag: Map<string, string>
  /** Set of canonical names for resolveComponent('X') / :is="'X'" string-literal lookups. */
  byString: Set<string>
  /** All alias strings used for ripgrep prefilter. */
  search: string[]
}
function buildAliasIndex(names: string[]): AliasIndex {
  const byTag = new Map<string, string>()
  const byString = new Set<string>()
  const search = new Set<string>()
  for (const name of names) {
    byTag.set(name, name)
    const kebab = hyphenateVueName(name)
    if (kebab !== name)
      byTag.set(kebab, name)
    byString.add(name)
    search.add(name)
    if (kebab !== name)
      search.add(kebab)
  }
  return { byTag, byString, search: [...search] }
}
function candidateFiles(cwd: string, alias: AliasIndex, glob?: string | string[]): string[] {
  const globs = glob ? (Array.isArray(glob) ? glob : [glob]) : DEFAULT_GLOB
  return rgFilesMany(alias.search, { cwd, glob: globs })
}
function readOrEmpty(abs: string): string {
  try {
    return readFileSync(abs, 'utf8')
  }
  catch {
    return ''
  }
}
function collectFromSfc(abs: string, source: string, cwd: string, alias: AliasIndex, out: ComponentUsage[]): void {
  const ast = parseVueTemplateAst(source)
  if (!ast)
    return
  walkTemplate(ast, (node: any) => {
    if (node.type !== NODE_ELEMENT)
      return
    const canonical = alias.byTag.get(node.tag)
    if (canonical) {
      const offset = node.loc.start.offset + 1 // skip the '<'
      const { line, col } = posToLineCol(source, offset)
      out.push({
        name: canonical,
        file: abs,
        rel: relative(cwd, abs),
        line,
        col,
        form: /^[a-z]/.test(node.tag) ? 'tag-kebab' : 'tag-pascal',
      })
    }
    if (node.tag === 'component') {
      const isProp = (node.props ?? []).find((p: any) => isIsDirective(p))
      if (isProp)
        collectDynamicIs(abs, source, cwd, isProp, alias, out)
    }
  })
}
function isIsDirective(prop: any): boolean {
  if (!prop)
    return false
  if (prop.type === ATTRIBUTE && prop.name === 'is')
    return true
  if (prop.type === NODE_DIRECTIVE && prop.name === 'bind' && prop.arg?.content === 'is')
    return true
  return false
}
function collectDynamicIs(abs: string, source: string, cwd: string, prop: any, alias: AliasIndex, out: ComponentUsage[]): void {
  if (prop.type === ATTRIBUTE) {
    const value = prop.value?.content
    if (typeof value === 'string' && alias.byString.has(value)) {
      const offset = prop.value.loc.start.offset
      const { line, col } = posToLineCol(source, offset)
      out.push({ name: value, file: abs, rel: relative(cwd, abs), line, col, form: 'dynamic-is-literal' })
    }
    return
  }
  const exp = prop.exp
  if (!exp?.content)
    return
  const trimmed = exp.content.trim()
  const literal = trimmed.match(/^['"]([^'"]+)['"]$/)
  if (literal) {
    const name = literal[1]!
    if (alias.byString.has(name)) {
      const offset = exp.loc.start.offset
      const { line, col } = posToLineCol(source, offset)
      out.push({ name, file: abs, rel: relative(cwd, abs), line, col, form: 'dynamic-is-literal' })
    }
    return
  }
  const offset = exp.loc.start.offset
  const { line, col } = posToLineCol(source, offset)
  out.push({
    name: '*',
    file: abs,
    rel: relative(cwd, abs),
    line,
    col,
    form: 'dynamic-is-binding',
    binding: trimmed,
  })
}
function walkTemplate(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== 'object')
    return
  if (typeof node.type === 'number')
    visit(node)
  for (const child of node.children ?? [])
    walkTemplate(child, visit)
}
function collectFromScript(abs: string, source: string, cwd: string, alias: AliasIndex, out: ComponentUsage[]): void {
  const file = parseSourceFile(abs.endsWith('.vue') ? `${abs}.ts` : abs, abs.endsWith('.vue') ? extractScriptOnly(source) ?? '' : source)
  const program = file.program
  if (!program)
    return
  const scriptOffset = abs.endsWith('.vue') ? scriptOffsetIn(source) : 0
  walkScript(program, (node: any) => {
    if (node.type !== 'CallExpression')
      return
    const callee = node.callee
    const isResolve = callee?.type === 'Identifier' && callee.name === 'resolveComponent'
    if (!isResolve)
      return
    const arg = node.arguments?.[0]
    if (arg?.type !== 'Literal' || typeof arg.value !== 'string')
      return
    if (!alias.byString.has(arg.value))
      return
    const offset = (arg.start ?? 0) + scriptOffset
    const { line, col } = posToLineCol(source, offset)
    out.push({ name: arg.value, file: abs, rel: relative(cwd, abs), line, col, form: 'resolveComponent' })
  })
}
function walkScript(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== 'object')
    return
  if (typeof node.type === 'string')
    visit(node)
  for (const key in node) {
    if (key === 'parent' || key === 'loc' || key === 'range')
      continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value)
        walkScript(child, visit)
    }
    else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walkScript(value, visit)
    }
  }
}
const SCRIPT_TAG_RE = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/i
function extractScriptOnly(source: string): string | null {
  const m = source.match(SCRIPT_TAG_RE)
  return m ? m[2] ?? null : null
}
function scriptOffsetIn(source: string): number {
  const re = /<script(\s[^>]*)?>/i
  const m = source.match(re)
  if (!m || m.index == null)
    return 0
  return m.index + m[0].length
}
function sortUsages(a: ComponentUsage, b: ComponentUsage): number {
  return a.rel.localeCompare(b.rel) || a.line - b.line || a.col - b.col
}
export function findComponentUsage(name: string, opts: FindUsagesOptions = {}): ComponentUsage[] {
  return findComponentUsages([name], opts)
}
