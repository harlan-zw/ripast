import type { FrameworkAdapter } from './adapter.ts'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { rgFiles } from './util.ts'

export type VerifyMode = 'none' | 'touched' | 'project'

export function resolveVerifyMode(verify: boolean | VerifyMode | undefined): VerifyMode {
  if (verify === false || verify === 'none')
    return 'none'
  if (verify === 'project')
    return 'project'
  return 'touched'
}

export function findTsconfig(cwd: string): string | null {
  const tries = ['tsconfig.json', 'tsconfig.build.json']
  for (const file of tries) {
    const path = resolve(cwd, file)
    if (existsSync(path))
      return path
  }
  return null
}

export function isExtensionPath(path: string, extensions: readonly FrameworkAdapter[] = []): boolean {
  return extensions.some(extension => extension.suffixes.some(suffix => path.endsWith(suffix)))
}

/** Every script file under `cwd` (respecting ignores), for project-wide verification. */
export function projectScriptFiles(cwd: string, glob?: string | string[], extensions: readonly FrameworkAdapter[] = []): string[] {
  return rgFiles('', { cwd, glob, listAll: true, extensions }).filter(path => !isExtensionPath(path, extensions))
}

/** Files to verify for a change set: the candidates plus every changed script file. */
export function verifyScope(mode: VerifyMode, cwd: string, candidates: string[], changedPaths: string[], extensions: readonly FrameworkAdapter[] = []): string[] {
  if (mode === 'none')
    return []
  if (mode === 'project')
    return projectScriptFiles(cwd, undefined, extensions)
  return [...new Set([...candidates, ...changedPaths])].filter(path => !isExtensionPath(path, extensions))
}
