import type { EngineServices } from './engine.ts'
import type { TsServer } from './ts-server.ts'
import type { FileChange } from './util.ts'
import type { DiagnosticRecorder } from './verification.ts'
import { relative } from 'node:path'
import { diagnosticRegressions } from './diagnostic-matching.ts'
import { rgFiles } from './util.ts'

export interface Regression {
  file: string
  line: number
  col: number
  code: number
  message: string
}

/** Verify every relevant extension, including unchanged authored consumers. */
export async function findExtensionRegressions(cwd: string, changes: FileChange[], tsconfigPath: string | null, engine?: EngineServices, recorder?: (name: string) => DiagnosticRecorder): Promise<Regression[]> {
  if (!changes.length || !engine?.extensions.length)
    return []
  const regressions: Regression[] = []
  for (const extension of engine.extensions) {
    // Custom verifiers run after hooks at the engine's final verification boundary.
    if (extension.verify)
      continue
    if (!rgFiles('', { cwd, glob: extension.suffixes.map(suffix => `*${suffix}`), listAll: true }).length)
      continue
    if (!extension.semantic)
      throw new Error(`Extension ${extension.name} cannot verify consumers`)
    if (!tsconfigPath)
      throw new Error('Extension verification requires a tsconfig. Prepare the project before applying changes.')
    regressions.push(...await extension.semantic.regressions(tsconfigPath, cwd, changes, recorder?.(extension.semantic.name)))
  }
  return regressions
}

/**
 * Diagnostics-based regression check against the native TypeScript server.
 * Opens every change with its `before` text (so files that do not exist on
 * disk yet are visible), pulls errors for `files`, pushes each change's
 * `after` text as an in-memory overlay, pulls again, and reports diagnostics
 * that do not match an unchanged baseline source range. Nothing touches disk.
 */
export async function findRegressions(server: TsServer, changes: FileChange[], files: string[], onChecked?: DiagnosticRecorder): Promise<Regression[]> {
  const scope = [...new Set([...files, ...changes.map(c => c.path)])]
  for (const change of changes)
    server.open(change.path, change.before)
  const before = await server.diagnostics(scope)

  for (const change of changes)
    server.open(change.path, change.after)

  const after = await server.diagnostics(scope)
  const out = diagnosticRegressions(before, after, changes)
  onChecked?.({ files: scope.length, newErrors: out.length })
  return out
}

export function formatRegressions(regressions: Regression[], cwd: string): string {
  const lines = [`${regressions.length} new type diagnostic${regressions.length === 1 ? '' : 's'} introduced:`]
  for (const r of regressions) {
    lines.push(`  ${relative(cwd, r.file)}:${r.line}:${r.col} TS${r.code} ${r.message}`)
  }
  return lines.join('\n')
}
