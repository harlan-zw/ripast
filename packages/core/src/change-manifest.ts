import type { FileChange } from './util.ts'
import { sep } from 'node:path'
import { structuredPatch } from 'diff'

export interface FileMoveSnapshot {
  from: string
  to: string
  before: string
  after: string
}

/** [path, lines] or [path, before lines, after lines]. Lines are inclusive and one-based. */
export type ChangeManifestEntry = [path: string, lines: string] | [path: string, before: string, after: string]
export interface ChangeManifest {
  changes: ChangeManifestEntry[]
  moves?: [from: string, to: string][]
}

/** Commas separate ranges. A trailing + marks an empty gap after that line. */
export function buildChangeManifest(changes: Pick<FileChange, 'rel' | 'before' | 'after'>[], move?: FileMoveSnapshot): ChangeManifest {
  const path = (relativePath: string) => relativePath.split(sep).join('/')
  const range = (start: number, count: number) => count === 0 ? `${start - 1}+` : count === 1 ? `${start}` : `${start}-${start + count - 1}`
  const snapshots = move && move.before !== move.after
    ? [...changes, { rel: move.to, before: move.before, after: move.after }]
    : changes
  const entries: ChangeManifestEntry[] = snapshots.flatMap((change) => {
    const hunks = structuredPatch('', '', change.before, change.after, '', '', { context: 0 }).hunks
    if (!hunks.length)
      return []
    const before = hunks.map(h => range(h.oldStart, h.oldLines)).join(',')
    const after = hunks.map(h => range(h.newStart, h.newLines)).join(',')
    const entry: ChangeManifestEntry = before === after ? [path(change.rel), before] : [path(change.rel), before, after]
    return [entry]
  })
  entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  return { changes: entries, ...(move ? { moves: [[path(move.from), path(move.to)] as [string, string]] } : {}) }
}
