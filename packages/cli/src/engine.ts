import type { Extension } from 'ripide-api'
import type * as VueOperations from 'ripide-vue'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { createEngine } from 'ripide-api'
import { rgFiles } from 'ripide-api/adapter'

export function discoverCliAdapters(cwd = process.cwd(), enabled = true): { authoredVue: boolean, adapters: readonly string[] } {
  const authored = rgFiles('', { cwd, glob: '*.vue', listAll: true }).length > 0
  return { authoredVue: authored, adapters: enabled && (authored || hasVueDependency(cwd)) ? ['vue'] : [] }
}

export async function createCliEngine(cwd = process.cwd(), enabled = true, imports?: { importModule: (specifier: string) => Promise<Pick<typeof VueOperations, 'createVueExtension'>> }) {
  const { authoredVue, adapters } = discoverCliAdapters(cwd, enabled)
  const extensions: Extension[] = []
  if (adapters.includes('vue')) {
    const { createVueExtension } = await (imports?.importModule('ripide-vue') ?? import('ripide-vue'))
    extensions.push(createVueExtension())
  }
  return createEngine({ extensions, requiredSuffixes: authoredVue ? ['.vue'] : [] })
}
function hasVueDependency(cwd: string): boolean {
  let path = cwd
  for (let depth = 0; depth < 6; depth++) {
    const manifest = join(path, 'package.json')
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      const dependencies = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
      if (dependencies.vue || dependencies.nuxt || dependencies['@nuxt/kit'])
        return true
    }
    const parent = dirname(path)
    if (parent === path)
      break
    path = parent
  }
  return false
}

export async function loadVueOperations() {
  return import('ripide-vue')
}
