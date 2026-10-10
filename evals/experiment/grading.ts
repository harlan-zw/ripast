import type { SymbolAssertion, SymbolSite } from './manifest.ts'
import { Buffer } from 'node:buffer'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import ts from 'typescript'

export type Quality = {
  _tag: 'Passed'
} | {
  _tag: 'Failed'
  issues: string[]
}
export function snapshotProject(directory: string, generatedDirectories: string[], prefix = ''): Record<string, string> {
  const ignored = ['.git', 'node_modules', ...generatedDirectories]
  return Object.fromEntries(readdirSync(directory).flatMap((name): [
    string,
    string,
  ][] => {
    if (name === 'node_modules' || name === '.git')
      return []
    const relative = prefix ? `${prefix}/${name}` : name
    if (ignored.some(path => relative === path || relative.startsWith(`${path}/`)))
      return []
    const path = join(directory, name)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink())
      return [[relative, `@symlink:${readlinkSync(path)}`]]
    if (stat.isDirectory())
      return Object.entries(snapshotProject(path, generatedDirectories, relative))
    return [[relative, readFileSync(path).toString('base64')]]
  }))
}
export function expectedProject(initial: Record<string, string>, expected: Record<string, string | null>): Record<string, string> {
  const result = { ...initial }
  for (const [path, content] of Object.entries(expected)) {
    if (content === null)
      delete result[path]
    else
      result[path] = Buffer.from(content).toString('base64')
  }
  return result
}
export function gradeProject(directory: string, expectedText: Record<string, string>, generatedDirectories: string[], assertions: SymbolAssertion[], encoded = false, behavioralFiles: string[] = []): Quality {
  const actual = snapshotProject(directory, generatedDirectories)
  const expected = encoded ? expectedText : Object.fromEntries(Object.entries(expectedText).map(([k, v]) => [k, Buffer.from(v).toString('base64')]))
  const issues: string[] = []
  for (const [path, content] of Object.entries(expected)) {
    if (!(path in actual) || (!behavioralFiles.includes(path) && actual[path] !== content))
      issues.push(`Unexpected file content: ${path}`)
  }
  for (const path of Object.keys(actual)) {
    if (!(path in expected))
      issues.push(`Unexpected file: ${path}`)
  }
  if (assertions.length) {
    const roots = Object.keys(actual).filter(path => /\.(?:ts|tsx)$/.test(path)).map(path => resolve(directory, path))
    const configPath = join(directory, 'tsconfig.json')
    let options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true }
    if (existsSync(configPath)) {
      const config = ts.readConfigFile(configPath, ts.sys.readFile)
      if (config.error) {
        issues.push('Cannot read the project TypeScript configuration.')
      }
      else {
        const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, directory)
        options = { ...parsed.options, noEmit: true }
        if (parsed.errors.length)
          issues.push('Cannot parse the project TypeScript configuration.')
      }
    }
    const program = ts.createProgram(roots, options)
    const checker = program.getTypeChecker()
    const symbol = (site: SymbolSite): ts.Symbol | undefined => {
      const source = program.getSourceFile(resolve(directory, site.file))
      const nodes: ts.Identifier[] = []
      if (!source)
        return undefined
      const visit = (node: ts.Node) => {
        if (ts.isIdentifier(node) && node.text === site.name)
          nodes.push(node)
        ts.forEachChild(node, visit)
      }
      visit(source)
      const identifier = nodes[site.occurrence]
      const found = identifier ? checker.getSymbolAtLocation(identifier) : undefined
      const resolved = found && (found.flags & ts.SymbolFlags.Alias) ? checker.getAliasedSymbol(found) : found
      return resolved?.declarations?.length ? resolved : undefined
    }
    for (const assertion of assertions) {
      const target = symbol(assertion.declaration)
      if (!target)
        issues.push(`Missing declared symbol: ${assertion.declaration.file}:${assertion.declaration.name}`)
      for (const reference of assertion.references) {
        if (!target || symbol(reference) !== target)
          issues.push(`Reference resolves to another symbol: ${reference.file}:${reference.name}:${reference.occurrence}`)
      }
    }
  }
  return issues.length ? { _tag: 'Failed', issues } : { _tag: 'Passed' }
}
export interface VerifiedPlanAdapter<P> {
  plan: () => Promise<P>
  tamper: (plan: P) => P
  commit: (plan: P) => Promise<{
    _tag: 'Committed'
  } | {
    _tag: 'ValidationRefused'
    reason: string
  } | {
    _tag: 'Unavailable'
    reason: string
  }>
  snapshot: () => string
}
export type PlanGate = {
  _tag: 'Passed'
} | {
  _tag: 'Failed'
  reason: string
} | {
  _tag: 'Unavailable'
  reason: string
}
/** Call this on an isolated installed consumer. A mutable raw writer is not a protected-plan API. */
export async function checkChangedVerifiedPlan<P>(adapter: VerifiedPlanAdapter<P> | null): Promise<PlanGate> {
  if (!adapter)
    return { _tag: 'Unavailable', reason: 'This SDK has no protected verified-plan commit capability.' }
  const before = adapter.snapshot()
  const plan = await adapter.plan()
  const changed = adapter.tamper(plan)
  const outcome = await adapter.commit(changed)
  if (outcome._tag === 'Unavailable')
    return outcome
  if (outcome._tag === 'Committed')
    return { _tag: 'Failed', reason: 'The SDK accepted a changed verified plan.' }
  if (adapter.snapshot() !== before)
    return { _tag: 'Failed', reason: 'The rejected plan changed source bytes.' }
  return { _tag: 'Passed' }
}
