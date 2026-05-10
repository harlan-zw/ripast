import type { FileChange } from './util.ts'
import { relative } from 'node:path'

export function isGeneratedNuxtPath(cwd: string, filePath: string): boolean {
  const rel = relative(cwd, filePath).replace(/\\/g, '/')
  return rel === '.nuxt' || rel.startsWith('.nuxt/')
}

export function removeGeneratedNuxtChanges(cwd: string, changes: FileChange[]): void {
  for (let i = changes.length - 1; i >= 0; i--) {
    if (isGeneratedNuxtPath(cwd, changes[i].path))
      changes.splice(i, 1)
  }
}

export function isInsideNuxtAutoImportScope(filePath: string, scopes: Set<string>): boolean {
  const normalizedFile = normalizePath(filePath)
  for (const scope of scopes) {
    const normalizedScope = normalizePath(scope)
    if (normalizedFile === normalizedScope || normalizedFile.startsWith(`${normalizedScope}/`))
      return true
  }
  return false
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/')
}
