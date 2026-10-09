import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import process from 'node:process'
import { parse as parseSfc } from '@vue/compiler-sfc'
import { parseSourceFile as parseScriptSource } from 'ripide-api/adapter'

export function parseSourceFile(path: string, source: string, cwd = process.cwd()) {
  if (!path.endsWith('.vue'))
    return parseScriptSource(path, source, cwd)
  const { descriptor } = parseSfc(source, { filename: path })
  const blocks = [descriptor.script, descriptor.scriptSetup].filter(block => block !== null).filter(block => !block.src)
  const block = blocks.sort((a, b) => b.content.length - a.content.length)[0]
  if (!block)
    return { path, rel: relative(cwd, path), fullSource: source, scriptSource: '', scriptStart: 0, scriptEnd: 0, program: null, isSfc: true }
  const parsed = parseScriptSource(path + (block.lang === 'tsx' || block.lang === 'jsx' ? '.tsx' : '.ts'), block.content, cwd)
  return { ...parsed, path, rel: relative(cwd, path), fullSource: source, scriptStart: block.loc.start.offset, scriptEnd: block.loc.end.offset, isSfc: true }
}
export function parseFile(path: string, cwd = process.cwd()) {
  return parseSourceFile(path, readFileSync(path, 'utf8'), cwd)
}
export function inspectionSource(path: string, source: string): {
  source: string
  extension: 'ts' | 'tsx'
} {
  const { descriptor, errors } = parseSfc(source, { filename: path })
  if (errors.length)
    throw new Error(`ripide delete: cannot inspect ${path.split('/').at(-1)}:1:1 because its Vue source has parse errors.`)
  const blocks = [descriptor.script, descriptor.scriptSetup].filter(block => block !== null)
  const text = source.replace(/[^\r\n]/g, ' ').split('')
  for (const block of blocks) {
    if (block.src)
      throw new Error(`Cannot inspect an external script at ${path}`)
    if (block.lang && !['ts', 'tsx', 'js', 'jsx'].includes(block.lang))
      throw new Error(`Cannot inspect the script language at ${path}`)
    for (let i = 0; i < block.content.length; i++)
      text[block.loc.start.offset + i] = block.content[i]!
  }
  return { source: text.join(''), extension: blocks.some(block => block.lang === 'tsx' || block.lang === 'jsx') ? 'tsx' : 'ts' }
}
