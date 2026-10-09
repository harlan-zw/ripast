import type { FrameworkAdapter } from '@ripast/core'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { createEngine } from '@ripast/core'
import { rgFiles } from '@ripast/core/adapter'

export async function projectEngine(cwd: string = process.cwd(), enabled = true) {
  const extensions: FrameworkAdapter[] = []
  if (enabled && (rgFiles('', { cwd, glob: '*.vue', listAll: true }).length || ['.nuxt', 'nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.mts'].some(path => existsSync(join(cwd, path))))) {
    // Resolution failures and initialization failures propagate before planning or writes.
    const module = await import('@ripast/vue')
    extensions.push(module.default)
  }
  return createEngine({ extensions })
}
