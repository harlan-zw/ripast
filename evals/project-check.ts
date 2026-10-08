import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { gradeFiles } from './core.ts'

export function projectFiles(dir: string, prefix = ''): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules')
      return []
    if (entry.isDirectory())
      return Object.entries(projectFiles(join(dir, entry.name), `${prefix}${entry.name}/`))
    return /\.(?:ts|tsx|vue)$/.test(entry.name) ? [[`${prefix}${entry.name}`, readFileSync(join(dir, entry.name), 'utf8')]] : []
  }))
}

export function diagnostics(dir: string): Record<string, number> {
  const files = Object.keys(projectFiles(dir)).filter(path => /\.tsx?$/.test(path)).map(path => join(dir, path))
  if (!files.length)
    return {}
  const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true, skipLibCheck: true })
  const counts: Record<string, number> = {}
  for (const item of ts.getPreEmitDiagnostics(program)) {
    const key = `${item.file ? relative(dir, item.file.fileName) : ''}:${item.code}:${ts.flattenDiagnosticMessageText(item.messageText, ' ')}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

export interface ProjectEvidence {
  initial: Record<string, string>
  expected: Record<string, string>
  baseline: Record<string, number>
  configuration: Record<string, string>
}

export function checkProject(dir: string, evidence: ProjectEvidence): string[] {
  const actual = projectFiles(dir)
  const tsExpected = Object.fromEntries(Object.entries(evidence.expected).filter(([path]) => !path.endsWith('.vue')))
  const tsActual = Object.fromEntries(Object.entries(actual).filter(([path]) => !path.endsWith('.vue')))
  const issues = gradeFiles(tsExpected, tsActual)
  for (const [path, content] of Object.entries(evidence.expected)) {
    if (path.endsWith('.vue') && actual[path] !== content)
      issues.push(`Unexpected Vue diff: ${path}`)
  }
  for (const path of Object.keys(actual)) {
    if (path.endsWith('.vue') && !(path in evidence.expected))
      issues.push(`Unexpected Vue file: ${path}`)
  }
  for (const [path, content] of Object.entries(evidence.configuration)) {
    if (!existsSync(join(dir, path)) || readFileSync(join(dir, path), 'utf8') !== content)
      issues.push(`Configuration changed: ${path}`)
  }
  for (const [key, count] of Object.entries(diagnostics(dir))) {
    if (count > (evidence.baseline[key] ?? 0))
      issues.push(`New diagnostic: ${key}`)
  }
  return issues
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = resolve(process.argv[2]!)
  const evidence = JSON.parse(readFileSync(process.argv[3]!, 'utf8')) as ProjectEvidence
  const issues = checkProject(dir, evidence)
  const changed = Object.keys(evidence.expected).filter(path => evidence.expected[path] !== evidence.initial[path])
  console.log(JSON.stringify({ passed: issues.length === 0, changed, baselineDiagnostics: Object.values(evidence.baseline).reduce((sum, count) => sum + count, 0), issues }))
  process.exitCode = issues.length ? 1 : 0
}
