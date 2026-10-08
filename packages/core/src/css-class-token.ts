export type RenameMap = ReadonlyMap<string, string>

const CLASS_TOKEN_SEPARATOR_RE = /[\s'"`;{}]/
const NUMERIC_RE = /^[\d.-]+$/
const TOKEN_NAME_RE = /^[\w-]+/
const TOKEN_MODIFIER_RE = /^(?:\/[\w.-]+)?$/

export function visitClassTokens(input: string, visit: (bare: string) => void): void {
  visitTokenRanges(input, (start, end) => {
    const bare = bareToken(input.slice(start, end))
    if (bare)
      visit(bare)
  })
}

export function bareToken(token: string): string | null {
  const { tail } = splitVariantPrefix(token)
  const bare = tail.startsWith('!') ? tail.slice(1) : tail
  if (!bare || NUMERIC_RE.test(bare))
    return null
  if (!hasTokenShape(bare))
    return null
  return bare
}

function hasTokenShape(token: string): boolean {
  const name = TOKEN_NAME_RE.exec(token)
  if (!name)
    return false
  let end = name[0].length
  if (token[end] !== '[')
    return TOKEN_MODIFIER_RE.test(token.slice(end))
  let depth = 0
  let quote = ''
  for (; end < token.length; end++) {
    const char = token[end]
    if (char === '\\') {
      end++
      continue
    }
    if (quote) {
      if (char === quote)
        quote = ''
      continue
    }
    if (char === '\'' || char === '"') {
      quote = char
      continue
    }
    if (char === '[')
      depth++
    else if (char === ']' && --depth === 0)
      return TOKEN_MODIFIER_RE.test(token.slice(end + 1))
  }
  return false
}

export function rewriteClassString(input: string, map: RenameMap): string {
  let output = ''
  let cursor = 0
  visitTokenRanges(input, (start, end) => {
    const token = input.slice(start, end)
    const replacement = rewriteToken(token, map)
    if (replacement !== token) {
      output += input.slice(cursor, start) + replacement
      cursor = end
    }
  })
  return cursor ? output + input.slice(cursor) : input
}

function visitTokenRanges(input: string, visit: (start: number, end: number) => void): void {
  let start = 0
  let depth = 0
  let quote = ''
  for (let i = 0; i < input.length; i++) {
    const char = input[i]
    if (depth && char === '\\') {
      i++
      continue
    }
    if (quote) {
      if (char === quote)
        quote = ''
      continue
    }
    if (depth && (char === '\'' || char === '"')) {
      quote = char
      continue
    }
    if (char === '[') {
      depth++
    }
    else if (char === ']' && depth) {
      depth--
    }
    else if (!depth && CLASS_TOKEN_SEPARATOR_RE.test(char)) {
      if (start < i)
        visit(start, i)
      start = i + 1
    }
  }
  if (start < input.length)
    visit(start, input.length)
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
  let quote = ''
  let lastColon = -1
  for (let i = 0; i < token.length; i++) {
    const c = token[i]
    if (depth && c === '\\') {
      i++
      continue
    }
    if (quote) {
      if (c === quote)
        quote = ''
      continue
    }
    if (depth && (c === '\'' || c === '"')) {
      quote = c
      continue
    }
    if (c === '[')
      depth++
    else if (c === ']' && depth)
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
