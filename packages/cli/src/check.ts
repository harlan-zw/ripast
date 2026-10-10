import type { FunctionCoverage, InlineTestResult } from './test-result.ts'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { parseSourceFile, rgFiles } from 'ripide-api/adapter'
import { isFunctionCoverage } from './test-result.ts'
import { runInlineTest } from './test-runner.ts'

export type { FunctionCoverage, InlineTestRequest, InlineTestResult } from './test-result.ts'
export { runInlineTest } from './test-runner.ts'

interface Node { type: string, start: number, end: number, [key: string]: unknown }
interface Subject {
  body: { line: number, column: number }
  file: string
  name: string
  exportName?: string
  line: number
  endLine: number
  start: number
  end: number
  code: string
  signature: string
  node: Node
}
export interface CheckItem {
  body: { line: number, column: number }
  id: string
  kind: 'unit' | 'integration' | 'api' | 'manual'
  file: string
  symbol: string
  line: number
  status: 'pending' | 'executed' | 'stale'
  reason: string
  target?: { file: string, symbol: string, line: number, body: { line: number, column: number } }
  uncoveredBranches?: number
  execution?: { caller: boolean, callee: boolean }
}
export interface CheckChecklist {
  base: string
  fingerprint: string
  items: CheckItem[]
  counts: { pending: number, executed: number, stale: number }
}
interface Receipt { fingerprint: string, ids: string[], coverage: FunctionCoverage[] }
export interface CheckOptions { cwd: string, base?: string, from?: string, symbol?: string, source?: string, config?: string, project?: string, timeoutMs?: number }
export type CheckResult
  = | { _tag: 'Checklist', checklist: CheckChecklist }
    | { _tag: 'Run', subject: { file: string, symbol?: string }, result: InlineTestResult, checklist?: CheckChecklist }

function node(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string'
}
function nodes(value: unknown): Node[] {
  return Array.isArray(value) ? value.filter(node) : []
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
function identifier(value: unknown): string {
  return node(value) ? text(value.name ?? value.value) : ''
}
function walk(value: unknown, visit: (value: Node) => void): void {
  if (node(value)) {
    visit(value)
    for (const child of Object.values(value)) {
      if (node(child) || Array.isArray(child))
        walk(child, visit)
    }
  }
  else if (Array.isArray(value)) {
    for (const child of value) walk(child, visit)
  }
}
function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
}
function projectFiles(cwd: string): string[] {
  return rgFiles('', { cwd, listAll: true, glob: ['*.ts', '*.tsx', '*.js', '*.jsx', '*.mts', '*.mjs', '*.cts', '*.cjs', '!**/*.d.ts', '!**/dist/**', '!**/coverage/**'] }).sort()
}
function normalized(cwd: string, file: string): string {
  return relative(cwd, resolve(cwd, file)).replaceAll('\\', '/')
}
function inspectFile(cwd: string, file: string, source: string): { subjects: Subject[], program: Node } {
  const program = parseSourceFile(resolve(cwd, file), source, cwd).program as unknown as Node
  const subjects: Subject[] = []
  const exports = new Map<string, string>()
  for (const statement of nodes(program?.body)) {
    if (statement.type === 'ExportNamedDeclaration') {
      for (const specifier of nodes(statement.specifiers))
        exports.set(identifier(specifier.local), identifier(specifier.exported))
    }
  }
  for (const statement of nodes(program?.body)) {
    const exported = statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
    const declaration = exported && node(statement.declaration) ? statement.declaration : statement
    const add = (name: string, fn: Node) => {
      const start = fn.start
      const end = fn.end
      const bodyStart = node(fn.body) ? fn.body.start : end
      const exportName = statement.type === 'ExportDefaultDeclaration' ? 'default' : exported ? name : exports.get(name)
      const bodyLines = source.slice(0, bodyStart).split('\n')
      subjects.push({ body: { line: bodyLines.length, column: bodyLines[bodyLines.length - 1].length }, file, name, exportName, start, end, line: source.slice(0, start).split('\n').length, endLine: source.slice(0, end).split('\n').length, code: source.slice(start, end), signature: source.slice(start, bodyStart).trim(), node: fn })
    }
    if (declaration.type === 'FunctionDeclaration')
      add(identifier(declaration.id) || 'default', declaration)
    if (declaration.type === 'VariableDeclaration') {
      for (const binding of nodes(declaration.declarations)) {
        if (node(binding.init) && ['ArrowFunctionExpression', 'FunctionExpression'].includes(binding.init.type) && identifier(binding.id))
          add(identifier(binding.id), binding.init)
      }
    }
  }
  return { subjects, program }
}
function item(subject: Subject, kind: CheckItem['kind'], reason: string, target?: CheckItem['target']): CheckItem {
  return { body: subject.body, id: hash(JSON.stringify([kind, subject.file, subject.name, target && [target.file, target.symbol]])).slice(0, 16), kind, file: subject.file, symbol: subject.exportName === 'default' ? subject.name : subject.exportName ?? subject.name, line: subject.line, status: 'pending', reason, ...(target ? { target } : {}) }
}
function resolveImport(cwd: string, importer: string, specifier: string, files: Set<string>): string | undefined {
  if (!specifier.startsWith('.'))
    return undefined
  const path = normalized(cwd, resolve(cwd, dirname(importer), specifier))
  const stem = path.replace(/\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/, '')
  return [path, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js'].map(ext => stem + ext)].find(file => files.has(file))
}
function receiptPath(cwd: string): string {
  return join(homedir(), 'scratch', 'ripide-check', hash(cwd), 'receipts.json')
}
function readReceipts(cwd: string): Receipt[] {
  const path = receiptPath(cwd)
  if (!existsSync(path))
    return []
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(value) || !value.every(entry => typeof entry?.fingerprint === 'string'
    && Array.isArray(entry.ids) && entry.ids.every((id: unknown) => typeof id === 'string')
    && Array.isArray(entry.coverage) && entry.coverage.every(isFunctionCoverage))) {
    throw new Error(`Invalid check evidence at ${path}. Remove this file and rerun checks.`)
  }
  return value as Receipt[]
}
function matchingCoverage(item: Pick<CheckItem, 'file' | 'body'>, coverage: FunctionCoverage[]): FunctionCoverage | undefined {
  return coverage.find(fn => fn.file === item.file && fn.startLine === item.body.line && fn.startColumn === item.body.column && fn.hits > 0)
}

/** Build a conservative checklist. Dynamic calls and type contracts still require review. */
export function buildCheckChecklist(options: Pick<CheckOptions, 'cwd' | 'base'>): CheckChecklist {
  const cwd = resolve(options.cwd)
  const repository = git(cwd, ['rev-parse', '--show-toplevel']).trim()
  if (resolve(repository) !== cwd)
    throw new Error('Run the Git checklist from the repository root.')
  const base = git(cwd, ['rev-parse', '--verify', `${options.base ?? 'HEAD'}^{commit}`]).trim()
  const changed = new Set([...git(cwd, ['diff', '--name-only', '-z', base, '--']).split('\0'), ...git(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')].filter(Boolean))
  const files = projectFiles(cwd).map(file => normalized(cwd, file))
  const parsed = new Map(files.map(file => [file, inspectFile(cwd, file, readFileSync(resolve(cwd, file), 'utf8'))]))
  const items: CheckItem[] = []
  const changedSubjects: Subject[] = []
  for (const file of changed) {
    const current = parsed.get(file)
    if (!/\.(?:[cm]?[jt]s|tsx|jsx)$/.test(file))
      continue
    const existed = git(cwd, ['ls-tree', '-z', base, '--', file]).length > 0
    const beforeSource = existed ? git(cwd, ['show', `${base}:${file}`]) : ''
    const before = inspectFile(cwd, file, beforeSource)
    for (const subject of current?.subjects ?? []) {
      const previous = before.subjects.find(fn => fn.name === subject.name)
      if (previous?.code === subject.code)
        continue
      changedSubjects.push(subject)
      items.push(item(subject, 'unit', subject.exportName ? 'Assert changed exported behaviour.' : 'Exercise through an exported caller.'))
      if (previous?.exportName && previous.signature !== subject.signature)
        items.push(item(subject, 'api', 'The function signature changed. Check consumer types and compatibility.'))
    }
    for (const previous of before.subjects) {
      if (previous.exportName && !current?.subjects.some(fn => fn.exportName === previous.exportName))
        items.push(item(previous, 'api', 'An export was removed. Check consumers and replacement behaviour.'))
    }
    const outsideFunctions = (source: string, subjects: Subject[]) => {
      let cursor = 0
      let remaining = ''
      for (const subject of subjects) {
        remaining += `${source.slice(cursor, subject.start)}<function:${subject.name}>`
        cursor = subject.end
      }
      return (remaining + source.slice(cursor)).trim()
    }
    const currentSource = current ? readFileSync(resolve(cwd, file), 'utf8') : ''
    if (!items.some(entry => entry.file === file) || outsideFunctions(beforeSource, before.subjects) !== outsideFunctions(currentSource, current?.subjects ?? [])) {
      items.push({ body: { line: 1, column: 0 }, id: hash(`manual:${file}`).slice(0, 16), kind: 'manual', file, symbol: '', line: 1, status: 'pending', reason: 'Review module, type, or configuration changes. Runtime coverage cannot prove this contract.' })
    }
  }
  const fileSet = new Set(files)
  for (const [file, value] of parsed) {
    const bindings = new Map<string, { file: string, symbol: string }>()
    for (const statement of nodes(value.program?.body)) {
      if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type')
        continue
      const targetFile = resolveImport(cwd, file, identifier(statement.source), fileSet)
      if (!targetFile)
        continue
      for (const specifier of nodes(statement.specifiers)) {
        if (specifier.importKind === 'type')
          continue
        bindings.set(identifier(specifier.local), { file: targetFile, symbol: specifier.type === 'ImportDefaultSpecifier' ? 'default' : identifier(specifier.imported) || '*' })
      }
    }
    for (const caller of value.subjects) {
      const targets = new Set<Subject>()
      walk(caller.node, (call) => {
        if (call.type !== 'CallExpression' || !node(call.callee))
          return
        const callee = call.callee
        const binding = callee.type === 'Identifier'
          ? bindings.get(identifier(callee))
          : callee.type === 'MemberExpression' && !callee.computed ? bindings.get(identifier(callee.object)) : undefined
        const importedName = binding?.symbol === '*' ? identifier(callee.property) : binding?.symbol
        const target = changedSubjects.find(subject => subject !== caller && (binding
          ? subject.file === binding.file && subject.exportName === importedName
          : subject.file === file && subject.name === identifier(callee)))
        if (target)
          targets.add(target)
      })
      for (const target of targets) {
        items.push(item(caller, 'integration', 'Run this caller with the real changed function. Review assertions on their combined behaviour.', { file: target.file, symbol: target.exportName ?? target.name, line: target.line, body: target.body }))
      }
    }
  }
  const inputs = new Set([...files, ...git(cwd, ['ls-files', '-z']).split('\0').filter(file => /lock|package\.json$|config\.|\.json$/.test(file))])
  const fingerprint = hash(base + [...inputs].sort().map(file => `${file}\0${existsSync(resolve(cwd, file)) ? hash(readFileSync(resolve(cwd, file), 'utf8')) : 'deleted'}`).join('\0'))
  const receipts = readReceipts(cwd)
  for (const entry of items) {
    const currentReceipts = receipts.filter(receipt => receipt.fingerprint === fingerprint && receipt.ids.includes(entry.id))
    if (currentReceipts.length) {
      if (entry.kind === 'integration' && entry.target) {
        const latest = currentReceipts[currentReceipts.length - 1]
        entry.execution = { caller: Boolean(matchingCoverage(entry, latest.coverage)), callee: Boolean(matchingCoverage(entry.target, latest.coverage)) }
        continue
      }
      entry.status = 'executed'
      const branches = new Map<string, number>()
      for (const receipt of currentReceipts) {
        const coverage = matchingCoverage(entry, receipt.coverage)
        coverage?.branches.forEach((branch, branchIndex) => branch.hits.forEach((hits, index) => {
          const key = `${branch.line}:${branchIndex}:${index}`
          branches.set(key, Math.max(branches.get(key) ?? 0, hits))
        }))
      }
      entry.uncoveredBranches = [...branches.values()].filter(hits => hits === 0).length
    }
    else if (receipts.some(receipt => receipt.ids.includes(entry.id))) {
      entry.status = 'stale'
    }
  }
  return { base, fingerprint, items, counts: {
    pending: items.filter(item => item.status === 'pending').length,
    executed: items.filter(item => item.status === 'executed').length,
    stale: items.filter(item => item.status === 'stale').length,
  } }
}

export async function runCheck(options: CheckOptions): Promise<CheckResult> {
  const cwd = resolve(options.cwd)
  if (options.source === undefined)
    return { _tag: 'Checklist', checklist: buildCheckChecklist(options) }
  if (options.symbol === 'default')
    throw new Error('For an anonymous default export, pass --from and supply a full test module.')
  const files = options.from ? [normalized(cwd, options.from)] : projectFiles(cwd).map(file => normalized(cwd, file))
  const matches = options.symbol
    ? files.flatMap(file => inspectFile(cwd, file, readFileSync(resolve(cwd, file), 'utf8')).subjects.filter(subject => subject.exportName === options.symbol || (subject.exportName === 'default' && subject.name === options.symbol)))
    : []
  if (options.symbol && matches.length !== 1) {
    throw new Error(matches.length
      ? `Several exports match ${options.symbol}. Pass --from. Matches: ${matches.map(fn => fn.file).join(', ')}.`
      : `No exported function matches ${options.symbol}. Pass --from or supply a full test module.`)
  }
  const from = matches[0]?.file ?? options.from
  if (!from)
    throw new Error('Pass a function name or --from for a full test module.')
  // An explicit baseline enables receipts. Standalone snippets do not require Git.
  const before = options.base ? buildCheckChecklist(options) : undefined
  const coverageFiles = before ? [...new Set(before.items.flatMap(entry => [entry.file, ...entry.target ? [entry.target.file] : []]))].filter(file => existsSync(resolve(cwd, file))) : [from]
  const result = await runInlineTest({ cwd, from, source: options.source, symbol: options.symbol, importName: matches[0]?.exportName === 'default' ? 'default' : undefined, config: options.config, project: options.project, timeoutMs: options.timeoutMs, coverageFiles })
  if (before && result._tag === 'Passed') {
    const after = buildCheckChecklist(options)
    if (after.fingerprint === before.fingerprint) {
      const ids = before.items.filter(entry => (entry.kind === 'unit' || entry.kind === 'integration') && matchingCoverage(entry, result.coverage)).map(entry => entry.id)
      // Aggregate coverage cannot prove a caller-to-callee edge. Keep integration review pending.
      const receipt: Receipt = { fingerprint: before.fingerprint, ids, coverage: result.coverage }
      const path = receiptPath(cwd)
      mkdirSync(dirname(path), { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      writeFileSync(temporary, JSON.stringify([...readReceipts(cwd).slice(-99), receipt]))
      renameSync(temporary, path)
    }
  }
  return { _tag: 'Run', subject: { file: from, symbol: options.symbol }, result, ...(before ? { checklist: buildCheckChecklist(options) } : {}) }
}
