import type { FileChange } from '@ripast/core/adapter'
import { readFileSync } from 'node:fs'

import { basename, relative } from 'node:path'
import { rgFiles } from './discovery.ts'
import { hyphenateVueName, rewriteTemplateReferences } from './vue-template.ts'

export function templateRename(cwd: string, oldAbs: string, newAbs: string, changes: FileChange[]): FileChange[] {
  if (!oldAbs.endsWith('.vue') || !newAbs.endsWith('.vue'))
    return []
  const oldName = basename(oldAbs, '.vue')
  const newName = basename(newAbs, '.vue')
  if (oldName === newName)
    return []
  const byPath = new Map(changes.map(change => [change.path, change]))
  const candidates = new Set([
    ...rgFiles(oldName, { cwd, glob: '*.vue' }),
    ...rgFiles(hyphenateVueName(oldName), { cwd, glob: '*.vue' }),
  ])
  const out: FileChange[] = []
  for (const path of candidates) {
    const before = byPath.get(path)?.before ?? readFileSync(path, 'utf8')
    const baseAfter = byPath.get(path)?.after ?? before
    const after = rewriteTemplateReferences(baseAfter, oldName, newName)
    if (after === baseAfter)
      continue
    out.push({
      path,
      rel: relative(cwd, path),
      before,
      after,
    })
  }
  return out
}
