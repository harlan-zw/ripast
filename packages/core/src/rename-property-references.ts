import type { LspTextEdit, TsServer } from './ts-server.ts'
import { readFileSync } from 'node:fs'
import { walk } from 'oxc-walker'
import { parseSource } from './declarations.ts'
import { offsetOfPosition } from './ts-server.ts'
import { posToLineCol } from './util.ts'

/** Recover property references omitted by native TypeScript's rename search. */
export async function recoverPropertyReferences(
  server: TsServer,
  paths: string[],
  declarations: { filePath: string, pos: number }[],
  from: string,
  to: string,
  editsByPath: Map<string, Map<string, LspTextEdit>>,
): Promise<void> {
  if (from === to)
    return
  const selected = new Set(declarations.map(declaration => `${declaration.filePath}:${declaration.pos}`))
  for (const path of paths) {
    const source = readFileSync(path, 'utf8')
    const existing = editsByPath.get(path) ?? new Map<string, LspTextEdit>()
    const covered = new Set([...existing.values()].map(edit => offsetOfPosition(source, edit.range.start)))
    const properties: { start: number, end: number }[] = []
    walk(parseSource(path, source).program, {
      enter(node: any) {
        if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier' && node.property.name === from && !covered.has(node.property.start))
          properties.push(node.property)
      },
    })
    for (const property of properties) {
      const definitions = await server.definition(path, property.start)
      if (!definitions.length || !definitions.every(site => selected.has(`${site.path}:${site.start}`)))
        continue
      const start = posToLineCol(source, property.start)
      const end = posToLineCol(source, property.end)
      const range = {
        start: { line: start.line - 1, character: start.col - 1 },
        end: { line: end.line - 1, character: end.col - 1 },
      }
      existing.set(`${range.start.line}:${range.start.character}:${range.end.line}:${range.end.character}:${to}`, { range, newText: to })
    }
    if (existing.size)
      editsByPath.set(path, existing)
  }
}
