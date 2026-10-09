import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { runMove, runRename, runRenameFile } from '@ripast/core'
import vueAdapter from '@ripast/vue'
import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { it } from 'vitest'

function fixture(alias: boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'ripide-nuxt-reference-'))
  cpSync(new URL('./fixtures/nuxt/', import.meta.url), dir, { recursive: true })
  rmSync(join(dir, 'pages'), { recursive: true, force: true })
  mkdirSync(join(dir, 'app/utils'), { recursive: true })
  mkdirSync(join(dir, 'app/components'), { recursive: true })
  mkdirSync(join(dir, 'server/utils'), { recursive: true })
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ files: [], references: [
    { path: './.nuxt/tsconfig.app.json' },
    { path: './.nuxt/tsconfig.server.json' },
  ] }))
  const options = { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', noEmit: true, types: [], baseUrl: '..' }
  writeFileSync(join(dir, '.nuxt/tsconfig.app.json'), JSON.stringify({ compilerOptions: { ...options, paths: { '~/*': ['app/*'] } }, include: ['../app/**/*', './imports.d.ts'] }))
  writeFileSync(join(dir, '.nuxt/tsconfig.server.json'), JSON.stringify({ compilerOptions: { ...options, paths: { '~/*': ['server/*'] } }, include: ['../server/**/*'] }))
  writeFileSync(join(dir, '.nuxt/imports.d.ts'), `declare global { const format: typeof import('../app/utils/format')['format'] } export {}`)
  writeFileSync(join(dir, 'app/utils/format.ts'), 'export function format(value: number) { return "#" + value }')
  writeFileSync(join(dir, 'server/utils/format.ts'), 'export function format(value: number) { return "other:" + value }')
  const specifier = alias ? '~/utils/format' : '../utils/format'
  const component = `<script setup lang="ts">import { format } from '${specifier}'</script><template>{{ format(1) }}</template>`
  const unrelated = `<script setup lang="ts">import { format } from '~/utils/format'; const label = format(2)</script><template>{{ format(3) }}</template>`
  writeFileSync(join(dir, 'app/components/Explicit.vue'), component)
  writeFileSync(join(dir, 'app/page.vue'), '<script setup lang="ts">const label = format(4)</script><template>{{ format(5) }}</template>')
  writeFileSync(join(dir, 'server/Other.vue'), unrelated)
  return { dir, component, unrelated, specifier }
}

it.each([{ alias: false, verify: false }, { alias: true, verify: false }, { alias: false, verify: true }, { alias: true, verify: true }])('renames referenced template-only imports with %j', async ({ alias, verify }) => {
  const fx = fixture(alias)
  try {
    const metadata = readFileSync(join(fx.dir, '.nuxt/imports.d.ts'), 'utf8')
    const result = await runRename('format', 'pretty', { cwd: fx.dir, scope: 'app/utils/format.ts', verify })
    assert.deepEqual(result.regressions, [])
    assert.equal(result.changes.some(change => change.rel.includes('.nuxt/')), false)
    assert.equal(readFileSync(join(fx.dir, '.nuxt/imports.d.ts'), 'utf8'), metadata)
    const component = result.changes.find(change => change.rel === 'app/components/Explicit.vue')?.after
    assert.ok(component, 'The explicit consumer must follow the renamed export.')
    const exports: { default?: { setup: (props: object, context: object) => object } } = {}
    const compiled = compileScript(parse(component).descriptor, { id: 'reference' })
    runInNewContext(ts.transpileModule(compiled.content, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      exports,
      require: (specifier: string) => {
        if (specifier === 'vue')
          return { defineComponent: (value: unknown) => value }
        assert.equal(specifier, fx.specifier)
        return { pretty: (value: number) => `#${value}` }
      },
    })
    const context = exports.default!.setup({}, { expose: () => {} })
    const rendered: unknown[] = []
    const output: { render?: (context: object, cache: unknown[]) => unknown } = {}
    const template = compileTemplate({ id: 'reference', filename: 'Explicit.vue', source: parse(component).descriptor.template!.content })
    runInNewContext(ts.transpileModule(template.code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      exports: output,
      require: () => ({ toDisplayString: (value: unknown) => { rendered.push(value) } }),
    })
    output.render!(context, [])
    assert.deepEqual(rendered, ['#1'])
    assert.equal(result.changes.find(change => change.rel === 'server/Other.vue'), undefined)
    assert.equal(readFileSync(join(fx.dir, 'app/components/Explicit.vue'), 'utf8'), fx.component)
    assert.equal(readFileSync(join(fx.dir, 'server/Other.vue'), 'utf8'), fx.unrelated)
  }
  finally { rmSync(fx.dir, { recursive: true, force: true }) }
})

it('keeps unrelated new errors visible with generated verification overlays', async () => {
  const fx = fixture(false)
  try {
    const result = await runRename('format', 'pretty', { cwd: fx.dir, scope: 'app/utils/format.ts', verify: false })
    const provider = join(fx.dir, 'app/utils/format.ts')
    const source = readFileSync(provider, 'utf8')
    const plan = vueAdapter.planAutoImportRename!({ cwd: fx.dir, from: 'format', to: 'pretty', sites: [{ filePath: provider, source, pos: source.indexOf('format') }] })
    const component = result.changes.find(change => change.rel === 'app/components/Explicit.vue')!
    const regressions = await vueAdapter.regressions(join(fx.dir, 'tsconfig.json'), fx.dir, [
      ...result.changes.filter(change => change.path !== component.path),
      { ...component, after: component.after.replace('</script>', '; const wrong: string = 1</script>') },
      ...plan.verificationChanges,
    ])
    assert.ok(regressions.some(regression => regression.file === component.path && regression.code === 2322))
    assert.equal(regressions.some(regression => regression.code === 2304 || regression.code === 2339), false, JSON.stringify(regressions))
  }
  finally { rmSync(fx.dir, { recursive: true, force: true }) }
})

it('reports new Vue errors through the referenced project configuration', async () => {
  const fx = fixture(false)
  try {
    const component = '<script setup lang="ts">\nconst label: string = "valid"\n</script><template>{{ label }}</template>'
    writeFileSync(join(fx.dir, 'app/components/Explicit.vue'), component)
    const regressions = await vueAdapter.regressions(join(fx.dir, 'tsconfig.json'), fx.dir, [{
      path: join(fx.dir, 'app/components/Explicit.vue'),
      rel: 'app/components/Explicit.vue',
      before: component,
      after: '<script setup lang="ts">\nconst label: string = 1\n</script><template>{{ label }}</template>',
    }])
    assert.ok(regressions.some(regression => regression.file.endsWith('/app/components/Explicit.vue') && regression.code === 2322), `The referenced project must report the new type error: ${JSON.stringify(regressions)}`)
    assert.equal(readFileSync(join(fx.dir, 'app/components/Explicit.vue'), 'utf8'), component)
  }
  finally { rmSync(fx.dir, { recursive: true, force: true }) }
})

it('counts additional Vue errors without flagging shifted existing errors', async () => {
  const fx = fixture(false)
  try {
    const path = join(fx.dir, 'app/components/Explicit.vue')
    const component = '<script setup lang="ts">\nconst first: string = 1\n</script><template>{{ first }}</template>'
    writeFileSync(path, component)
    const regressions = await vueAdapter.regressions(join(fx.dir, 'tsconfig.json'), fx.dir, [{
      path,
      rel: 'app/components/Explicit.vue',
      before: component,
      after: '<script setup lang="ts">\n// shifted existing error\nconst first: string = 1\nconst second: string = 2\n</script><template>{{ first }} {{ second }}</template>',
    }])
    assert.equal(regressions.filter(regression => regression.file === path && regression.code === 2322).length, 1)
  }
  finally { rmSync(fx.dir, { recursive: true, force: true }) }
})

it.each(['move', 'rename-file'])('rewrites referenced-project Vue imports during %s', async (operation) => {
  const fx = fixture(false)
  try {
    const result = operation === 'move'
      ? await runMove('format', 'app/utils/format.ts', 'app/utils/pretty.ts', { cwd: fx.dir, verify: false })
      : await runRenameFile('app/utils/format.ts', 'app/utils/pretty.ts', { cwd: fx.dir, verify: false })
    const consumer = result.changes.find(change => change.rel === 'app/components/Explicit.vue')
    assert.ok(consumer, 'The explicit consumer must follow the moved provider.')
    assert.match(consumer.after, /from ['"]\.\.\/utils\/pretty['"]/)
    assert.equal(result.changes.find(change => change.rel === 'server/Other.vue'), undefined)
  }
  finally { rmSync(fx.dir, { recursive: true, force: true }) }
})

it('checks a pending new Vue file with an explicit project configuration', async () => {
  const fx = fixture(false)
  try {
    const path = join(fx.dir, 'app/components/New.vue')
    const regressions = await vueAdapter.regressions(join(fx.dir, '.nuxt/tsconfig.app.json'), fx.dir, [{
      path,
      rel: 'app/components/New.vue',
      before: '',
      after: '<script setup lang="ts">\nconst label: string = 1\n</script><template>{{ label }}</template>',
    }])
    assert.ok(regressions.some(regression => regression.file === path && regression.code === 2322))
  }
  finally { rmSync(fx.dir, { recursive: true, force: true }) }
})

it('refuses to skip a pending Vue file with ambiguous project membership', async () => {
  const fx = fixture(false)
  try {
    await assert.rejects(() => vueAdapter.regressions(join(fx.dir, 'tsconfig.json'), fx.dir, [{
      path: join(fx.dir, 'app/components/New.vue'),
      rel: 'app/components/New.vue',
      before: '',
      after: '<script setup lang="ts">const label: string = 1</script>',
    }]), /cannot select a Vue project.*explicit tsconfig/)
  }
  finally { rmSync(fx.dir, { recursive: true, force: true }) }
})

it('checks existing Vue callers against pending new TypeScript exports', async () => {
  const fx = fixture(false)
  try {
    const path = join(fx.dir, 'app/components/Explicit.vue')
    const component = '<script setup lang="ts">\nconst label: string = "valid"\n</script><template>{{ label }}</template>'
    writeFileSync(path, component)
    const regressions = await vueAdapter.regressions(join(fx.dir, 'tsconfig.json'), fx.dir, [{
      path,
      rel: 'app/components/Explicit.vue',
      before: component,
      after: '<script setup lang="ts">\nimport { value } from "../utils/new"\nconst label: string = value\n</script><template>{{ label }}</template>',
    }, {
      path: join(fx.dir, 'app/utils/new.ts'),
      rel: 'app/utils/new.ts',
      before: '',
      after: 'export const value = 1',
    }])
    assert.ok(regressions.some(regression => regression.file === path && regression.code === 2322), JSON.stringify(regressions))
    assert.equal(regressions.some(regression => regression.code === 2307), false)
  }
  finally { rmSync(fx.dir, { recursive: true, force: true }) }
})
