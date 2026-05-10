import type { Project } from 'ts-morph'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export type VerifyMode = 'none' | 'touched' | 'project'

export function resolveVerifyMode(verify: boolean | VerifyMode | undefined): VerifyMode {
  if (verify === false || verify === 'none')
    return 'none'
  if (verify === 'project')
    return 'project'
  return 'touched'
}

export function projectSourceFiles(project: Project, candidates: string[], mode: 'lazy' | 'full') {
  if (mode === 'full')
    return project.getSourceFiles()

  const out = []
  const seen = new Set<string>()
  for (const path of candidates) {
    const sf = project.getSourceFile(path) ?? project.addSourceFileAtPathIfExists(path)
    if (!sf || seen.has(sf.getFilePath()))
      continue
    seen.add(sf.getFilePath())
    out.push(sf)
  }
  return out
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
