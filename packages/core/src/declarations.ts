import { parseSync } from 'oxc-parser'
import { walk } from 'oxc-walker'

// Top-level declarations as data, from oxc. Positions are offsets into the
// source the program was parsed from.

export type DeclarationKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'variable'

export interface TopLevelDeclaration {
  name: string
  kind: DeclarationKind
  exported: boolean
  isDefault: boolean
  /** Offset of the name identifier. */
  nameStart: number
  nameEnd: number
  /** Statement range, including `export` and decorators. */
  start: number
  end: number
  /** The declaration node (function, class, interface, type alias, enum, or variable declaration). */
  node: any
  /** For variables: how many declarators the statement holds. */
  declaratorCount: number
  variableKind?: 'const' | 'let' | 'var' | 'using' | 'await using'
}

export interface ParsedSource {
  program: any
  comments: { start: number, end: number }[]
}

const KIND_BY_TYPE: Record<string, DeclarationKind> = {
  FunctionDeclaration: 'function',
  ClassDeclaration: 'class',
  TSInterfaceDeclaration: 'interface',
  TSTypeAliasDeclaration: 'type',
  TSEnumDeclaration: 'enum',
}

export const NAMED_DECLARATION_TYPES = new Set(Object.keys(KIND_BY_TYPE))

export function parseSource(path: string, source: string): ParsedSource {
  const result = parseSync(path, source)
  return { program: result.program, comments: (result.comments ?? []).map((c: any) => ({ start: c.start, end: c.end })) }
}

export function listTopLevelDeclarations(program: any): TopLevelDeclaration[] {
  const out: TopLevelDeclaration[] = []
  for (const statement of program.body ?? []) {
    const exported = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
    const isDefault = statement.type === 'ExportDefaultDeclaration'
    const node = exported ? statement.declaration : statement
    if (!node)
      continue
    const start = Math.min(statement.start, ...(node.decorators ?? []).map((d: any) => d.start))
    if (node.type === 'VariableDeclaration') {
      const declarators = node.declarations ?? []
      for (const declarator of declarators) {
        if (declarator.id?.type !== 'Identifier')
          continue
        out.push({
          name: declarator.id.name,
          kind: 'variable',
          exported,
          isDefault,
          nameStart: declarator.id.start,
          nameEnd: declarator.id.start + declarator.id.name.length,
          start,
          end: statement.end,
          node,
          declaratorCount: declarators.length,
          variableKind: node.kind,
        })
      }
      continue
    }
    const kind = KIND_BY_TYPE[node.type]
    if (!kind || node.id?.type !== 'Identifier')
      continue
    out.push({
      name: node.id.name,
      kind,
      exported,
      isDefault,
      nameStart: node.id.start,
      nameEnd: node.id.end,
      start,
      end: statement.end,
      node,
      declaratorCount: 0,
    })
  }
  return out
}

/** Names exported through same-file `export { a, b as c }` lists (no module specifier). */
export function localExportSpecifierNames(program: any): Set<string> {
  const out = new Set<string>()
  for (const statement of program.body ?? []) {
    if (statement.type !== 'ExportNamedDeclaration' || statement.declaration || statement.source)
      continue
    for (const spec of statement.specifiers ?? []) {
      const local = spec.local?.name ?? spec.local?.value
      if (local)
        out.add(local)
    }
  }
  return out
}

/** Ranges of same-file `export { ... }` lists, so references inside them can be ignored. */
export function localExportSpecifierRanges(program: any): { start: number, end: number }[] {
  const out: { start: number, end: number }[] = []
  for (const statement of program.body ?? []) {
    if (statement.type === 'ExportNamedDeclaration' && !statement.declaration && !statement.source)
      out.push({ start: statement.start, end: statement.end })
  }
  return out
}

/**
 * Start of the declaration including directly attached leading comments.
 * A blank line between a comment and the declaration breaks the attachment.
 */
export function declarationStartWithComments(source: string, comments: { start: number, end: number }[], decl: TopLevelDeclaration): number {
  let start = decl.start
  const sorted = [...comments].filter(c => c.end <= start).sort((a, b) => b.end - a.end)
  for (const comment of sorted) {
    const gap = source.slice(comment.end, start)
    if (!/^\s*$/.test(gap) || /\n[ \t]*\n/.test(gap))
      break
    start = comment.start
  }
  return start
}

export function declarationText(source: string, comments: { start: number, end: number }[], decl: TopLevelDeclaration): string {
  return source.slice(declarationStartWithComments(source, comments, decl), decl.end)
}

/** Remove a declaration statement, its attached leading comments, and the line break after it. */
export function removeDeclaration(source: string, comments: { start: number, end: number }[], decl: TopLevelDeclaration): string {
  const start = declarationStartWithComments(source, comments, decl)
  let end = decl.end
  if (source[end] === '\n')
    end++
  // Drop indentation left on the line when the statement was not at column 0.
  let lineStart = start
  while (lineStart > 0 && (source[lineStart - 1] === ' ' || source[lineStart - 1] === '\t'))
    lineStart--
  const from = lineStart === 0 || source[lineStart - 1] === '\n' ? lineStart : start
  return source.slice(0, from) + source.slice(end)
}

/** Identifier names bound inside `node` (parameters, locals, nested declarations, type parameters). */
export function localBindingNames(node: any): Set<string> {
  const out = new Set<string>()
  const addPattern = (pattern: any): void => {
    if (!pattern)
      return
    switch (pattern.type) {
      case 'Identifier':
        out.add(pattern.name)
        break
      case 'ObjectPattern':
        for (const prop of pattern.properties ?? []) addPattern(prop.value ?? prop.argument)
        break
      case 'ArrayPattern':
        for (const element of pattern.elements ?? []) addPattern(element)
        break
      case 'AssignmentPattern':
        addPattern(pattern.left)
        break
      case 'RestElement':
        addPattern(pattern.argument)
        break
      case 'TSParameterProperty':
        addPattern(pattern.parameter)
        break
    }
  }
  walk(node, {
    enter(child: any) {
      if (child === node)
        return
      switch (child.type) {
        case 'VariableDeclarator':
          addPattern(child.id)
          break
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
          if (child.id)
            out.add(child.id.name)
          for (const param of child.params ?? []) addPattern(param)
          break
        case 'ClassDeclaration':
        case 'ClassExpression':
        case 'TSInterfaceDeclaration':
        case 'TSTypeAliasDeclaration':
        case 'TSEnumDeclaration':
          if (child.id)
            out.add(child.id.name)
          break
        case 'TSTypeParameter':
          if (child.name)
            out.add(typeof child.name === 'string' ? child.name : child.name.name)
          break
        case 'CatchClause':
          addPattern(child.param)
          break
      }
    },
  })
  // Parameters of the declaration itself.
  for (const param of node.params ?? []) addPattern(param)
  for (const tp of node.typeParameters?.params ?? []) {
    if (tp.name)
      out.add(typeof tp.name === 'string' ? tp.name : tp.name.name)
  }
  return out
}

/** True when `node` (an Identifier) is a property name rather than a value/type reference. */
export function isPropertyNamePosition(node: any, parent: any): boolean {
  if (!parent)
    return false
  switch (parent.type) {
    case 'MemberExpression':
      return !parent.computed && parent.property === node
    case 'Property':
    case 'ObjectProperty':
      return !parent.computed && parent.key === node && parent.value !== node
    case 'PropertyDefinition':
    case 'MethodDefinition':
    case 'TSPropertySignature':
    case 'TSMethodSignature':
    case 'AccessorProperty':
      return !parent.computed && parent.key === node
    case 'TSQualifiedName':
      return parent.right === node
    case 'ImportSpecifier':
    case 'ImportDefaultSpecifier':
    case 'ImportNamespaceSpecifier':
    case 'ExportSpecifier':
      return true
    default:
      return false
  }
}
