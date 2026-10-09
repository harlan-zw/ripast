import type { FrameworkAdapter, OperationName } from './adapter.ts'
import { extname } from 'node:path'
import { rgFiles } from './util.ts'

const sourceSuffixes = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'])
const assets = new Set(['.json', '.jsonc', '.md', '.txt', '.css', '.scss', '.sass', '.less', '.html', '.svg', '.yaml', '.yml', '.lock', '.toml', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.wasm', '.mp4', '.pdf', '.map'])
export function assertOperationSupport(operation: OperationName, cwd: string, extensions: readonly FrameworkAdapter[] = []) {
  for (const path of rgFiles('', { cwd, glob: '*', listAll: true })) {
    const suffix = extname(path)
    if (!suffix || sourceSuffixes.has(suffix) || assets.has(suffix))
      continue
    const owner = extensions.find(extension => extension.suffixes.some(suffix => path.endsWith(suffix)))
    if (owner) {
      if (!owner.operations?.includes(operation))
        throw new Error(`Extension does not support ${operation}: ${owner.name}`)
      continue
    }
    throw new Error(`Required extension is missing for authored source: ${path}`)
  }
}
