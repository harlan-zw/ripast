import type { compile_to_volar_mappings } from 'ripide-tsrx/compiler'
import { createRequire } from 'node:module'

export function resolveTsrxModule(from: string, entry: 'compiler' | 'package.json'): string {
  const specifier = `ripide-tsrx/${entry}`
  try {
    return createRequire(from).resolve(specifier)
  }
  catch {
    return createRequire(import.meta.url).resolve(specifier)
  }
}

/** Parse authored positions, never the generated TSX that refactors would corrupt. */
export function parseTsrxSource(path: string, source: string) {
  if (process.env.RIPIDE_RUN_EXTERNAL_CODE !== '1')
    throw new Error('ripide: TSRX parsing requires RIPIDE_RUN_EXTERNAL_CODE=1 and a project-local Octane compiler')
  const require = createRequire(path)
  let compiler: { compile_to_volar_mappings: typeof compile_to_volar_mappings }
  try {
    compiler = require(resolveTsrxModule(path, 'compiler'))
  }
  catch (cause) {
    throw new Error(`ripide: ${path} requires ripide-tsrx and a project-local Octane compiler for TSRX support`, { cause })
  }
  const result = compiler.compile_to_volar_mappings(source, path, { loose: true })
  if (result.errors.length) {
    throw new Error(`ripide: cannot parse ${path}: ${result.errors.map(error => error.message).join('; ')}`)
  }
  return { program: result.sourceAst, comments: [] }
}
