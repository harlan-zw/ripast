import type { ComponentInfo, ComponentUsageInfo, FrameworkAdapter } from './adapter.ts'
import type { EngineServices } from './engine.ts'
import type { OutputSelection } from './output.ts'
import { isAbsolute, relative, sep } from 'node:path'
import process from 'node:process'
import { formatOutputPage, selectOutput } from './output.ts'

export interface ComponentsListOptions {
  engine?: EngineServices
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

export async function loadComponentsAdapter(engine?: EngineServices): Promise<FrameworkAdapter | null> {
  return engine?.adapter ?? null
}

export async function buildComponentInventory(opts: ComponentsListOptions = {}): Promise<ComponentInventory> {
  const cwd = opts.cwd ?? process.cwd()
  const adapter = await loadComponentsAdapter(opts.engine)
  if (!adapter)
    return { components: [], duplicates: [], shadowed: [] }
  const components = adapter.listComponents!(cwd, { glob: opts.glob, source: opts.source, warn: opts.warn })
  const duplicates = groupDuplicates(components)
  const shadowed = components.filter(c => c.shadowed)
  return { components, duplicates, shadowed }
}

export async function buildComponentDetail(name: string, opts: ComponentsListOptions = {}): Promise<ComponentDetail | null> {
  const cwd = opts.cwd ?? process.cwd()
  const adapter = await loadComponentsAdapter(opts.engine)
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

export function formatInventory(inv: ComponentInventory): string {
  const lines: string[] = []
  lines.push(`${inv.components.length} component${inv.components.length === 1 ? '' : 's'}`)
  if (inv.duplicates.length)
    lines.push(`${inv.duplicates.length} duplicate-name group${inv.duplicates.length === 1 ? '' : 's'}`)
  if (inv.shadowed.length)
    lines.push(`${inv.shadowed.length} shadowed`)
  lines.push('')
  for (const c of inv.components) {
    const marker = c.shadowed ? ' (shadowed)' : ''
    const src = c.source === 'manifest' ? 'm' : 'f'
    const reg = c.registeredName && c.registeredName !== c.name ? ` registered: ${c.registeredName}` : ''
    lines.push(`  [${src}] ${c.name.padEnd(28)} ${c.rel}${marker}${reg}`)
  }
  if (inv.duplicates.length) {
    lines.push('')
    lines.push('duplicates:')
    for (const dup of inv.duplicates) {
      lines.push(`  ${dup.name}`)
      for (const entry of dup.entries) {
        const marker = entry.shadowed ? ' (shadowed)' : ''
        lines.push(`    ${entry.rel}${marker}`)
      }
    }
  }
  return lines.join('\n')
}

export function formatAgentInventory(inv: ComponentInventory, options: OutputSelection = { limit: 40 }): string {
  const page = selectOutput(inv.components, options, component => component.rel)
  const lines = ['components', formatOutputPage(page)]
  for (const component of page.results)
    lines.push(`  ${component.name} ${component.rel}${component.shadowed ? ' (shadowed)' : ''}`)
  lines.push(`total: ${inv.components.length}, duplicates: ${inv.duplicates.length}, shadowed: ${inv.shadowed.length}`)
  if (inv.duplicates.length) {
    lines.push(`duplicates: ${formatOutputPage(selectOutput(inv.duplicates, options))}`)
    for (const dup of selectOutput(inv.duplicates, options).results)
      lines.push(`  ${dup.name}: ${`${selectOutput(dup.entries, { limit: options.limit ?? 40 }).results.map(e => `${e.rel}${e.shadowed ? '*' : ''}`).join(', ')}; entries: ${formatOutputPage(selectOutput(dup.entries, { limit: options.limit ?? 40 }))}`}`)
  }
  if (inv.shadowed.length) {
    lines.push(`shadowed: ${formatOutputPage(selectOutput(inv.shadowed, options))}`)
    for (const s of selectOutput(inv.shadowed, options, component => component.rel).results)
      lines.push(`  ${s.rel} -> ${s.shadowedBy ? relativeToCwd(s.shadowedBy) : '?'}`)
  }
  return lines.join('\n')
}

function relativeToCwd(abs: string): string {
  const cwd = process.cwd()
  const rel = relative(cwd, abs)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? rel : abs
}

export function formatDetail(detail: ComponentDetail, options: OutputSelection = { limit: 50 }): string {
  const page = selectOutput(detail.usages, options, usage => usage.rel)
  const lines: string[] = []
  const c = detail.component
  lines.push(`${c.name}${c.shadowed ? ' (shadowed)' : ''}`)
  lines.push(`  file: ${c.rel}`)
  if (c.aliases.length)
    lines.push(`  aliases: ${c.aliases.join(', ')}`)
  lines.push(`  source: ${c.source}, scope: ${c.scope}`)
  if (detail.candidates.length > 1) {
    lines.push(`  other candidates with same name:`)
    const candidates = selectOutput(detail.candidates, options, candidate => candidate.rel)
    lines.push(`  candidates: ${formatOutputPage(candidates)}`)
    for (const cand of candidates.results) {
      if (cand.id === c.id)
        continue
      lines.push(`    ${cand.rel}${cand.shadowed ? ' (shadowed)' : ''}`)
    }
  }
  lines.push('')
  const byForm = new Map<string, number>()
  for (const u of detail.usages) byForm.set(u.form, (byForm.get(u.form) ?? 0) + 1)
  lines.push(`usages: ${detail.usages.length}`)
  for (const [form, n] of [...byForm.entries()].sort((a, b) => b[1] - a[1]))
    lines.push(`  ${form.padEnd(20)} ${n}`)
  if (detail.usages.length) {
    lines.push('')
    for (const u of page.results)
      lines.push(`  ${u.rel}:${u.line}:${u.col}  ${u.form}${u.binding ? `  ${u.binding}` : ''}`)
    lines.push(formatOutputPage(page))
    if (page.omitted)
      lines.push('Retrieve more with --offset, --limit, or --file.')
  }
  return lines.join('\n')
}
