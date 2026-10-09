import type { EngineServices } from './engine.ts'
import { existsSync, readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
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

export function isExtensionPath(path: string, engine?: EngineServices): boolean {
  return engine?.owns(path) ?? false
}

/** Every script file under `cwd` (respecting ignores), for project-wide verification. */
export function projectScriptFiles(cwd: string, glob?: string | string[], engine?: EngineServices): string[] {
  return rgFiles('', { cwd, glob, engine, listAll: true }).filter(path => !isExtensionPath(path, engine))
}

/** Files to verify for a change set: the candidates plus every changed script file. */
export function verifyScope(mode: VerifyMode, cwd: string, candidates: string[], changedPaths: string[], engine?: EngineServices): string[] {
  if (mode === 'none')
    return []
  if (mode === 'project')
    return projectScriptFiles(cwd, undefined, engine)
  return [...new Set([...candidates, ...changedPaths])].filter(path => !isExtensionPath(path, engine))
}

export function isInsideAutoImportScope(path: string, scopes: Set<string>): boolean {
  return [...scopes].some(scope => path === scope || path.startsWith(`${scope}/`))
}

/** Refuse unregistered authored code discovered outside the native source suffixes. */
export function assertSourceSupport(cwd: string, engine?: EngineServices): void {
  const nonCode = new Set(['.json', '.md', '.yaml', '.yml', '.txt', '.css', '.scss', '.sass', '.less', '.html', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.woff', '.woff2', '.lock', '.map'])
  for (const path of rgFiles('', { cwd, glob: '*', listAll: true })) {
    const suffix = extname(path)
    if (nonCode.has(suffix) || /^(?:\.ts|\.tsx|\.js|\.jsx|\.mts|\.cts|\.mjs|\.cjs)$/.test(suffix) || engine?.owns(path))
      continue
    const source = readFileSync(path, 'utf8')
    if (/^\s*(?:import\s+|export\s+(?:default\b|(?:declare\s+)?(?:const|let|var|function|class|interface|type|enum|namespace|async)\b|\{|\*)|<script(?:\s|>)|<template(?:\s|>))/m.test(source))
      throw new Error(`Required extension missing for authored source ${path}`)
  }
}
