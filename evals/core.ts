import ts from 'typescript'

export type Arm = 'ripast' | 'agent'
export type CaseName = 'rename' | 'rename-file' | 'move'
export const caseNames: CaseName[] = ['rename', 'rename-file', 'move']

export interface EvalCase {
  name: CaseName
  task: string
  command: string
  initial: Record<string, string>
  expected: Record<string, string>
}

/** Construct the answer independently of Ripast. Keep unrelated symbols and strings as traps. */
export function makeCase(name: CaseName, consumers: number): EvalCase {
  const declaration = 'export function calculateTotal(value: number) { return value * 2 }\n'
  const initial: Record<string, string> = {
    'src/pricing.ts': declaration,
    'src/decoy.ts': 'export function calculateTotal(value: number) { return value * 7 }\n',
    'src/labels.ts': 'export const label = "calculateTotal"\n',
  }
  const expected = { ...initial }
  for (let i = 0; i < consumers; i++) {
    const alias = i % 2 === 0 ? 'calculateTotal' : 'total'
    const imported = alias === 'total' ? 'calculateTotal as total' : 'calculateTotal'
    const file = `src/consumer-${i}.ts`
    initial[file] = `import { ${imported} } from './pricing'\nexport const value${i} = ${alias}(${i + 1})\n`
    const renamedImport = alias === 'total' ? 'computeTotal as total' : 'computeTotal'
    expected[file] = name === 'rename'
      ? `import { ${renamedImport} } from './pricing'\nexport const value${i} = ${alias === 'total' ? 'total' : 'computeTotal'}(${i + 1})\n`
      : `import { ${imported} } from './${name === 'move' ? 'totals' : 'costs'}'\nexport const value${i} = ${alias}(${i + 1})\n`
  }
  const tasks = {
    'rename': 'Rename the exported calculateTotal function in src/pricing.ts to computeTotal. Update all references. Preserve import aliases.',
    'rename-file': 'Rename src/pricing.ts to src/costs.ts. Update all imports. Remove the old file.',
    'move': 'Move the calculateTotal export from src/pricing.ts to src/totals.ts. Update all consumers. Keep src/pricing.ts as an empty module.',
  }
  const commands = {
    'rename': 'ripast rename calculateTotal computeTotal --scope src/pricing.ts --apply --no-vue',
    'rename-file': 'ripast rename-file src/pricing.ts src/costs.ts --apply --no-vue',
    'move': 'ripast move calculateTotal --from src/pricing.ts --to src/totals.ts --apply --no-vue',
  }
  if (name === 'rename') {
    expected['src/pricing.ts'] = 'export function computeTotal(value: number) { return value * 2 }\n'
  }
  else if (name === 'rename-file') {
    delete expected['src/pricing.ts']
    expected['src/costs.ts'] = declaration
  }
  else {
    // Ripast leaves an empty source file. An empty module marker is also acceptable.
    expected['src/pricing.ts'] = ''
    expected['src/totals.ts'] = declaration
  }
  return { name, task: tasks[name], command: commands[name], initial, expected }
}

function canonical(source: string): string {
  const file = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true)
  const nodeValue = (node: ts.Node): unknown => {
    const children: unknown[] = []
    ts.forEachChild(node, (child) => {
      children.push(nodeValue(child))
    })
    return [node.kind, ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node) ? node.text : null, children]
  }
  return file.statements.filter(s => !(ts.isExportDeclaration(s) && s.exportClause && ts.isNamedExports(s.exportClause) && s.exportClause.elements.length === 0))
    .map(s => JSON.stringify(nodeValue(s)))
    .join('\n')
}

/** Compare parsed code, including decoys, independent of whitespace and quote style. */
export function gradeFiles(expected: Record<string, string>, actual: Record<string, string>): string[] {
  const errors: string[] = []
  for (const [path, content] of Object.entries(expected)) {
    if (!(path in actual))
      errors.push(`Missing file: ${path}`)
    else if (canonical(content) !== canonical(actual[path]!))
      errors.push(`Changed AST: ${path}`)
  }
  for (const path of Object.keys(actual)) {
    if (!(path in expected))
      errors.push(`Unexpected file: ${path}`)
  }
  return errors
}

export interface Usage {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  total: number
  cost: number
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function parseEvents(jsonl: string): { usage: Usage | null, steps: number, tools: number, commands: string[], issues: string[] } {
  const usage: Usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }
  let steps = 0
  let tools = 0
  const commands: string[] = []
  const issues: string[] = []
  for (const [index, line] of jsonl.split('\n').entries()) {
    if (!line.trim())
      continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    }
    catch {
      issues.push(`Invalid JSON event on line ${index + 1}`)
      continue
    }
    const event = record(parsed)
    const part = record(event.part)
    if (event.type === 'error')
      issues.push(`OpenCode error: ${JSON.stringify(event.error ?? part)}`)
    if (event.type === 'tool_use') {
      tools++
      const command = record(record(part.state).input).command
      if (typeof command === 'string')
        commands.push(command)
    }
    if (event.type !== 'step_finish')
      continue
    const tokens = record(part.tokens)
    const cache = record(tokens.cache)
    const values = [tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write]
    if (!values.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) {
      issues.push('Incomplete token usage event')
      continue
    }
    const total = (values as number[]).reduce((sum, v) => sum + v, 0)
    if (tokens.total !== undefined && tokens.total !== total) {
      issues.push('Invalid token total')
      continue
    }
    steps++
    usage.input += tokens.input as number
    usage.output += tokens.output as number
    usage.reasoning += tokens.reasoning as number
    usage.cacheRead += cache.read as number
    usage.cacheWrite += cache.write as number
    usage.total += total
    usage.cost += typeof part.cost === 'number' ? part.cost : 0
  }
  if (!steps)
    issues.push('No token usage events')
  return { usage: steps ? usage : null, steps, tools, commands, issues }
}

export interface Measurement { arm: Arm, passed: boolean, seconds: number, tokens: number | null }

function median(values: number[]): number | null {
  if (!values.length)
    return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function summarize(rows: Measurement[]) {
  const arm = (name: Arm) => {
    const all = rows.filter(r => r.arm === name)
    const passed = all.filter(r => r.passed)
    return { passed: passed.length, runs: all.length, seconds: median(passed.map(r => r.seconds)), tokens: median(passed.flatMap(r => r.tokens === null ? [] : [r.tokens])) }
  }
  const ripast = arm('ripast')
  const agent = arm('agent')
  return {
    ripast,
    agent,
    speedup: ripast.seconds && agent.seconds !== null ? agent.seconds / ripast.seconds : null,
    tokenReduction: agent.tokens && ripast.tokens !== null ? 1 - ripast.tokens / agent.tokens : null,
  }
}
