export type Runner = 'codex' | 'opencode'
export type RunnerMode = Runner | 'split' | 'both'

/** Keep filtered cases assigned to their original batch position. */
export function runnersForCase(mode: RunnerMode, index: number, count: number): Runner[] {
  if (mode === 'both')
    return index % 2 ? ['opencode', 'codex'] : ['codex', 'opencode']
  if (mode === 'split')
    return [index < Math.ceil(count / 2) ? 'codex' : 'opencode']
  return [mode]
}
