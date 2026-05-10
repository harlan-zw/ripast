import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

export function hasVueFilesContaining(cwd: string, pattern: string): boolean {
  return listVueFilesContaining(cwd, pattern).length > 0
}

export function listVueFiles(cwd: string): string[] {
  return rgVueFiles(cwd, ['--files'])
}

export function listVueFilesContaining(cwd: string, pattern: string): string[] {
  return rgVueFiles(cwd, ['--files-with-matches', '--fixed-strings', pattern])
}

function rgVueFiles(cwd: string, args: string[]): string[] {
  const result = spawnSync('rg', [...args, '--hidden', '--no-messages', '-g', '*.vue', '.'], { cwd, encoding: 'utf8' })
  return result.stdout.split('\n').filter(Boolean).map((path: string) => resolve(cwd, path))
}
