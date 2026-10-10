import { findVueFiles } from './source.ts'

export function hasVueFilesContaining(cwd: string, pattern: string): boolean {
  return listVueFilesContaining(cwd, pattern).length > 0
}

export function listVueFiles(cwd: string): string[] {
  return findVueFiles('', { cwd, glob: '*.vue', listAll: true })
}

export function listVueFilesContaining(cwd: string, pattern: string): string[] {
  return findVueFiles(pattern, { cwd, glob: '*.vue' })
}
