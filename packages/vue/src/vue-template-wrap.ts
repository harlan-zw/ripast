import type { FileChange } from '@ripast/core/adapter'

import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import process from 'node:process'
import { rgFiles } from './discovery.ts'

import { hyphenateVueName, parseTemplateSelector, parseTemplateWrapper, unwrapTemplateElements, wrapTemplateElements } from './vue-template.ts'

export interface VueTemplateWrapOptions {
  cwd?: string
  glob?: string | string[]
  scope?: string
  rootOnly?: boolean
}

export interface VueTemplateWrapResult {
  changes: FileChange[]
  scanned: number
  regressions: never[]
}

function resolveScope(scope: string, cwd: string): string {
  const abs = resolve(cwd, scope)
  if (!existsSync(abs))
    throw new Error(`ripast: --scope file "${scope}" does not exist`)
  if (!abs.endsWith('.vue'))
    throw new Error(`ripast: --scope must point at a .vue file (got "${scope}")`)
  return abs
}

function candidateFiles(tag: string, opts: VueTemplateWrapOptions): string[] {
  const cwd = opts.cwd ?? process.cwd()
  if (opts.scope)
    return [resolveScope(opts.scope, cwd)]
  const glob = opts.glob ?? '*.vue'
  const seen = new Set<string>()
  for (const path of rgFiles(tag, { cwd, glob })) {
    if (path.endsWith('.vue'))
      seen.add(path)
  }
  const kebab = hyphenateVueName(tag)
  if (kebab !== tag) {
    for (const path of rgFiles(kebab, { cwd, glob })) {
      if (path.endsWith('.vue'))
        seen.add(path)
    }
  }
  return [...seen]
}

export async function runVueTemplateWrap(selector: string, wrapper: string, opts: VueTemplateWrapOptions = {}): Promise<VueTemplateWrapResult> {
  const cwd = opts.cwd ?? process.cwd()
  const sel = parseTemplateSelector(selector)
  const parent = parseTemplateWrapper(wrapper)
  const files = candidateFiles(sel.tag, opts)
  const matchOpts = { rootOnly: opts.rootOnly }
  const changes: FileChange[] = []
  for (const path of files) {
    const before = readFileSync(path, 'utf8')
    const after = wrapTemplateElements(before, sel, parent.inner, matchOpts)
    if (after !== before)
      changes.push({ path, rel: relative(cwd, path), before, after })
  }
  return { changes, scanned: files.length, regressions: [] }
}

export async function runVueTemplateUnwrap(selector: string, opts: VueTemplateWrapOptions = {}): Promise<VueTemplateWrapResult> {
  const cwd = opts.cwd ?? process.cwd()
  const sel = parseTemplateSelector(selector)
  const files = candidateFiles(sel.tag, opts)
  const matchOpts = { rootOnly: opts.rootOnly }
  const changes: FileChange[] = []
  for (const path of files) {
    const before = readFileSync(path, 'utf8')
    const after = unwrapTemplateElements(before, sel, matchOpts)
    if (after !== before)
      changes.push({ path, rel: relative(cwd, path), before, after })
  }
  return { changes, scanned: files.length, regressions: [] }
}
