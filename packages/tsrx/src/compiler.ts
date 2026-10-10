import type { compileToVolarMappings } from 'octane/compiler/volar'
import { createRequire } from 'node:module'

/** Adapt Octane's export name to the official TypeScript content-mapper protocol. */
export function compile_to_volar_mappings(source: string, path: string, options?: Parameters<typeof compileToVolarMappings>[2]) {
  const require = createRequire(path)
  let compiler: { compileToVolarMappings: typeof compileToVolarMappings }
  try {
    compiler = require('octane/compiler/volar')
  }
  catch (cause) {
    throw new Error(`ripide: ${path} requires ripide-tsrx and a project-local Octane compiler for TSRX support`, { cause })
  }
  try {
    return compiler.compileToVolarMappings(source, path, { ...options, loose: true })
  }
  catch (cause) {
    throw new Error(`ripide: cannot parse ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}
