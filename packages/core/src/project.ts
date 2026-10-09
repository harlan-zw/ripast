import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { rgFiles } from './util.ts'

export type VerifyMode = 'none' | 'touched' | 'project'

export function resolveVerifyMode(value: unknown, defaultMode: VerifyMode = 'touched'): VerifyMode {
  const mode = value === undefined ? defaultMode : value
  if (mode === 'none' || mode === 'touched' || mode === 'project')
    return mode
  throw new Error('ripide: verifyMode must be none, touched, or project.')
}

export function resolveVerificationOptions(opts: { verifyMode?: VerifyMode }, defaultMode: VerifyMode = 'touched'): VerifyMode {
  if (Object.hasOwn(opts, 'verify'))
    throw new Error('ripide: verify was removed. Use verifyMode: none, touched, or project.')
  return resolveVerifyMode(opts.verifyMode, defaultMode)
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

export function isVuePath(path: string): boolean {
  return path.endsWith('.vue')
}

/** Every script file under `cwd` (respecting ignores), for project-wide verification. */
export function projectScriptFiles(cwd: string, glob?: string | string[]): string[] {
  return rgFiles('', { cwd, glob, listAll: true }).filter(path => !isVuePath(path))
}

/** Files to verify for a change set: the candidates plus every changed script file. */
export function verifyScope(mode: VerifyMode, cwd: string, candidates: string[], changedPaths: string[]): string[] {
  if (mode === 'none')
    return []
  if (mode === 'project')
    return projectScriptFiles(cwd)
  return [...new Set([...candidates, ...changedPaths])].filter(path => !isVuePath(path))
}
