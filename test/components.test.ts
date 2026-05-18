import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseComponentSource } from '../packages/vue/src/component-parse.ts'
import { findComponentUsages } from '../packages/vue/src/component-usages.ts'
import { listComponents } from '../packages/vue/src/components.ts'
import { makeFixture } from './helpers.ts'

const LAYERED_FIXTURE = resolve(__dirname, 'fixtures/nuxt-layers')

const MANIFEST = `declare module "vue" {
  export interface GlobalComponents {
    MyButton: typeof import("../components/MyButton.vue")["default"]
    LazyMyButton: typeof import("../components/MyButton.vue")["default"]
    BaseCard: typeof import("../components/BaseCard.vue")["default"]
  }
}

export {}
`

describe('listComponents', () => {
  it('parses .nuxt/components.d.ts and collapses lazy aliases', () => {
    const fx = makeFixture({
      '.nuxt/components.d.ts': MANIFEST,
      'components/MyButton.vue': '<template><button /></template>',
      'components/BaseCard.vue': '<template><div /></template>',
    }, false)
    try {
      const list = listComponents(fx.dir, { warn: () => {} })
      const names = list.map(c => c.name)
      expect(names).toEqual(['BaseCard', 'MyButton'])
      const myButton = list.find(c => c.name === 'MyButton')!
      expect(myButton.aliases).toContain('LazyMyButton')
      expect(myButton.aliases).toContain('my-button')
      expect(myButton.source).toBe('manifest')
      expect(myButton.scope).toBe('auto-import')
      expect(myButton.shadowed).toBe(false)
      expect(myButton.file.endsWith('components/MyButton.vue')).toBe(true)
    }
    finally { fx.cleanup() }
  })

  it('marks filesystem components that share a name with a manifest entry as shadowed', () => {
    const fx = makeFixture({
      '.nuxt/components.d.ts': `declare module "vue" {
  export interface GlobalComponents {
    MyButton: typeof import("../components/MyButton.vue")["default"]
  }
}
export {}
`,
      'components/MyButton.vue': '<template>winner</template>',
      'layers/base/components/MyButton.vue': '<template>loser</template>',
    }, false)
    try {
      const list = listComponents(fx.dir, { warn: () => {} })
      const shadowed = list.filter(c => c.shadowed)
      expect(shadowed).toHaveLength(1)
      expect(shadowed[0]!.rel).toContain('layers/base/components/MyButton.vue')
      expect(shadowed[0]!.shadowedBy).toBeDefined()
      expect(shadowed[0]!.source).toBe('filesystem')
    }
    finally { fx.cleanup() }
  })

  it('falls back to filesystem glob when no manifest', () => {
    const fx = makeFixture({
      'components/Foo.vue': '<template>foo</template>',
      'components/bar-baz.vue': '<template>bar</template>',
      'app/notes.txt': 'ignored',
    }, false)
    try {
      const warnings: string[] = []
      const list = listComponents(fx.dir, { warn: msg => warnings.push(msg) })
      expect(list.map(c => c.name).sort()).toEqual(['BarBaz', 'Foo'])
      expect(list.every(c => c.source === 'filesystem')).toBe(true)
      expect(warnings.some(w => w.includes('nuxi prepare'))).toBe(true)
    }
    finally { fx.cleanup() }
  })

  it('flags name collisions in filesystem-only mode', () => {
    const fx = makeFixture({
      'components/Hero.vue': '<template>a</template>',
      'layers/marketing/components/Hero.vue': '<template>b</template>',
    }, false)
    try {
      const list = listComponents(fx.dir, { warn: () => {} })
      const heroes = list.filter(c => c.name === 'Hero')
      expect(heroes).toHaveLength(2)
      expect(heroes.filter(h => h.shadowed)).toHaveLength(1)
    }
    finally { fx.cleanup() }
  })
})

describe('parseComponentSource', () => {
  it('extracts defineProps type literal', () => {
    const sfc = `<script setup lang="ts">
const props = defineProps<{ size?: number, label: string }>()
</script>
<template><div /></template>`
    const r = parseComponentSource('/x/Foo.vue', sfc)
    expect(r.scriptLang).toBe('ts')
    expect(r.setup).toBe(true)
    expect(r.props.map(p => p.name).sort()).toEqual(['label', 'size'])
    const label = r.props.find(p => p.name === 'label')!
    expect(label.required).toBe(true)
    const size = r.props.find(p => p.name === 'size')!
    expect(size.required).toBe(false)
    expect(r.propsResolution).toBe('literal')
  })

  it('extracts defineEmits call-signature and array forms', () => {
    const sfc = `<script setup lang="ts">
defineEmits<{ (e: 'submit', value: string): void, (e: 'cancel'): void }>()
</script>`
    const r = parseComponentSource('/x/A.vue', sfc)
    expect(r.emits.sort()).toEqual(['cancel', 'submit'])

    const sfc2 = `<script setup>
defineEmits(['change', 'reset'])
</script>`
    const r2 = parseComponentSource('/x/B.vue', sfc2)
    expect(r2.emits.sort()).toEqual(['change', 'reset'])
  })

  it('extracts defineSlots and defineExpose', () => {
    const sfc = `<script setup lang="ts">
defineSlots<{ default(props: { msg: string }): any, header(): any }>()
defineExpose({ focus: () => {}, blur: () => {} })
</script>`
    const r = parseComponentSource('/x/C.vue', sfc)
    expect(r.slots.sort()).toEqual(['default', 'header'])
    expect(r.exposes.sort()).toEqual(['blur', 'focus'])
  })

  it('marks props as unresolved when defineProps gets an imported type', () => {
    const sfc = `<script setup lang="ts">
import type { MyProps } from './types'
defineProps<MyProps>()
</script>`
    const r = parseComponentSource('/x/D.vue', sfc)
    expect(r.propsResolution).toBe('unresolved')
    expect(r.props).toEqual([])
  })

  it('extracts options-style defineComponent props/emits', () => {
    const tsFile = `import { defineComponent } from 'vue'
export default defineComponent({
  props: { size: { type: Number, required: true, default: 10 }, label: String },
  emits: ['click'],
})`
    const r = parseComponentSource('/x/E.ts', tsFile)
    expect(r.props.map(p => p.name).sort()).toEqual(['label', 'size'])
    const size = r.props.find(p => p.name === 'size')!
    expect(size.required).toBe(true)
    expect(size.hasDefault).toBe(true)
    expect(r.emits).toEqual(['click'])
  })

  it('propagates withDefaults to hasDefault', () => {
    const sfc = `<script setup lang="ts">
const props = withDefaults(defineProps<{ size?: number, label: string }>(), { size: 4 })
</script>`
    const r = parseComponentSource('/x/F.vue', sfc)
    const size = r.props.find(p => p.name === 'size')!
    expect(size.hasDefault).toBe(true)
    const label = r.props.find(p => p.name === 'label')!
    expect(label.hasDefault).toBeFalsy()
  })
})

describe('findComponentUsages', () => {
  it('finds PascalCase + kebab-case tag usages', () => {
    const fx = makeFixture({
      'pages/index.vue': `<template>
  <div>
    <MyButton label="A" />
    <my-button label="B" />
  </div>
</template>
`,
      'pages/other.vue': `<template><MyButton /></template>`,
    }, false)
    try {
      const hits = findComponentUsages(['MyButton'], { cwd: fx.dir })
      expect(hits).toHaveLength(3)
      expect(hits.filter(h => h.form === 'tag-pascal')).toHaveLength(2)
      expect(hits.filter(h => h.form === 'tag-kebab')).toHaveLength(1)
      expect(hits.every(h => h.name === 'MyButton')).toBe(true)
    }
    finally { fx.cleanup() }
  })

  it('finds resolveComponent string-literal usages in script + sfc', () => {
    const fx = makeFixture({
      'app/foo.ts': `import { resolveComponent } from 'vue'
const X = resolveComponent('MyButton')
`,
      'pages/y.vue': `<script setup>
import { resolveComponent } from 'vue'
const Y = resolveComponent('MyButton')
</script>
<template><div /></template>
`,
    }, false)
    try {
      const hits = findComponentUsages(['MyButton'], { cwd: fx.dir })
      const resolveHits = hits.filter(h => h.form === 'resolveComponent')
      expect(resolveHits).toHaveLength(2)
      expect(resolveHits.map(h => h.rel).sort()).toEqual(['app/foo.ts', 'pages/y.vue'])
    }
    finally { fx.cleanup() }
  })

  it('finds <component :is="\'Name\'"> literals and flags dynamic bindings', () => {
    const fx = makeFixture({
      'pages/a.vue': `<template>
  <component :is="'MyButton'" />
  <component is="MyButton" />
  <component :is="someRef" />
</template>
`,
    }, false)
    try {
      const hits = findComponentUsages(['MyButton'], { cwd: fx.dir })
      const literals = hits.filter(h => h.form === 'dynamic-is-literal')
      expect(literals).toHaveLength(2)
      const bindings = hits.filter(h => h.form === 'dynamic-is-binding')
      expect(bindings).toHaveLength(1)
      expect(bindings[0]!.binding).toBe('someRef')
    }
    finally { fx.cleanup() }
  })
})

describe('layered nuxt fixture', () => {
  it('lists components from manifest with layer shadowing', () => {
    const list = listComponents(LAYERED_FIXTURE, { warn: () => {} })
    const names = list.map(c => c.name).sort()
    expect(names).toContain('BaseButton')
    expect(names).toContain('Hero')
    expect(names).toContain('Card')

    const baseButton = list.find(c => c.name === 'BaseButton')!
    expect(baseButton.aliases).toContain('LazyBaseButton')
    expect(baseButton.aliases).toContain('base-button')
    expect(baseButton.rel).toContain('layers/base/components/BaseButton.vue')

    const heros = list.filter(c => c.name === 'Hero')
    expect(heros).toHaveLength(2)
    const shadowed = heros.find(c => c.shadowed)!
    expect(shadowed.rel).toContain('layers/marketing/components/Hero.vue')
    expect(shadowed.shadowedBy).toBeDefined()
  })

  it('finds BaseButton usages across all aliases', () => {
    const hits = findComponentUsages(['BaseButton', 'LazyBaseButton', 'base-button'], { cwd: LAYERED_FIXTURE })
    expect(hits.some(h => h.form === 'tag-pascal')).toBe(true)
    expect(hits.some(h => h.form === 'tag-kebab')).toBe(true)
    expect(hits.some(h => h.form === 'dynamic-is-literal')).toBe(true)
  })
})

describe('pathPrefix:true manifest (TODO.md bug)', () => {
  it('does not flag same-basename files with distinct registered names as duplicates', async () => {
    const fx = makeFixture({
      '.nuxt/components.d.ts': `declare module "vue" {
  export interface GlobalComponents {
    AdminFieldBadge: typeof import("../layers/admin/app/components/AdminFieldBadge.vue")["default"]
    AdminFieldsAdminFieldBadge: typeof import("../layers/admin/app/components/admin-fields/AdminFieldBadge.vue")["default"]
  }
}
export {}
`,
      'layers/admin/app/components/AdminFieldBadge.vue': '<template>flat</template>',
      'layers/admin/app/components/admin-fields/AdminFieldBadge.vue': '<template>nested</template>',
    }, false)
    try {
      const list = listComponents(fx.dir, { warn: () => {} })
      expect(list).toHaveLength(2)
      expect(list.every(c => c.source === 'manifest')).toBe(true)
      expect(list.every(c => !c.shadowed)).toBe(true)
      const names = list.map(c => c.name).sort()
      expect(names).toEqual(['AdminFieldBadge', 'AdminFieldsAdminFieldBadge'])
      const { buildComponentInventory } = await import('../packages/core/src/components.ts')
      const inv = await buildComponentInventory({ cwd: fx.dir })
      expect(inv.duplicates).toHaveLength(0)
    }
    finally { fx.cleanup() }
  })

  it('matches focused-view query by registered name when basenames collide', async () => {
    const fx = makeFixture({
      '.nuxt/components.d.ts': `declare module "vue" {
  export interface GlobalComponents {
    AdminFieldBadge: typeof import("../layers/admin/app/components/AdminFieldBadge.vue")["default"]
    AdminFieldsAdminFieldBadge: typeof import("../layers/admin/app/components/admin-fields/AdminFieldBadge.vue")["default"]
  }
}
export {}
`,
      'layers/admin/app/components/AdminFieldBadge.vue': '<template>flat</template>',
      'layers/admin/app/components/admin-fields/AdminFieldBadge.vue': '<template>nested</template>',
      'package.json': '{"private": true, "type": "module", "devDependencies": {"nuxt": "^4.0.0"}}',
    }, false)
    try {
      const { buildComponentDetail } = await import('../packages/core/src/components.ts')
      const detail = await buildComponentDetail('AdminFieldBadge', { cwd: fx.dir })
      expect(detail).not.toBeNull()
      expect(detail!.component.registeredName).toBe('AdminFieldBadge')
      expect(detail!.component.rel).toBe('layers/admin/app/components/AdminFieldBadge.vue')
    }
    finally { fx.cleanup() }
  })
})
