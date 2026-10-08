import type { PropsResolution } from './components.ts'
import { readFileSync } from 'node:fs'
import { parseSourceFile } from '@ripast/core/adapter'

export interface PropSig {
  name: string
  type?: string
  required?: boolean
  hasDefault?: boolean
}

export interface ParsedComponentShape {
  props: PropSig[]
  emits: string[]
  slots: string[]
  exposes: string[]
  scriptLang: 'ts' | 'js' | null
  setup: boolean
  propsResolution: PropsResolution
}

export function parseComponent(absPath: string): ParsedComponentShape {
  const source = readFileSync(absPath, 'utf8')
  return parseComponentSource(absPath, source)
}

export function parseComponentSource(absPath: string, source: string): ParsedComponentShape {
  const empty: ParsedComponentShape = {
    props: [],
    emits: [],
    slots: [],
    exposes: [],
    scriptLang: null,
    setup: false,
    propsResolution: 'literal',
  }
  if (!absPath.endsWith('.vue')) {
    const program = safeParse(absPath, source)
    if (!program)
      return empty
    return walkProgram(program, { ...empty, scriptLang: absPath.endsWith('.ts') || absPath.endsWith('.tsx') ? 'ts' : 'js' })
  }
  const block = extractScriptBlock(source)
  if (!block)
    return empty
  const program = safeParse(`${absPath}.ts`, block.code)
  if (!program)
    return { ...empty, scriptLang: block.lang, setup: block.setup }
  return walkProgram(program, { ...empty, scriptLang: block.lang, setup: block.setup })
}

interface ScriptBlock {
  code: string
  lang: 'ts' | 'js'
  setup: boolean
}

const SCRIPT_TAG_RE = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi

function extractScriptBlock(source: string): ScriptBlock | null {
  const blocks: ScriptBlock[] = []
  for (const m of source.matchAll(SCRIPT_TAG_RE)) {
    const attrs = m[1] ?? ''
    const code = m[2] ?? ''
    if (/\bsrc\s*=/.test(attrs))
      continue
    const lang: 'ts' | 'js' = /\blang\s*=\s*["']ts["']/.test(attrs) ? 'ts' : 'js'
    const setup = /\bsetup\b/.test(attrs)
    blocks.push({ code, lang, setup })
  }
  if (!blocks.length)
    return null
  return blocks.find(b => b.setup) ?? blocks.reduce((a, b) => (b.code.length > a.code.length ? b : a))
}

function safeParse(path: string, code: string): any | null {
  try {
    return parseSourceFile(path, code).program
  }
  catch {
    return null
  }
}

function walkProgram(program: any, base: ParsedComponentShape): ParsedComponentShape {
  let propsResolution: PropsResolution = 'literal'
  const props: PropSig[] = []
  const emits: string[] = []
  const slots: string[] = []
  const exposes: string[] = []
  const withDefaultsKeys = new Set<string>()

  walkAst(program, (node: any) => {
    if (node.type === 'CallExpression') {
      const name = calleeName(node)
      switch (name) {
        case 'defineProps': {
          const result = extractProps(node)
          if (result.unresolved)
            propsResolution = 'unresolved'
          for (const p of result.props) props.push(p)
          break
        }
        case 'defineEmits': {
          const result = extractEmits(node)
          if (result.unresolved)
            propsResolution = 'unresolved'
          for (const e of result.emits) emits.push(e)
          break
        }
        case 'defineSlots': {
          const result = extractStringKeyedTypeLiteral(node)
          if (result.unresolved)
            propsResolution = 'unresolved'
          for (const s of result.keys) slots.push(s)
          break
        }
        case 'defineExpose': {
          const result = extractExpose(node)
          if (result.unresolved)
            propsResolution = 'unresolved'
          for (const e of result.keys) exposes.push(e)
          break
        }
        case 'withDefaults': {
          const second = node.arguments?.[1]
          if (second?.type === 'ObjectExpression') {
            for (const prop of second.properties ?? []) {
              const key = propKey(prop)
              if (key)
                withDefaultsKeys.add(key)
            }
          }
          break
        }
        case 'defineComponent': {
          const arg = node.arguments?.[0]
          if (arg?.type === 'ObjectExpression') {
            for (const prop of arg.properties ?? []) {
              const key = propKey(prop)
              if (key === 'props') {
                const r = extractPropsFromOptionsValue(prop.value)
                if (r.unresolved)
                  propsResolution = 'unresolved'
                for (const p of r.props) props.push(p)
              }
              else if (key === 'emits') {
                const r = extractEmitsFromValue(prop.value)
                if (r.unresolved)
                  propsResolution = 'unresolved'
                for (const e of r.emits) emits.push(e)
              }
            }
          }
          break
        }
      }
    }
  })

  for (const p of props) {
    if (withDefaultsKeys.has(p.name))
      p.hasDefault = true
  }

  return {
    ...base,
    props: dedupePropsByName(props),
    emits: [...new Set(emits)].sort(),
    slots: [...new Set(slots)].sort(),
    exposes: [...new Set(exposes)].sort(),
    propsResolution,
  }
}

function calleeName(node: any): string | null {
  const callee = node.callee
  if (callee?.type === 'Identifier')
    return callee.name
  if (callee?.type === 'MemberExpression' && callee.property?.type === 'Identifier' && !callee.computed)
    return callee.property.name
  return null
}

function propKey(prop: any): string | null {
  if (prop?.type !== 'Property' && prop?.type !== 'ObjectProperty')
    return null
  if (!prop.key)
    return null
  if (prop.computed)
    return null
  if (prop.key.type === 'Identifier')
    return prop.key.name
  if (prop.key.type === 'Literal' && typeof prop.key.value === 'string')
    return prop.key.value
  return null
}

function extractProps(callNode: any): { props: PropSig[], unresolved: boolean } {
  const typeArg = callNode.typeArguments?.params?.[0] ?? callNode.typeParameters?.params?.[0]
  if (typeArg)
    return propsFromTypeLiteral(typeArg)
  const arg = callNode.arguments?.[0]
  if (!arg)
    return { props: [], unresolved: false }
  return extractPropsFromOptionsValue(arg)
}

function extractPropsFromOptionsValue(arg: any): { props: PropSig[], unresolved: boolean } {
  if (!arg)
    return { props: [], unresolved: false }
  if (arg.type === 'ArrayExpression') {
    const out: PropSig[] = []
    for (const el of arg.elements ?? []) {
      if (el?.type === 'Literal' && typeof el.value === 'string')
        out.push({ name: el.value })
    }
    return { props: out, unresolved: false }
  }
  if (arg.type === 'ObjectExpression') {
    const out: PropSig[] = []
    for (const prop of arg.properties ?? []) {
      const key = propKey(prop)
      if (!key)
        continue
      const sig: PropSig = { name: key }
      const value = prop.value
      if (value?.type === 'ObjectExpression') {
        for (const inner of value.properties ?? []) {
          const innerKey = propKey(inner)
          if (innerKey === 'required' && inner.value?.type === 'Literal')
            sig.required = !!inner.value.value
          if (innerKey === 'default')
            sig.hasDefault = true
          if (innerKey === 'type')
            sig.type = stringifyTypeNode(inner.value)
        }
      }
      else if (value) {
        sig.type = stringifyTypeNode(value)
      }
      out.push(sig)
    }
    return { props: out, unresolved: false }
  }
  return { props: [], unresolved: true }
}

function propsFromTypeLiteral(typeNode: any): { props: PropSig[], unresolved: boolean } {
  if (typeNode?.type !== 'TSTypeLiteral')
    return { props: [], unresolved: true }
  const out: PropSig[] = []
  for (const member of typeNode.members ?? []) {
    if (member.type !== 'TSPropertySignature')
      continue
    const name = member.key?.type === 'Identifier'
      ? member.key.name
      : member.key?.type === 'Literal' && typeof member.key.value === 'string'
        ? member.key.value
        : null
    if (!name)
      continue
    out.push({
      name,
      required: !member.optional,
      type: member.typeAnnotation?.typeAnnotation ? stringifyTypeNode(member.typeAnnotation.typeAnnotation) : undefined,
    })
  }
  return { props: out, unresolved: false }
}

function extractEmits(callNode: any): { emits: string[], unresolved: boolean } {
  const typeArg = callNode.typeArguments?.params?.[0] ?? callNode.typeParameters?.params?.[0]
  if (typeArg) {
    if (typeArg.type === 'TSTypeLiteral') {
      const out: string[] = []
      for (const member of typeArg.members ?? []) {
        // (e: 'event', payload: T): void
        if (member.type === 'TSCallSignatureDeclaration') {
          const first = member.params?.[0]
          const literal = first?.typeAnnotation?.typeAnnotation
          if (literal?.type === 'TSLiteralType' && literal.literal?.type === 'Literal' && typeof literal.literal.value === 'string')
            out.push(literal.literal.value)
        }
        // event: [payload]
        else if (member.type === 'TSPropertySignature' && !member.computed) {
          if (member.key?.type === 'Identifier')
            out.push(member.key.name)
          else if (member.key?.type === 'Literal' && typeof member.key.value === 'string')
            out.push(member.key.value)
        }
      }
      return { emits: out, unresolved: false }
    }
    return { emits: [], unresolved: true }
  }
  const arg = callNode.arguments?.[0]
  return extractEmitsFromValue(arg)
}

function extractEmitsFromValue(arg: any): { emits: string[], unresolved: boolean } {
  if (!arg)
    return { emits: [], unresolved: false }
  if (arg.type === 'ArrayExpression') {
    const out: string[] = []
    for (const el of arg.elements ?? []) {
      if (el?.type === 'Literal' && typeof el.value === 'string')
        out.push(el.value)
    }
    return { emits: out, unresolved: false }
  }
  if (arg.type === 'ObjectExpression') {
    const out: string[] = []
    for (const prop of arg.properties ?? []) {
      const key = propKey(prop)
      if (key)
        out.push(key)
    }
    return { emits: out, unresolved: false }
  }
  return { emits: [], unresolved: true }
}

function extractStringKeyedTypeLiteral(callNode: any): { keys: string[], unresolved: boolean } {
  const typeArg = callNode.typeArguments?.params?.[0] ?? callNode.typeParameters?.params?.[0]
  if (typeArg?.type === 'TSTypeLiteral') {
    const out: string[] = []
    for (const member of typeArg.members ?? []) {
      if (member.type !== 'TSPropertySignature' && member.type !== 'TSMethodSignature')
        continue
      if (member.key?.type === 'Identifier')
        out.push(member.key.name)
      else if (member.key?.type === 'Literal' && typeof member.key.value === 'string')
        out.push(member.key.value)
    }
    return { keys: out, unresolved: false }
  }
  return { keys: [], unresolved: !!typeArg }
}

function extractExpose(callNode: any): { keys: string[], unresolved: boolean } {
  const arg = callNode.arguments?.[0]
  if (arg?.type === 'ObjectExpression') {
    const out: string[] = []
    for (const prop of arg.properties ?? []) {
      const key = propKey(prop)
      if (key)
        out.push(key)
    }
    return { keys: out, unresolved: false }
  }
  return { keys: [], unresolved: !!arg }
}

function stringifyTypeNode(node: any): string | undefined {
  if (!node)
    return undefined
  if (node.type === 'Identifier')
    return node.name
  if (node.type === 'TSTypeReference' && node.typeName?.type === 'Identifier')
    return node.typeName.name
  if (node.type === 'TSStringKeyword')
    return 'String'
  if (node.type === 'TSNumberKeyword')
    return 'Number'
  if (node.type === 'TSBooleanKeyword')
    return 'Boolean'
  if (node.type === 'TSArrayType')
    return `${stringifyTypeNode(node.elementType) ?? '?'}[]`
  return undefined
}

function walkAst(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== 'object')
    return
  if (typeof node.type === 'string')
    visit(node)
  for (const key in node) {
    if (key === 'parent' || key === 'loc' || key === 'range')
      continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value) walkAst(child, visit)
    }
    else if (value && typeof value === 'object' && typeof value.type === 'string') {
      walkAst(value, visit)
    }
  }
}

function dedupePropsByName(props: PropSig[]): PropSig[] {
  const out = new Map<string, PropSig>()
  for (const p of props) {
    const existing = out.get(p.name)
    if (!existing) {
      out.set(p.name, p)
      continue
    }
    out.set(p.name, {
      name: p.name,
      type: existing.type ?? p.type,
      required: existing.required ?? p.required,
      hasDefault: existing.hasDefault || p.hasDefault,
    })
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}
