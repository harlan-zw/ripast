import type { FrameworkAdapter } from './adapter.ts'
import type { TsServer } from './ts-server.ts'
import type { FileChange } from './util.ts'
import type { DiagnosticRecorder } from './verification.ts'
import { diagnosticRegressions } from './diagnostic-matching.ts'
import { rgFiles } from './util.ts'

export interface Regression {
  file: string
  line: number
  col: number
  code: number
  message: string
}

/** Project verification includes Vue consumers even when only scripts change. */
export async function findVueRegressions(cwd: string, changes: FileChange[], tsconfigPath: string | null, loadVueAdapter: () => Promise<FrameworkAdapter | null>, onChecked?: DiagnosticRecorder): Promise<Regression[]> {
  if (!changes.length || !rgFiles('', { cwd, glob: '*.vue', listAll: true }).length)
    return []
  if (!tsconfigPath)
    throw new Error('ripide: Vue verification requires a tsconfig. Prepare the project before applying changes.')
  const adapter = await loadVueAdapter()
  if (!adapter)
    throw new Error('ripide: Vue verification requires ripide-vue. Install the adapter before applying changes.')
  return adapter.regressions(tsconfigPath, cwd, changes, onChecked)
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
