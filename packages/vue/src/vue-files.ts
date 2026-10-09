import { rgVueFiles } from './source.ts'

export function hasVueFilesContaining(cwd: string, pattern: string): boolean {
  return listVueFilesContaining(cwd, pattern).length > 0
}

export function listVueFiles(cwd: string): string[] {
  return rgVueFiles('', { cwd, glob: '*.vue', listAll: true })
}

export function listVueFilesContaining(cwd: string, pattern: string): string[] {
  return rgVueFiles(pattern, { cwd, glob: '*.vue' })
}
