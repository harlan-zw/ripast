import type { FrameworkAdapter } from './adapter.ts'
import type { LspDiagnostic, TsServer } from './ts-server.ts'
import type { FileChange } from './util.ts'
import { relative } from 'node:path'
import { rgFiles } from './util.ts'

export interface Regression {
  file: string
  line: number
  col: number
  code: number
  message: string
}
/** Extension verification runs in injection order without writing files. */
export async function findExtensionRegressions(cwd: string, changes: FileChange[], tsconfigPath: string | null, extensions: readonly FrameworkAdapter[] = []): Promise<Regression[]> {
  if (!changes.length)
    return []
  const regressions: Regression[] = []
  for (const extension of extensions) {
    if (!rgFiles('', { cwd, glob: extension.suffixes.map(suffix => `*${suffix}`), listAll: true }).length)
      continue
    if (!tsconfigPath || !extension.regressions)
      throw new Error(`Extension verification requires a tsconfig and semantic service: ${extension.name}`)
    regressions.push(...await extension.regressions(tsconfigPath, cwd, changes))
  }
  return regressions
}
/**
 * Diagnostics-based regression check against the native TypeScript server.
 * Opens every change with its `before` text (so files that do not exist on
 * disk yet are visible), pulls errors for `files`, pushes each change's
 * `after` text as an in-memory overlay, pulls again, and reports diagnostics
 * whose count went up. Nothing touches disk.
 */
export async function findRegressions(server: TsServer, changes: FileChange[], files: string[]): Promise<Regression[]> {
  const scope = [...new Set([...files, ...changes.map(c => c.path)])]
  for (const change of changes)
    server.open(change.path, change.before)
  const before = await server.diagnostics(scope)
  const baseline = new Map<string, number>()
  for (const [path, items] of before) {
    for (const d of items) {
      const key = diagnosticKey(path, d)
      baseline.set(key, (baseline.get(key) ?? 0) + 1)
    }
  }
  for (const change of changes)
    server.open(change.path, change.after)
  const after = await server.diagnostics(scope)
  const seen = new Map<string, number>()
  const out: Regression[] = []
  for (const [path, items] of after) {
    for (const d of items) {
      const key = diagnosticKey(path, d)
      const count = (seen.get(key) ?? 0) + 1
      seen.set(key, count)
      if (count <= (baseline.get(key) ?? 0))
        continue
      out.push({
        file: path,
        line: d.range.start.line + 1,
        col: d.range.start.character + 1,
        code: typeof d.code === 'number' ? d.code : Number(d.code) || 0,
        message: d.message,
      })
    }
  }
  return out
}
function diagnosticKey(path: string, d: LspDiagnostic): string {
  return `${path}::${d.code ?? ''}::${d.message}`
}
export function formatRegressions(regressions: Regression[], cwd: string): string {
  const lines = [`${regressions.length} new type diagnostic${regressions.length === 1 ? '' : 's'} introduced:`]
  for (const r of regressions) {
    lines.push(`  ${relative(cwd, r.file)}:${r.line}:${r.col} TS${r.code} ${r.message}`)
  }
  return lines.join('\n')
}
