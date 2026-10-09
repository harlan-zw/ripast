import type { FrameworkAdapter } from 'ripide-api/adapter'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { isInsideAutoImportScope } from 'ripide-api/adapter'
import { rgFiles } from './discovery.ts'
import { loadNuxtBindingNames, nuxtConsumerContext, nuxtImportMetadataPaths } from './nuxt-bindings.ts'
import { unboundNuxtSymbols } from './nuxt-consumers.ts'
import { isGeneratedNuxtPath } from './nuxt-paths.ts'

export const inspectNuxtAutoImportConsumers: NonNullable<FrameworkAdapter['inspectAutoImportConsumers']> = ctx => inspectConsumers(ctx, new Map(), 'Delete')
export const validateNuxtAutoImportRename: NonNullable<FrameworkAdapter['validateAutoImportRename']> = (ctx) => {
  const consumers = inspectConsumers({ ...ctx, files: rgFiles('', { cwd: ctx.cwd, listAll: true }) }, new Map(ctx.changes.map(change => [change.path, change.after])), 'Rename')
  if (consumers.length)
    throw new Error(`ripide rename: unresolved Nuxt auto-import uses remain in ${consumers.join(', ')}. Use explicit imports first.`)
}
function inspectConsumers(ctx: Parameters<NonNullable<FrameworkAdapter['inspectAutoImportConsumers']>>[0], planned: Map<string, string>, purpose: 'Delete' | 'Rename'): string[] {
  const { cwd, symbol, fromAbs, files, scopes } = ctx
  const binding = loadNuxtBindingNames(cwd, symbol, fromAbs)
  if (binding._tag === 'Unknown') {
    const context = isInsideAutoImportScope(fromAbs, scopes) ? 'auto-import scope' : 'Nuxt context'
    throw new Error(`ripide ${purpose.toLowerCase()}: cannot resolve auto-import metadata for "${symbol}" in ${context}. Run Nuxt prepare first.`)
  }
  const byContext = new Map([[nuxtImportMetadataPaths(cwd, fromAbs).join('|'), binding]])
  const consumers: string[] = []
  for (const path of files) {
    if (path === fromAbs || isGeneratedNuxtPath(cwd, path))
      continue
    const context = nuxtConsumerContext(path, cwd)
    const key = nuxtImportMetadataPaths(context, path).join('|')
    let local = byContext.get(key)
    if (!local) {
      const resolved = loadNuxtBindingNames(context, symbol, fromAbs, path)
      if (resolved._tag === 'Unknown') {
        if (!unboundNuxtSymbols(path, planned.get(path) ?? readFileSync(path, 'utf8'), new Set([symbol, ...binding.names]), purpose).size)
          continue
        throw new Error(`ripide ${purpose.toLowerCase()}: cannot resolve auto-import metadata for "${symbol}" in ${context}. Run Nuxt prepare first.`)
      }
      local = resolved
      byContext.set(key, local)
    }
    if (purpose === 'Rename' && planned.has(path) && !local.names.includes(symbol)
      && unboundNuxtSymbols(path, readFileSync(path, 'utf8'), new Set([symbol]), purpose).size) {
      throw new Error(`ripide rename: edits may change another Nuxt auto-import provider in ${relative(cwd, path)}. Use explicit imports first.`)
    }
    if (local.names.length && unboundNuxtSymbols(path, planned.get(path) ?? readFileSync(path, 'utf8'), new Set(local.names), purpose).size)
      consumers.push(relative(cwd, path))
  }
  return consumers
}
