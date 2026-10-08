import type { FrameworkAdapter } from '@ripast/core/adapter'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { isInsideAutoImportScope } from '@ripast/core/adapter'
import { loadNuxtBindingNames } from './nuxt-bindings.ts'
import { unboundNuxtSymbols } from './nuxt-consumers.ts'
import { isGeneratedNuxtPath } from './nuxt-paths.ts'

export const inspectNuxtAutoImportConsumers: NonNullable<FrameworkAdapter['inspectAutoImportConsumers']> = (ctx) => {
  const { cwd, symbol, fromAbs, files, scopes } = ctx
  const binding = loadNuxtBindingNames(cwd, symbol, fromAbs)
  if (binding._tag === 'Unknown') {
    const context = isInsideAutoImportScope(fromAbs, scopes) ? 'auto-import scope' : 'Nuxt context'
    throw new Error(`ripast delete: cannot resolve auto-import metadata for "${symbol}" in ${context}. Run Nuxt prepare first.`)
  }
  const byContext = new Map([[cwd, binding]])
  const consumers: string[] = []
  for (const path of files) {
    if (path === fromAbs || isGeneratedNuxtPath(cwd, path))
      continue
    const context = nearestNuxtContext(path, cwd)
    let local = byContext.get(context)
    if (!local) {
      const resolved = loadNuxtBindingNames(context, symbol, fromAbs)
      if (resolved._tag === 'Unknown')
        throw new Error(`ripast delete: cannot resolve auto-import metadata for "${symbol}" in ${context}. Run Nuxt prepare first.`)
      local = resolved
      byContext.set(context, local)
    }
    if (local.names.length && unboundNuxtSymbols(path, readFileSync(path, 'utf8'), new Set(local.names), 'Delete').size)
      consumers.push(relative(cwd, path))
  }
  return consumers
}

function nearestNuxtContext(path: string, cwd: string): string {
  let current = dirname(path)
  while (current !== cwd) {
    if (existsSync(join(current, '.nuxt')) || ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mts', 'nuxt.config.mjs'].some(name => existsSync(join(current, name))))
      return current
    const parent = dirname(current)
    if (parent === current)
      return cwd
    current = parent
  }
  return cwd
}
