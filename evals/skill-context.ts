import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

interface Resource { path: string, bytes: Buffer, sha256: string }
export interface SkillContext {
  entryPath: string
  resources: Resource[]
  externalReferences: string[]
}
interface Failure { _tag: 'Err', reason: 'missing-resource' | 'invalid-link' | 'escapes-root' | 'symlink' | 'unsupported-resource', message: string }
type Result<T> = { _tag: 'Ok', value: T } | Failure
const failure = (reason: Failure['reason'], message: string): Failure => ({ _tag: 'Err', reason, message })
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** Parse local Markdown links without changing the instruction bytes. */
function links(source: string): Result<string[]> {
  const text = source.replace(/^ {0,3}(```|~~~)[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, '')
    .replace(/(`+)[^\n]*?\1/g, '')
  const targets: string[] = []
  for (const match of text.matchAll(/\]\(/g)) {
    let cursor = match.index + 2
    while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++
    let target = ''
    if (text[cursor] === '<') {
      const end = text.indexOf('>', cursor + 1)
      if (end < 0)
        return failure('invalid-link', 'A Skill link has no closing angle bracket.')
      target = text.slice(cursor + 1, end)
      cursor = end + 1
    }
    else {
      let depth = 0
      for (; cursor < text.length; cursor++) {
        const char = text[cursor]!
        if (char === '\\' && cursor + 1 < text.length) {
          target += text[++cursor]
        }
        else if (char === '(') {
          depth++
          target += char
        }
        else if (char === ')' && depth) {
          depth--
          target += char
        }
        else if (char === ')' || /\s/.test(char)) {
          break
        }
        else {
          target += char
        }
      }
      if (depth)
        return failure('invalid-link', 'A Skill link has unbalanced parentheses.')
    }
    while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++
    if (text[cursor] === '"' || text[cursor] === '\'') {
      const quote = text[cursor++]!
      while (cursor < text.length && text[cursor] !== quote) {
        if (text[cursor] === '\\')
          cursor++
        cursor++
      }
      cursor++
      while (/\s/.test(text[cursor] ?? '') && cursor < text.length) cursor++
    }
    if (text[cursor] !== ')')
      return failure('invalid-link', 'A Skill link has no closing parenthesis.')
    targets.push(target)
  }
  for (const match of text.matchAll(/^ {0,3}\[[^\]]+\]:\s*(?:<([^>]+)>|(\S+))/gm)) targets.push(match[1] ?? match[2]!)
  for (const match of text.matchAll(/<(?:a|img)\b[^>]+\b(?:href|src)\s*=\s*["']([^"']+)["'][^>]*>/gi)) targets.push(match[1]!)
  return { _tag: 'Ok', value: targets }
}

/** Capture the complete local reference closure before any model dispatch. */
export function loadSkillContext(entry: string): Result<SkillContext> {
  const entryFile = resolve(entry)
  const root = realpathSync(dirname(entryFile))
  const entryPath = relative(dirname(entryFile), entryFile)
  const resources = new Map<string, Resource>()
  const externalReferences = new Set<string>()
  const visit = (path: string): Result<true> => {
    const full = resolve(root, path)
    const local = relative(root, full)
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`))
      return failure('escapes-root', `A Skill resource leaves its base: ${path}`)
    for (const part of local.split(sep).map((_, index, parts) => join(root, ...parts.slice(0, index + 1)))) {
      const stat = lstatSync(part, { throwIfNoEntry: false })
      if (!stat)
        return failure('missing-resource', `A local Skill resource is missing: ${path}`)
      if (stat.isSymbolicLink())
        return failure('symlink', `A Skill resource must not use a symlink: ${path}`)
    }
    const stat = lstatSync(full)
    if (stat.isDirectory()) {
      if (local === entryPath)
        return failure('unsupported-resource', 'The Skill entry must be a regular file.')
      for (const child of readdirSync(full).sort()) {
        const result = visit(join(local, child))
        if (result._tag === 'Err')
          return result
      }
      return { _tag: 'Ok', value: true }
    }
    if (!stat.isFile())
      return failure('unsupported-resource', `A Skill resource must be a regular file: ${path}`)
    if (resources.has(local))
      return { _tag: 'Ok', value: true }
    const bytes = readFileSync(full)
    resources.set(local, { path: local, bytes, sha256: sha256(bytes) })
    if (local === entryPath || /\.(?:md|markdown)$/i.test(local)) {
      const parsed = links(bytes.toString('utf8'))
      if (parsed._tag === 'Err')
        return parsed
      for (const target of parsed.value) {
        if (!target || target.startsWith('#'))
          continue
        if (/^(?:https?:|mailto:|\/\/)/i.test(target)) {
          externalReferences.add(target)
          continue
        }
        if (/^[a-z][\w+.-]*:/i.test(target) || isAbsolute(target))
          return failure('escapes-root', `A local Skill link must stay inside its base: ${target}`)
        const encoded = target.split(/[?#]/, 1)[0]!
        if (/%(?![\da-f]{2})/i.test(encoded))
          return failure('invalid-link', `A Skill link has invalid path encoding: ${target}`)
        let decoded: string
        try {
          decoded = decodeURIComponent(encoded)
        }
        catch {
          return failure('invalid-link', `A Skill link has invalid path encoding: ${target}`)
        }
        if (decoded.includes('\0'))
          return failure('invalid-link', `A Skill link has invalid path encoding: ${target}`)
        if (isAbsolute(decoded))
          return failure('escapes-root', `A local Skill link must stay inside its base: ${target}`)
        const result = visit(join(dirname(local), decoded))
        if (result._tag === 'Err')
          return result
      }
    }
    return { _tag: 'Ok', value: true }
  }
  const loaded = visit(entryPath)
  return loaded._tag === 'Err' ? loaded : { _tag: 'Ok', value: { entryPath, resources: [...resources.values()].sort((a, b) => a.path.localeCompare(b.path)), externalReferences: [...externalReferences].sort() } }
}

export function skillResourceMetadata(skill: SkillContext) {
  return { entryPath: skill.entryPath, resources: skill.resources.map(resource => ({ path: resource.path, bytes: resource.bytes.length, sha256: resource.sha256 })), externalReferences: skill.externalReferences }
}

/** Copy resources inside the allowed project and render a single inline entry. */
export function prepareSkillContext(skill: SkillContext, project: string) {
  const base = join(resolve(project), '.ripide-eval-skill')
  if (existsSync(base))
    throw new Error('The supplied Skill directory already exists. Use a fresh project.')
  mkdirSync(base, { mode: 0o700 })
  for (const resource of skill.resources) {
    mkdirSync(dirname(join(base, resource.path)), { recursive: true, mode: 0o700 })
    writeFileSync(join(base, resource.path), resource.bytes, { flag: 'wx', mode: 0o400 })
  }
  const entry = skill.resources.find(resource => resource.path === skill.entryPath)!
  const prompt = `The Skill entry below is already loaded. Do not reopen its entry file.\nThe supplied Skill base is ${base}. You may read only its linked local resources when needed.\nResolve relative references against their containing resource. Keep the supplied Skill files unchanged.\nExternal documentation URLs are recorded but remain outside the allowed scope.\n<skill>\n${entry.bytes.toString('utf8')}\n</skill>`
  return { base, prompt, metadata: skillResourceMetadata(skill) }
}
