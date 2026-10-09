import type { ComponentInfo, ComponentUsageInfo } from './adapter.ts'
import process from 'node:process'
import { detectFrameworks, loadAdapter } from './adapter.ts'

export interface ComponentsListOptions {
  cwd?: string
  glob?: string[]
  source?: 'auto' | 'manifest' | 'filesystem'
  warn?: (msg: string) => void
}

export interface ComponentInventory {
  components: ComponentInfo[]
  duplicates: DuplicateGroup[]
  shadowed: ComponentInfo[]
}

export interface DuplicateGroup {
  name: string
  entries: ComponentInfo[]
}

export interface ComponentDetail {
  component: ComponentInfo
  candidates: ComponentInfo[]
  usages: ComponentUsageInfo[]
}

export async function loadVueComponentsAdapter(cwd?: string): Promise<{
  listComponents: NonNullable<Awaited<ReturnType<typeof loadAdapter>>>['listComponents']
  findComponentUsages: NonNullable<Awaited<ReturnType<typeof loadAdapter>>>['findComponentUsages']
} | null> {
  const frameworks = detectFrameworks(cwd ?? process.cwd())
  const name = frameworks.includes('nuxt') ? 'nuxt' : frameworks.includes('vue') ? 'vue' : null
  if (!name)
    return null
  const adapter = await loadAdapter(name)
  if (!adapter?.listComponents || !adapter?.findComponentUsages)
    return null
  return { listComponents: adapter.listComponents, findComponentUsages: adapter.findComponentUsages }
}

export async function buildComponentInventory(opts: ComponentsListOptions = {}): Promise<ComponentInventory> {
  const cwd = opts.cwd ?? process.cwd()
  const adapter = await loadVueComponentsAdapter(cwd)
  if (!adapter)
    return { components: [], duplicates: [], shadowed: [] }
  const components = adapter.listComponents!(cwd, { glob: opts.glob, source: opts.source, warn: opts.warn })
  const duplicates = groupDuplicates(components)
  const shadowed = components.filter(c => c.shadowed)
  return { components, duplicates, shadowed }
}

export async function buildComponentDetail(name: string, opts: ComponentsListOptions = {}): Promise<ComponentDetail | null> {
  const cwd = opts.cwd ?? process.cwd()
  const adapter = await loadVueComponentsAdapter(cwd)
  if (!adapter)
    return null
  const components = adapter.listComponents!(cwd, { glob: opts.glob, source: opts.source, warn: opts.warn })
  // Match by registered name first (manifest source of truth), then by canonical name, then by alias.
  const matches = components.filter(c => c.registeredName === name || c.name === name || c.aliases.includes(name))
  if (!matches.length)
    return null
  const registered = matches.find(c => c.registeredName === name && c.source === 'manifest')
  const winners = matches.filter(c => !c.shadowed)
  const component = registered ?? winners.find(c => c.source === 'manifest') ?? winners[0] ?? matches[0]!
  const aliases = unique([component.name, ...component.aliases])
  const usages = adapter.findComponentUsages!(aliases, { cwd })
  return { component, candidates: matches, usages }
}

function groupDuplicates(components: ComponentInfo[]): DuplicateGroup[] {
  // Group by registered name when present (manifest source); otherwise by canonical name.
  // This avoids false positives when Nuxt's pathPrefix:true gives nested files distinct
  // registered names that happen to share a basename.
  const byKey = new Map<string, ComponentInfo[]>()
  for (const c of components) {
    const key = c.registeredName ?? c.name
    const list = byKey.get(key) ?? []
    list.push(c)
    byKey.set(key, list)
  }
  const out: DuplicateGroup[] = []
  for (const [name, entries] of byKey) {
    if (entries.length < 2)
      continue
    out.push({ name, entries: entries.sort((a, b) => Number(a.shadowed) - Number(b.shadowed) || a.rel.localeCompare(b.rel)) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)]
}
