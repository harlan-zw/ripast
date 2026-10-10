import type { FileChange } from 'ripide-api'
import process from 'node:process'
import { createPatch } from 'diff'

export function printDiffs(changes: FileChange[], out: { write: (text: string) => unknown } = process.stdout): void {
  for (const c of changes) {
    const patch = createPatch(c.rel, c.before, c.after, '', '', { context: 2 })
    out.write(patch)
  }
}

export interface ChangeSummary {
  files: number
  linesAdded: number
  linesRemoved: number
}

export function summarize(changes: FileChange[]): ChangeSummary {
  let added = 0
  let removed = 0
  for (const c of changes) {
    const diff = diffLineCounts(c.before, c.after)
    added += diff.added
    removed += diff.removed
  }
  return { files: changes.length, linesAdded: added, linesRemoved: removed }
}

function diffLineCounts(before: string, after: string): { added: number, removed: number } {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const beforeBag = new Map<string, number>()
  for (const l of beforeLines) beforeBag.set(l, (beforeBag.get(l) ?? 0) + 1)
  const afterBag = new Map<string, number>()
  for (const l of afterLines) afterBag.set(l, (afterBag.get(l) ?? 0) + 1)
  let removed = 0
  for (const [l, n] of beforeBag.entries()) {
    const a = afterBag.get(l) ?? 0
    if (n > a)
      removed += n - a
  }
  let added = 0
  for (const [l, n] of afterBag.entries()) {
    const b = beforeBag.get(l) ?? 0
    if (n > b)
      added += n - b
  }
  return { added, removed }
}
