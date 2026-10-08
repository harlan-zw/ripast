import ts from 'typescript'

export type ProjectCase = {
  name: string
  source: string
  prefix: string
  from: string
  to: string
} & ({ _tag: 'Symbol', declaration: string } | { _tag: 'Class' })

export const projectCases: ProjectCase[] = [
  { _tag: 'Symbol', name: 'unimport', source: 'pkg/unimport', prefix: 'src/', declaration: 'src/utils.ts', from: 'normalizeImports', to: 'normalizeProjectImports' },
  { _tag: 'Symbol', name: 'unhead', source: 'pkg/unhead', prefix: 'packages/unhead/src/', declaration: 'packages/unhead/src/utils/unsafeKey.ts', from: 'isUnsafeKey', to: 'isUnsafeHeadKey' },
  { _tag: 'Symbol', name: 'mdream', source: 'pkg/mdream', prefix: 'packages/js/src/', declaration: 'packages/js/src/markdown-processor.ts', from: 'isAsciiWhitespace', to: 'isAsciiSpaceCharacter' },
  { _tag: 'Symbol', name: 'skilld', source: 'pkg/skilld', prefix: 'packages/sdk/src/', declaration: 'packages/sdk/src/client.ts', from: 'createProtocolClient', to: 'createTypedProtocolClient' },
  { _tag: 'Class', name: 'request-indexing', source: 'sites/request-indexing', prefix: 'apps/', from: 'font-semibold', to: 'font-medium' },
  { _tag: 'Class', name: 'forgd', source: 'sites/forgd', prefix: 'apps/', from: 'text-brand-900', to: 'text-brand-800' },
]

/** New repositories for the second batch. The first five use Codex in split mode. */
export const projectCasesBatchTwo: ProjectCase[] = [
  { _tag: 'Symbol', name: 'c12', source: 'pkg/c12', prefix: 'src/', declaration: 'src/dotenv.ts', from: 'loadDotenv', to: 'loadProjectDotenv' },
  { _tag: 'Class', name: 'harlanzw.com', source: 'sites/harlanzw.com', prefix: 'app/', from: 'font-semibold', to: 'font-medium' },
  { _tag: 'Symbol', name: 'unrouting', source: 'pkg/unrouting', prefix: 'src/', declaration: 'src/parse.ts', from: 'parseSegment', to: 'parseRouteSegment' },
  { _tag: 'Class', name: 'mdream.dev', source: 'sites/mdream.dev', prefix: 'app/', from: 'font-semibold', to: 'font-medium' },
  { _tag: 'Symbol', name: 'nuxt-link-checker', source: 'pkg/nuxt-link-checker', prefix: 'src/', declaration: 'src/build/util.ts', from: 'truncateString', to: 'truncateReportString' },
  { _tag: 'Class', name: 'massivemonster.co', source: 'sites/massivemonster.co', prefix: 'app/', from: 'font-semibold', to: 'font-medium' },
  { _tag: 'Symbol', name: 'nuxt-seo-utils', source: 'pkg/nuxt-seo-utils', prefix: 'src/', declaration: 'src/build-time/iconAssets.ts', from: 'classifyIconFilename', to: 'classifyProjectIconFilename' },
  { _tag: 'Class', name: 'nuxtseo.com', source: 'sites/nuxtseo.com', prefix: 'apps/', from: 'rounded-lg', to: 'rounded-xl' },
  { _tag: 'Symbol', name: 'nuxt-site-config', source: 'pkg/nuxt-site-config', prefix: 'packages/kit/src/', declaration: 'packages/kit/src/util.ts', from: 'getNitroOrigin', to: 'getSiteNitroOrigin' },
  { _tag: 'Class', name: 'unlighthouse.dev', source: 'sites/unlighthouse.dev', prefix: 'app/', from: 'font-semibold', to: 'font-medium' },
]

/** Only identifier nodes change. Comments and literal values remain exact. */
export function renameIdentifiers(source: string, from: string, to: string): string {
  const file = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true)
  const positions: { start: number, end: number }[] = []
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node.text === from)
      positions.push({ start: node.getStart(file), end: node.end })
    ts.forEachChild(node, visit)
  }
  visit(file)
  return positions.sort((a, b) => b.start - a.start).reduce((text, position) => text.slice(0, position.start) + to + text.slice(position.end), source)
}

/** Independent oracle for selected files whose target occurs only in static class attributes. */
export function renameStaticClasses(source: string, from: string, to: string): string {
  return source.replace(/(?<![:\w-])class\s*=\s*(["'])(.*?)\1/gs, (attribute, quote: string, value: string) => {
    const next = value.replace(/\S+/g, (token) => {
      const parts = token.split(':')
      const tail = parts.pop()!
      return [...parts, tail === from ? to : tail].join(':')
    })
    return attribute.replace(`${quote}${value}${quote}`, `${quote}${next}${quote}`)
  })
}
