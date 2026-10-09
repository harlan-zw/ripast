import type { DoctorAdapter, DoctorContext, DoctorFinding } from 'ripide-api/adapter'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { hyphenateVueName, parseVueTemplateAst, posToLineCol, rgFiles } from 'ripide-api/adapter'
import { listComponents } from './components.ts'

const NUXT_ENTRY_PATTERNS = [
  'nuxt.config.ts',
  'nuxt.config.js',
  'nuxt.config.mjs',
  'nuxt.config.mts',
  'app.vue',
  'error.vue',
  'app.config.ts',
  'vitest.config.ts',
  'vitest.config.mts',
]

const NUXT_ENTRY_DIRS = [
  'pages',
  'layouts',
  'middleware',
  'plugins',
  'server',
  'modules',
  'app/middleware',
  'app/plugins',
  'app/pages',
  'app/layouts',
]

const NUXT_AUTOIMPORT_DIRS = [
  'components',
  'composables',
  'utils',
  'shared',
  'server/utils',
  'server/middleware',
  'server/api',
  'server/routes',
  'server/plugins',
  'app/components',
  'app/composables',
  'app/utils',
]

const ENTRY_EXTS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.vue']

function isNuxtProject(cwd: string): boolean {
  for (const p of NUXT_ENTRY_PATTERNS) {
    if (p.startsWith('nuxt.config') && existsSync(join(cwd, p)))
      return true
  }
  if (existsSync(join(cwd, '.nuxt')))
    return true
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath))
    return false
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
    return Boolean(deps.nuxt || deps['@nuxt/kit'])
  }
  catch {
    return false
  }
}

function listLayerRoots(cwd: string): string[] {
  const roots = [cwd]
  for (const parent of ['layers', 'apps', 'packages']) {
    const dir = join(cwd, parent)
    if (!existsSync(dir))
      continue
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      try {
        if (statSync(abs).isDirectory())
          roots.push(abs)
      }
      catch {}
    }
  }
  return roots
}

const ROOT_CONFIG_FILES = [
  'eslint.config.js',
  'eslint.config.ts',
  'eslint.config.mjs',
  'drizzle.config.ts',
  'tailwind.config.ts',
  'tailwind.config.js',
  'content.config.ts',
  'mdc.config.ts',
  'router.options.ts',
  'vitest.config.e2e.ts',
  'vitest.config.ts',
  'app.config.ts',
]
const CONFIG_FILE_RE = /(?:^|\/)(?:eslint\.config\.[mc]?[jt]s|drizzle\.config\.[mc]?[jt]s|tailwind\.config\.[mc]?[jt]s|content\.config\.[mc]?[jt]s|mdc\.config\.[mc]?[jt]s|router\.options\.[mc]?[jt]s|vitest\.config(?:\.\w+)?\.[mc]?[jt]s|app\.config\.[mc]?[jt]s|.*\.d\.ts)$/

function walkDir(dir: string, out: string[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  }
  catch {
    return
  }
  for (const name of entries) {
    const abs = join(dir, name)
    let s
    try {
      s = statSync(abs)
    }
    catch {
      continue
    }
    if (s.isDirectory()) {
      walkDir(abs, out)
      continue
    }
    if (ENTRY_EXTS.some(ext => name.endsWith(ext)))
      out.push(abs)
  }
}

function isNuxtModulePackage(root: string): boolean {
  const moduleTs = join(root, 'src', 'module.ts')
  if (!existsSync(moduleTs))
    return false
  try {
    const source = readFileSync(moduleTs, 'utf8')
    return source.includes('defineNuxtModule')
  }
  catch {
    return false
  }
}

function collectEntries(cwd: string): string[] {
  const abs: string[] = []
  for (const root of listLayerRoots(cwd)) {
    for (const p of [...NUXT_ENTRY_PATTERNS, ...ROOT_CONFIG_FILES]) {
      const f = join(root, p)
      if (existsSync(f))
        abs.push(f)
    }
    for (const d of [...NUXT_ENTRY_DIRS, ...NUXT_AUTOIMPORT_DIRS]) {
      const dir = join(root, d)
      if (existsSync(dir))
        walkDir(dir, abs)
    }
    // Nuxt module runtime tree is consumed at the user's site (via virtual
    // aliases, addServerImports, addPlugin, addImports). From the module repo's
    // perspective every file here is an entry, not an orphan.
    if (isNuxtModulePackage(root)) {
      const runtime = join(root, 'src', 'runtime')
      if (existsSync(runtime))
        walkDir(runtime, abs)
    }
  }
  return [...new Set(abs.map(p => relative(cwd, p)))]
}

function isAutoImportRel(rel: string): boolean {
  rel = rel.replace(/\\/g, '/')
  return NUXT_AUTOIMPORT_DIRS.some(d => rel.includes(`/${d}/`) || rel.startsWith(`${d}/`))
    || rel.includes('/server/api/')
    || rel.includes('/server/routes/')
    || rel.includes('/server/middleware/')
    || rel.includes('/server/plugins/')
    || rel.includes('/pages/')
    || rel.includes('/layouts/')
    || rel.includes('/middleware/')
    || rel.includes('/plugins/')
    || rel.endsWith('nuxt.config.ts')
    || rel.endsWith('app.vue')
    || rel.endsWith('error.vue')
}

export const doctor: DoctorAdapter = {
  checks: ['shadowed-component', 'phantom-component', 'cross-realm-import', 'stale-nuxt-config-ref'],
  entryFiles(cwd) {
    if (!isNuxtProject(cwd))
      return []
    return collectEntries(cwd)
  },

  filterFinding(_cwd, finding) {
    // Orphan check noise: Nuxt convention files are entries by design; if they
    // still look orphan, the entry list missed them. Drop, don't flag.
    if (finding.check === 'orphan-file' && (isAutoImportRel(finding.file) || CONFIG_FILE_RE.test(finding.file.replace(/\\/g, '/'))))
      return false
    return true
  },

  extraFindings(cwd, ctx, checks) {
    if (!isNuxtProject(cwd))
      return []
    const out: DoctorFinding[] = []
    if (checks.has('shadowed-component')) {
      const components = listComponents(cwd, { source: 'auto' })
      const byName = new Map<string, typeof components>()
      for (const c of components) {
        const arr = byName.get(c.name) ?? []
        arr.push(c)
        byName.set(c.name, arr)
      }
      for (const [name, group] of byName) {
        if (group.length < 2)
          continue
        const winner = group.find(c => !c.shadowed) ?? group[0]
        for (const c of group) {
          if (!c.shadowed)
            continue
          out.push({
            check: 'shadowed-component',
            file: c.rel,
            message: `component "${name}" is shadowed by ${winner.rel}`,
            detail: { name, winner: winner.rel, shadowed: c.rel },
          })
        }
      }
    }
    if (checks.has('phantom-component'))
      out.push(...findPhantomComponents(cwd))
    if (checks.has('cross-realm-import') && ctx)
      out.push(...findCrossRealmImports(cwd, ctx))
    if (checks.has('stale-nuxt-config-ref'))
      out.push(...findStaleNuxtConfigRefs(cwd))
    return out
  },
}

const VUE_BUILTINS = new Set([
  'Transition',
  'TransitionGroup',
  'KeepAlive',
  'Teleport',
  'Suspense',
  'Component',
  'Slot',
  'Template',
  'ClientOnly',
])
const NUXT_BUILTINS = new Set([
  'NuxtPage',
  'NuxtLink',
  'NuxtLayout',
  'NuxtLoadingIndicator',
  'NuxtErrorBoundary',
  'NuxtWelcome',
  'NuxtIsland',
  'NuxtClientFallback',
  'NuxtImg',
  'NuxtPicture',
  'NuxtRouteAnnouncer',
  'DevOnly',
  'ServerOnly',
  'RouterView',
  'RouterLink',
  'Icon',
  'Html',
  'Head',
  'Body',
  'Title',
  'Meta',
  'Link',
  'Style',
  'NoScript',
  'Base',
])
const PASCAL = /^[A-Z][A-Z0-9a-z]*$/
const NODE_ELEMENT = 1

function listAppRoots(cwd: string): string[] {
  // Per-app roots: each apps/* is its own Nuxt scope (own .nuxt, own
  // components.dirs, own extends). Resolving auto-import scope at the
  // monorepo root would falsely mark a component as known when it's only
  // registered in a sibling app, masking real broken refs.
  //
  // layers/* are excluded: they don't run standalone (no .nuxt/), so their
  // files are validated against the union of all app scopes that may consume
  // them — falling back to filesystem-only would lose `@nuxt/ui` and other
  // module-provided components and produce noise.
  const roots: string[] = []
  const parent = join(cwd, 'apps')
  if (!existsSync(parent))
    return roots
  for (const name of readdirSync(parent)) {
    const abs = join(parent, name)
    try {
      if (statSync(abs).isDirectory() && existsSync(join(abs, '.nuxt', 'components.d.ts')))
        roots.push(abs)
    }
    catch {}
  }
  return roots
}

function scopeForFile(abs: string, roots: string[], cwd: string): string {
  let best = cwd
  let bestLen = -1
  for (const root of roots) {
    const rel = relative(root, abs)
    if (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) && root.length > bestLen) {
      best = root
      bestLen = root.length
    }
  }
  return best
}

function buildKnownSet(root: string): Set<string> {
  const known = new Set<string>([...VUE_BUILTINS, ...NUXT_BUILTINS])
  for (const c of listComponents(root, { source: 'auto', warn: () => {} })) {
    known.add(c.name)
    for (const alias of c.aliases ?? [])
      known.add(alias)
  }
  return known
}

function buildUnionKnownSet(roots: string[], cwd: string): Set<string> {
  const known = new Set<string>([...VUE_BUILTINS, ...NUXT_BUILTINS])
  const sources = roots.length ? roots : [cwd]
  for (const root of sources) {
    for (const c of listComponents(root, { source: 'auto', warn: () => {} })) {
      known.add(c.name)
      for (const alias of c.aliases ?? [])
        known.add(alias)
    }
  }
  return known
}

function findPhantomComponents(cwd: string): DoctorFinding[] {
  const files = rgFiles('', { cwd, glob: ['*.vue'], listAll: true })
  const appRoots = listAppRoots(cwd)
  const knownByRoot = new Map<string, Set<string>>()
  if (appRoots.length)
    knownByRoot.set(cwd, buildUnionKnownSet(appRoots, cwd))
  const out: DoctorFinding[] = []
  for (const abs of files) {
    let source: string
    try {
      source = readFileSync(abs, 'utf8')
    }
    catch {
      continue
    }
    const ast = parseVueTemplateAst(source)
    if (!ast)
      continue
    const root = scopeForFile(abs, appRoots, cwd)
    let known = knownByRoot.get(root)
    if (!known) {
      known = buildKnownSet(root)
      knownByRoot.set(root, known)
    }
    const localImports = collectLocalImports(source)
    const seen = new Set<string>()
    walkTpl(ast, (node) => {
      if (node?.type !== NODE_ELEMENT)
        return
      const tag = node.tag
      if (typeof tag !== 'string')
        return
      if (!PASCAL.test(tag))
        return
      if (known!.has(tag) || known!.has(hyphenateVueName(tag)))
        return
      if (localImports.has(tag))
        return
      const key = `${abs}::${tag}::${node.loc?.start?.offset ?? 0}`
      if (seen.has(key))
        return
      seen.add(key)
      const offset = node.loc?.start?.offset ?? 0
      const { line, col } = posToLineCol(source, offset)
      out.push({
        check: 'phantom-component',
        file: relative(cwd, abs),
        line,
        message: `<${tag}> is not a known component (auto-import scope, local import, or built-in)`,
        detail: { name: tag, col, scope: relative(cwd, root) || '.' },
      })
    })
  }
  return out
}

function walkTpl(node: any, visit: (n: any) => void): void {
  if (!node || typeof node !== 'object')
    return
  if (typeof node.type === 'number')
    visit(node)
  for (const child of node.children ?? [])
    walkTpl(child, visit)
}

function collectLocalImports(source: string): Set<string> {
  const out = new Set<string>()
  const scriptMatch = source.match(/<script[^>]*>([\s\S]*?)<\/script>/g)
  if (!scriptMatch)
    return out
  for (const block of scriptMatch) {
    for (const m of block.matchAll(/import\s+(?:\{([^}]+)\}|(\w+)|\*\s+as\s+(\w+))\s+from/g)) {
      if (m[1]) {
        for (const part of m[1].split(',')) {
          const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()!.trim()
          if (name)
            out.add(name)
        }
      }
      else if (m[2]) {
        out.add(m[2])
      }
      else if (m[3]) {
        out.add(m[3])
      }
    }
  }
  return out
}

// --- Cross-realm (server <-> client) boundary check ---

const APP_DIR_RE = /(?:^|\/)(?:app|pages|layouts|components|composables|middleware|plugins)(?:\/|$)/
const SERVER_DIR_RE = /(?:^|\/)server(?:\/|$)/

const SERVER_SUFFIX_RE = /\.server\.(?:[mc]?[jt]sx?|vue)$/
const CLIENT_SUFFIX_RE = /\.client\.(?:[mc]?[jt]sx?|vue)$/

function fileRealm(rel: string): 'app' | 'server' | 'shared' | null {
  rel = rel.replace(/\\/g, '/')
  // Filename conventions override directory classification.
  if (SERVER_SUFFIX_RE.test(rel))
    return 'server'
  if (CLIENT_SUFFIX_RE.test(rel))
    return 'app'
  if (SERVER_DIR_RE.test(rel) && !APP_DIR_RE.test(rel))
    return 'server'
  if (APP_DIR_RE.test(rel) && !SERVER_DIR_RE.test(rel))
    return 'app'
  return null
}

function findCrossRealmImports(cwd: string, ctx: DoctorContext): DoctorFinding[] {
  const out: DoctorFinding[] = []
  for (const file of ctx.index.files) {
    const fromRealm = fileRealm(file.file)
    if (!fromRealm)
      continue
    for (const imp of file.imports) {
      if (imp.typeOnly)
        continue
      // Only consider relative imports. Aliased specifiers like `#app/...`,
      // `#imports`, `~/...` resolve to opaque targets (Nuxt runtime, virtuals,
      // user-aliased roots) where realm classification is unreliable. Relative
      // imports are unambiguous after fs resolution.
      if (!imp.source.startsWith('.'))
        continue
      const resolved = resolveRelativeFs(file.file, imp.source, cwd)
      if (!resolved)
        continue
      const targetRel = relative(cwd, resolved)
      const toRealm = fileRealm(targetRel)
      if (!toRealm || toRealm === fromRealm)
        continue
      out.push({
        check: 'cross-realm-import',
        file: file.file,
        line: imp.line,
        message: `${fromRealm}-realm file imports runtime value "${imp.imported || '*'}" from ${toRealm}-realm "${imp.source}"`,
        detail: { fromRealm, toRealm, source: imp.source, imported: imp.imported },
      })
    }
  }
  return out
}

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '/index.ts', '/index.tsx', '/index.js']

function resolveRelativeFs(fromRel: string, specifier: string, cwd: string): string | null {
  if (!specifier.startsWith('.'))
    return null
  const base = resolve(cwd, fromRel, '..', specifier)
  for (const ext of RESOLVE_EXTS) {
    const candidate = base + ext
    if (existsSync(candidate))
      return candidate
  }
  return null
}

// --- Stale Nuxt config refs ---

const CONFIG_NAMES = ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.mts']
const STRING_FIELDS = ['extends', 'modules', 'css']
const COMPONENT_PATH_RE = /\{\s*path\s*:\s*['"]([^'"]+)['"]/g
const ARRAY_FIELD_RE = (field: string) => new RegExp(`\\b${field}\\s*:\\s*\\[([\\s\\S]*?)\\]`)
const IMPORT_DIRS_RE = /\bimports\s*:\s*\{[\s\S]*?\bdirs\s*:\s*\[([\s\S]*?)\]/

function findStaleNuxtConfigRefs(cwd: string): DoctorFinding[] {
  const out: DoctorFinding[] = []
  for (const root of listLayerRoots(cwd)) {
    for (const name of CONFIG_NAMES) {
      const abs = join(root, name)
      if (!existsSync(abs))
        continue
      let source: string
      try {
        source = readFileSync(abs, 'utf8')
      }
      catch {
        continue
      }
      const rel = relative(cwd, abs)
      for (const field of STRING_FIELDS) {
        const match = ARRAY_FIELD_RE(field).exec(source)
        if (!match)
          continue
        for (const lit of match[1].matchAll(/['"`]([^'"`]+)['"`]/g)) {
          const value = lit[1]!
          if (!value.startsWith('.') && !value.startsWith('/'))
            continue
          const targetPath = resolve(root, value)
          if (existsSync(targetPath))
            continue
          // For modules: try resolving as a TS file too.
          let exists = false
          for (const ext of RESOLVE_EXTS) {
            if (existsSync(targetPath + ext)) {
              exists = true
              break
            }
          }
          if (exists)
            continue
          out.push({
            check: 'stale-nuxt-config-ref',
            file: rel,
            message: `${field}: "${value}" does not resolve from ${rel}`,
            detail: { field, value, root: relative(cwd, root) },
          })
        }
      }
      const importsMatch = IMPORT_DIRS_RE.exec(source)
      if (importsMatch) {
        for (const lit of importsMatch[1].matchAll(/['"`]([^'"`]+)['"`]/g)) {
          const value = lit[1]!
          if (!value.startsWith('.') && !value.startsWith('/'))
            continue
          const dirPath = resolve(root, value.replace(/\/\*\*.*$/, '').replace(/\/\*.*$/, ''))
          if (existsSync(dirPath))
            continue
          out.push({
            check: 'stale-nuxt-config-ref',
            file: rel,
            message: `imports.dirs: "${value}" does not resolve from ${rel}`,
            detail: { field: 'imports.dirs', value, root: relative(cwd, root) },
          })
        }
      }
      for (const m of source.matchAll(COMPONENT_PATH_RE)) {
        const value = m[1]!
        if (!value.startsWith('.') && !value.startsWith('/'))
          continue
        const dirPath = resolve(root, value.replace(/\/\*\*.*$/, '').replace(/\/\*.*$/, ''))
        if (existsSync(dirPath))
          continue
        out.push({
          check: 'stale-nuxt-config-ref',
          file: rel,
          message: `components: path "${value}" does not resolve from ${rel}`,
          detail: { field: 'components.path', value, root: relative(cwd, root) },
        })
      }
    }
  }
  return out
}
