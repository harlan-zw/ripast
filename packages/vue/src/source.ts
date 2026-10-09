import type { SourceRegion } from 'ripide-api'
import { parse } from '@vue/compiler-sfc'

import { rgFiles as coreFiles } from 'ripide-api/adapter'

export function parseAuthoredSource({ path, source }: { path: string, source: string }): SourceRegion {
  const { descriptor, errors } = parse(source, { filename: path })
  if (errors.length)
    throw new Error(`Cannot inspect Vue source in ${path}: ${errors.map(String).join('; ')}`)
  const blocks = [descriptor.script, descriptor.scriptSetup].filter(block => block !== null).filter(block => !block.src)
  const block = blocks.reduce<(typeof blocks)[number] | undefined>((best, candidate) => !best || candidate.content.length > best.content.length ? candidate : best, undefined)
  return { _tag: 'Script', source: block?.content ?? '', start: block?.loc.start.offset ?? 0, filename: `${path}.${block?.lang === 'tsx' || block?.lang === 'jsx' ? 'tsx' : 'ts'}` }
}

export function inspectAuthoredSource({ path, source }: { path: string, source: string }): { source: string, filename: string } {
  const { descriptor, errors } = parse(source, { filename: path })
  if (errors.length)
    throw new Error(`ripide delete: cannot inspect ${path.split(/[\\/]/).at(-1)}:1:1 because its Vue source has parse errors.`)
  const blocks = [descriptor.script, descriptor.scriptSetup].filter(block => block !== null)
  const text = source.replace(/[^\r\n]/g, ' ').split('')
  for (const block of blocks) {
    if (block.src)
      throw new Error(`Cannot inspect an external script in ${path}. Use an inline script first.`)
    if (block.lang && !['ts', 'tsx', 'js', 'jsx'].includes(block.lang))
      throw new Error(`Cannot inspect the script language in ${path}. Use JavaScript or TypeScript first.`)
    for (let i = 0; i < block.content.length; i++) text[block.loc.start.offset + i] = block.content[i]!
  }
  return { source: text.join(''), filename: `${path}.ripide-inspect.${blocks.some(block => block.lang === 'tsx' || block.lang === 'jsx') ? 'tsx' : 'ts'}` }
}

export { rgFiles as rgCoreFiles } from 'ripide-api/adapter'
export function rgVueFiles(pattern: string, opts: Parameters<typeof coreFiles>[1] = {}) {
  return coreFiles(pattern, { ...opts, glob: opts.glob ?? ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs', '*.vue'] })
}
