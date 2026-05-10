export type RenameMap = ReadonlyMap<string, string>

const CLASS_TOKEN_SPLIT_RE = /([\\:]?[\s'"`;{}]+)/g
const NUMERIC_RE = /^[\d.-]+$/
const TOKEN_SHAPE_RE = /^[\w-]+(?:\[[^\]]*\])?(?:\/[\w.-]+)?$/

export function visitClassTokens(input: string, visit: (bare: string) => void): void {
  const parts = input.split(CLASS_TOKEN_SPLIT_RE)
  for (let i = 0; i < parts.length; i += 2) {
    const tok = parts[i]
    if (!tok)
      continue
    const bare = bareToken(tok)
    if (bare)
      visit(bare)
  }
}

export function bareToken(token: string): string | null {
  const { tail } = splitVariantPrefix(token)
  const bare = tail.startsWith('!') ? tail.slice(1) : tail
  if (!bare || NUMERIC_RE.test(bare))
    return null
  if (!TOKEN_SHAPE_RE.test(bare))
    return null
  return bare
}

export function rewriteClassString(input: string, map: RenameMap): string {
  const parts = input.split(CLASS_TOKEN_SPLIT_RE)
  let changed = false
  for (let i = 0; i < parts.length; i++) {
    const tok = parts[i]
    if (!tok)
      continue
    const next = rewriteToken(tok, map)
    if (next !== tok) {
      parts[i] = next
      changed = true
    }
  }
  return changed ? parts.join('') : input
}

export function rewriteToken(token: string, map: RenameMap): string {
  const { prefix, tail } = splitVariantPrefix(token)
  const bang = tail.startsWith('!') ? '!' : ''
  const bare = bang ? tail.slice(1) : tail
  const replacement = map.get(bare)
  if (replacement === undefined)
    return token
  return prefix + bang + replacement
}

function splitVariantPrefix(token: string): { prefix: string, tail: string } {
  let depth = 0
  let lastColon = -1
  for (let i = 0; i < token.length; i++) {
    const c = token[i]
    if (c === '[')
      depth++
    else if (c === ']')
      depth--
    else if (c === ':' && depth === 0)
      lastColon = i
  }
  if (lastColon === -1)
    return { prefix: '', tail: token }
  return {
    prefix: token.slice(0, lastColon + 1),
    tail: token.slice(lastColon + 1),
  }
}
