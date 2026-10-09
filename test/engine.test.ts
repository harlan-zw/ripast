import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parseSourceFile } from '../packages/core/src/adapter.ts'
import { createEngine } from '../packages/core/src/index.ts'
import { createVueExtension } from '../packages/vue/src/index.ts'

const directories: string[] = []
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), 'ripide-engine-'))
  directories.push(cwd)
  writeFileSync(join(cwd, 'view.custom'), 'header\nexport const shared = 1\n')
  return cwd
}
afterEach(() => directories.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })))
const extension = {
  name: 'custom',
  suffixes: ['.custom'],
  parse: ({ path, source }: { path: string, source: string, cwd: string }) => ({ _tag: 'Script' as const, source: source.slice(7), start: 7, filename: `${path}.ts` }),
}
it('ignores shell exports in configuration dotfiles without omitting authored source', async () => {
  const cwd = fixture()
  rmSync(join(cwd, 'view.custom'))
  writeFileSync(join(cwd, '.envrc'), 'export FOO=bar\n')
  writeFileSync(join(cwd, 'source.ts'), 'export const shared = 1\n')
  const engine = createEngine()
  const result = await engine.rename('shared', 'next', { cwd, verifyMode: 'none' as const })
  engine.commit(result)
  expect(readFileSync(join(cwd, 'source.ts'), 'utf8')).toContain('export const next')
  writeFileSync(join(cwd, 'view.unknown'), 'export const consumer = 1\n')
  await expect(engine.rename('next', 'third', { cwd, verifyMode: 'none' as const })).rejects.toThrow(/Required extension missing/)
})

it.each([false, true])('checks semantic plans once unless hooks change them, modified=%s', async (modified) => {
  const cwd = fixture()
  rmSync(join(cwd, 'view.custom'))
  writeFileSync(join(cwd, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true},"include":["*.ts"]}')
  writeFileSync(join(cwd, 'source.ts'), 'export const shared = 1\n')
  writeFileSync(join(cwd, 'view.vue'), '<script setup lang="ts">import { shared } from "./source"\n</script><template>{{ shared }}</template>')
  const vue = createVueExtension()
  let checks = 0
  const engine = createEngine({ extensions: [{ ...vue, semantic: { ...vue.semantic!, async regressions(_config, _cwd, _changes, record) {
    checks++
    record?.({ files: 1, newErrors: 0 })
    return []
  } }, setup(hooks) {
    if (modified)
      hooks.hook('verify:before', ({ changes }) => { changes[0]!.after += '\n' })
  } }] })
  const result = await engine.rename('shared', 'next', { cwd, verifyMode: 'project' })
  expect(checks).toBe(modified ? 2 : 1)
  expect(result.verification).toMatchObject({ _tag: 'Checked', checks: expect.arrayContaining([{ checker: 'vue', scope: 'project', files: 1, newErrors: 0 }]) })
  engine.commit(result)
  expect(readFileSync(join(cwd, 'view.vue'), 'utf8')).toContain('{{ next }}')
})
it('discovers a third suffix with authored positions and isolated registrations', () => {
  const cwd = fixture()
  const custom = createEngine({ extensions: [extension] })
  const ordinary = createEngine()
  expect(custom.scan('shared', { cwd })).toMatchObject([{ file: 'view.custom', line: 2, col: 14 }])
  expect(ordinary.scan('shared', { cwd })).toEqual([])
})
it('shares authored parsing between doctor declarations and its dependency index', async () => {
  const cwd = fixture()
  writeFileSync(join(cwd, 'source.ts'), 'export const shared = 2\n')
  let parses = 0
  const engine = createEngine({ extensions: [{ ...extension, parse(input) {
    parses++
    return extension.parse(input)
  } }] })
  const report = await engine.runDoctor({ cwd, checks: ['duplicate-export', 'circular-dep'] })
  expect(parses).toBe(1)
  expect(report.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ check: 'duplicate-export', file: 'view.custom', line: 2 }),
    expect.objectContaining({ check: 'duplicate-export', file: 'source.ts', line: 1 }),
  ]))
})
it('reports diagnostics from the final hook-modified plan', async () => {
  const cwd = fixture()
  writeFileSync(join(cwd, 'source.ts'), 'export const provider = 1\n')
  const engine = createEngine({ extensions: [{
    ...extension,
    operations: ['rename'],
    verify: async () => [],
    setup(hooks) {
      hooks.hook('plan:ready', ({ changes }) => {
        changes[0]!.after += 'const broken: string = 1\n'
      })
    },
  }] })
  const result = await engine.rename('provider', 'next', { cwd })
  expect(result.regressions).toHaveLength(1)
  expect(result.verification).toEqual({ _tag: 'Checked', checks: [{ checker: 'typescript', scope: 'project', files: 1, newErrors: 1 }] })
  expect(() => engine.commit(result)).toThrow(/Verification failed/)
})
it('rejects duplicate suffix ownership before mutation', () => {
  const cwd = fixture()
  expect(() => createEngine({ extensions: [extension, { ...extension, name: 'second' }] })).toThrow(/ownership/)
  expect(readFileSync(join(cwd, 'view.custom'), 'utf8')).toBe('header\nexport const shared = 1\n')
})
it('propagates broken initialization', () => {
  expect(() => createEngine({ extensions: [{ ...extension, setup: () => {
    throw new Error('broken setup')
  } }] })).toThrow('broken setup')
})
it('refuses asynchronous setup before creating an engine', () => {
  expect(() => createEngine({ extensions: [{ ...extension, async setup() {} }] })).toThrow(/synchronous/)
  expect(() => createEngine({ extensions: [{ ...extension, setup: () => Promise.resolve() }] })).toThrow(/synchronous/)
})

it('preserves component services when multiple semantic extensions coexist', async () => {
  const cwd = fixture()
  rmSync(join(cwd, 'view.custom'))
  mkdirSync(join(cwd, 'components'))
  writeFileSync(join(cwd, 'components/Card.vue'), '<template><div>Card</div></template>')
  const vue = createVueExtension()
  const engine = createEngine({ extensions: [{ ...vue, semantic: { ...vue.semantic!, autoImportScopes: undefined } }, {
    ...extension,
    semantic: {
      name: 'custom',
      hasFilesContaining: () => false,
      applyRename: async () => [],
      applyImportRewrite: async () => [],
      applyFileRenameEdits: async () => [],
      regressions: async () => [],
    },
  }] })
  const inventory = await engine.buildComponentInventory({ cwd, source: 'filesystem' })
  expect(inventory.components.map(component => component.name)).toContain('Card')
})
it('resolves explicit verification configuration against the project directory', async () => {
  const cwd = fixture()
  rmSync(join(cwd, 'view.custom'))
  writeFileSync(join(cwd, 'source.ts'), 'export const shared = 1\n')
  writeFileSync(join(cwd, 'custom.json'), '{"compilerOptions":{"noEmit":true},"include":["*.ts"]}')
  const configs: string[] = []
  const engine = createEngine({ extensions: [{
    ...extension,
    semantic: {
      name: 'custom',
      hasFilesContaining: () => false,
      applyRename: async () => [],
      applyImportRewrite: async () => [],
      applyFileRenameEdits: async () => [],
      async regressions(config) {
        configs.push(config)
        return []
      },
    },
  }] })
  const result = await engine.rename('shared', 'renamed', { cwd, tsconfig: 'custom.json' })
  expect(configs).toEqual([join(cwd, 'custom.json')])
  engine.commit(result)
  expect(readFileSync(join(cwd, 'source.ts'), 'utf8')).toContain('export const renamed')
})
it('refuses a parser-only extension mutation before writes', async () => {
  const cwd = fixture()
  await expect(createEngine({ extensions: [extension] }).rename('shared', 'next', { cwd })).rejects.toThrow(/rename/)
  expect(readFileSync(join(cwd, 'view.custom'), 'utf8')).toBe('header\nexport const shared = 1\n')
})

it.each(['touched', 'project'] as const)('renames a TS provider, TS importer, and third-suffix consumer with %s verification', async (verify) => {
  const cwd = fixture()
  writeFileSync(join(cwd, 'source.ts'), 'export const shared = 1\nexport const other = 2\n')
  writeFileSync(join(cwd, 'consumer.ts'), 'import { shared } from \'./source.ts\'\nexport const value = shared\n')
  const engine = createEngine({ extensions: [{
    ...extension,
    operations: ['rename'],
    verify: async () => [],
    async planRename({ from, to }) {
      const path = join(cwd, 'view.custom')
      const before = readFileSync(path, 'utf8')
      const hits = createEngine({ extensions: [extension] }).scan(from, { cwd })
      expect(hits.find(hit => hit.file === 'view.custom')).toMatchObject({ line: 2, col: 14 })
      return { changes: [{ path, rel: 'view.custom', before, after: before.replace(from, to) }], regressions: [], warnings: [], scanned: 1 }
    },
  }] })
  const result = await engine.rename('shared', 'renamed', { cwd, verifyMode: typeof verify === 'boolean' ? verify ? 'touched' : 'none' : verify })
  expect(result.regressions).toEqual([])
  expect(result.changes.map(change => change.rel).sort()).toEqual(['consumer.ts', 'source.ts', 'view.custom'])
  expect(readFileSync(join(cwd, 'source.ts'), 'utf8')).toContain('export const shared')
  engine.commit(result)
  expect(readFileSync(join(cwd, 'source.ts'), 'utf8')).toBe('export const renamed = 1\nexport const other = 2\n')
  expect(readFileSync(join(cwd, 'consumer.ts'), 'utf8')).toContain('{ renamed }')
  expect(readFileSync(join(cwd, 'view.custom'), 'utf8')).toContain('export const renamed')
})

it('verifies hook-added changes before commit and preserves bytes on failure', async () => {
  const cwd = fixture()
  rmSync(join(cwd, 'view.custom'))
  writeFileSync(join(cwd, 'source.ts'), 'export const shared: number = 1\n')
  const before = readFileSync(join(cwd, 'source.ts'), 'utf8')
  const engine = createEngine({ extensions: [{
    ...extension,
    setup(hooks) {
      hooks.hook('plan:ready', ({ changes }) => {
        changes[0]!.after = 'export const renamed: number = "bad"\n'
      })
    },
  }] })
  const result = await engine.rename('shared', 'renamed', { cwd })
  expect(result.regressions.some(regression => regression.code === 2322)).toBe(true)
  expect(() => engine.commit(result)).toThrow(/Verification/)
  expect(readFileSync(join(cwd, 'source.ts'), 'utf8')).toBe(before)
})

it('refuses conflicting plans from multiple relevant extensions', async () => {
  const cwd = fixture()
  writeFileSync(join(cwd, 'view.second'), 'header\nexport const shared = 1\n')
  const path = join(cwd, 'view.custom')
  const before = readFileSync(path, 'utf8')
  const planner = (after: string) => async () => ({ changes: [{ path, rel: 'view.custom', before, after }], regressions: [], warnings: [], scanned: 1 })
  const engine = createEngine({ extensions: [
    { ...extension, operations: ['rename'], verify: async () => [], planRename: planner('one') },
    { ...extension, name: 'second', suffixes: ['.second'], operations: ['rename'], verify: async () => [], planRename: planner('two') },
  ] })
  await expect(engine.rename('shared', 'renamed', { cwd })).rejects.toThrow(/Conflicting/)
  expect(readFileSync(path, 'utf8')).toBe(before)
})

it('refuses missing required extension ownership', () => {
  expect(() => createEngine({ requiredSuffixes: ['.custom'] })).toThrow(/Required extension missing/)
})

it('scans an authored AST from a third grammar without a TypeScript source region', () => {
  const cwd = fixture()
  writeFileSync(join(cwd, 'view.grammar'), 'const$ shared = 1\n')
  const engine = createEngine({ extensions: [{
    name: 'grammar',
    suffixes: ['.grammar'],
    parse({ source, path }) {
      const { program } = parseSourceFile(`${path}.ts`, source.replace('const$', 'const '))
      return { _tag: 'Authored', program }
    },
  }] })
  expect(engine.scan('shared', { cwd })).toMatchObject([{ file: 'view.grammar', line: 1, col: 8, kind: 'identifier-binding' }])
  expect(engine.declarations({ cwd })).toMatchObject({ files: [{ file: 'view.grammar', declarations: [{ name: 'shared', line: 1, col: 8 }] }] })
})

it('merges plans from two relevant suffixes without dropping ordinary consumers', async () => {
  const cwd = fixture()
  writeFileSync(join(cwd, 'view.second'), 'header\nexport const shared = 1\n')
  writeFileSync(join(cwd, 'source.ts'), 'export const shared = 1\n')
  const planner = (filename: string) => async ({ from, to }: { from: string, to: string }) => {
    const path = join(cwd, filename)
    const before = readFileSync(path, 'utf8')
    const change = { path, rel: filename, before, after: before.replace(from, to) }
    return { changes: [change, { ...change }], regressions: [], warnings: [], scanned: 1 }
  }
  const engine = createEngine({ extensions: [
    { ...extension, operations: ['rename'], verify: async () => [], planRename: planner('view.custom') },
    { ...extension, name: 'second', suffixes: ['.second'], operations: ['rename'], verify: async () => [], planRename: planner('view.second') },
  ] })
  const result = await engine.rename('shared', 'next', { cwd })
  expect(result.changes.map(change => change.rel).sort()).toEqual(['source.ts', 'view.custom', 'view.second'])
  engine.commit(result)
  expect(readFileSync(join(cwd, 'view.second'), 'utf8')).toContain('export const next')
})

it('commits a file rename and its consumer edits through one write boundary', async () => {
  const cwd = fixture()
  rmSync(join(cwd, 'view.custom'))
  writeFileSync(join(cwd, 'tsconfig.json'), '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler","allowImportingTsExtensions":true,"noEmit":true},"include":["*.ts"]}')
  writeFileSync(join(cwd, 'source.ts'), 'export const shared = 1\n')
  writeFileSync(join(cwd, 'consumer.ts'), 'import { shared } from "./source.ts"\nexport const value = shared\n')
  const engine = createEngine()
  const result = await engine.renameFile('source.ts', 'moved.ts', { cwd })
  engine.commit(result)
  expect(readFileSync(join(cwd, 'moved.ts'), 'utf8')).toBe('export const shared = 1\n')
  expect(readFileSync(join(cwd, 'consumer.ts'), 'utf8')).toContain('./moved.ts')
  expect(() => readFileSync(join(cwd, 'source.ts'), 'utf8')).toThrow()
})

it.each(['hard-link', 'dangling-link'] as const)('refuses a %s target created after planning', async (kind) => {
  const cwd = fixture()
  rmSync(join(cwd, 'view.custom'))
  writeFileSync(join(cwd, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true},"include":["*.ts"]}')
  const source = join(cwd, 'Source.ts')
  const target = join(cwd, 'target.ts')
  writeFileSync(source, 'export const value = 1\n')
  const engine = createEngine()
  const result = await engine.renameFile('Source.ts', 'target.ts', { cwd, verifyMode: 'none' as const })
  if (kind === 'hard-link')
    linkSync(source, target)
  else
    symlinkSync(join(cwd, 'missing.ts'), target)
  expect(() => engine.commit(result)).toThrow(/target already exists/)
  expect(readFileSync(source, 'utf8')).toBe('export const value = 1\n')
})

it('checks a hook-added file rename diagnostic before writing', async () => {
  const cwd = fixture()
  rmSync(join(cwd, 'view.custom'))
  writeFileSync(join(cwd, 'tsconfig.json'), '{"compilerOptions":{"module":"ESNext","moduleResolution":"bundler","noEmit":true},"include":["*.ts"]}')
  writeFileSync(join(cwd, 'source.ts'), 'export const shared = 1\n')
  writeFileSync(join(cwd, 'consumer.ts'), 'import { shared } from "./source"\nexport const value: number = shared\n')
  const engine = createEngine({ extensions: [{ ...extension, setup(hooks) {
    hooks.hook('plan:ready', ({ changes }) => {
      changes[0]!.after = 'export const value: number = "bad"\n'
    })
  } }] })
  const result = await engine.renameFile('source.ts', 'moved.ts', { cwd })
  expect(result.regressions.some(regression => regression.code === 2322)).toBe(true)
  expect(() => engine.commit(result)).toThrow(/Verification/)
  expect(readFileSync(join(cwd, 'source.ts'), 'utf8')).toContain('export const shared')
})

it('resolves registered suffixes in graphs and unused consumers', async () => {
  const cwd = fixture()
  writeFileSync(join(cwd, 'view.custom'), 'header\nimport { shared } from "./source"\nexport const view = shared\n')
  writeFileSync(join(cwd, 'consumer.ts'), 'import { view } from "./view"\nexport const shared = view\n')
  writeFileSync(join(cwd, 'source.ts'), 'export const shared = 1\n')
  const engine = createEngine({ extensions: [extension] })
  expect(engine.graph('shared', { cwd }).edges).toContainEqual({ from: 'consumer.ts', to: 'view.custom', specifier: './view' })
  const unused = await engine.unused({ cwd, exports: 'exported' })
  expect(unused.files.find(file => file.file === 'source.ts')?.declarations.map(declaration => declaration.name) ?? []).not.toContain('shared')
})
