import type { FileChange } from './util.ts'
import { createHash } from 'node:crypto'
import { sep } from 'node:path'

export interface FileMoveSnapshot {
  from: string
  to: string
  before: string
  after: string
}

export type ChangeManifestEntry
  = | { _tag: 'Edit', path: string, beforeVersion: string, afterVersion: string }
    | { _tag: 'Move', from: string, to: string, beforeVersion: string, afterVersion: string }

/** SHA-256 content versions let callers invalidate file views without receiving full source. */
export function buildChangeManifest(changes: Pick<FileChange, 'rel' | 'before' | 'after'>[], move?: FileMoveSnapshot): ChangeManifestEntry[] {
  const version = (source: string) => createHash('sha256').update(source).digest('hex')
  const path = (relativePath: string) => relativePath.split(sep).join('/')
  const entries: ChangeManifestEntry[] = changes.map(change => ({
    _tag: 'Edit',
    path: path(change.rel),
    beforeVersion: version(change.before),
    afterVersion: version(change.after),
  }))
  if (move) {
    entries.push({
      _tag: 'Move',
      from: path(move.from),
      to: path(move.to),
      beforeVersion: version(move.before),
      afterVersion: version(move.after),
    })
  }
  const key = (entry: ChangeManifestEntry) => entry._tag === 'Edit' ? entry.path : entry.to
  return entries.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
}
