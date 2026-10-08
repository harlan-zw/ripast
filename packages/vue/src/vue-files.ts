import { findFiles } from '@ripast/core/adapter'

export function hasVueFilesContaining(cwd: string, pattern: string): boolean {
  return listVueFilesContaining(cwd, pattern).length > 0
}

export function listVueFiles(cwd: string): string[] {
  return findFiles('', { cwd, glob: '*.vue', listAll: true })
}

export function listVueFilesContaining(cwd: string, pattern: string): string[] {
  return findFiles(pattern, { cwd, glob: '*.vue' })
}
