import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'

export type Result<T> = {
  _tag: 'Ok'
  value: T
} | {
  _tag: 'Err'
  message: string
}
export type Mode = 'direct' | 'forced' | 'hybrid'
export type Cohort = 'mechanical' | 'architecture' | 'mixed'
export type Phase = 'setup' | 'discovery' | 'architecture' | 'mechanical' | 'verification' | 'implementation' | 'commit' | 'publication'
export interface Command {
  command: string[]
  phase: Phase
  role: 'arm' | 'controller'
}
export interface SymbolSite {
  file: string
  name: string
  occurrence: number
}
export interface SymbolAssertion {
  declaration: SymbolSite
  references: SymbolSite[]
}
export interface Task {
  id: string
  cohort: Cohort
  operation: string
  prompt: string
  source: {
    _tag: 'Files'
    files: Record<string, string>
  } | {
    _tag: 'Git'
    repository: string
    commit: string
  }
  expected: Record<string, string | null>
  generatedDirectories: string[]
  setup: Command[]
  checks: Command[]
  symbols: SymbolAssertion[]
  qualityGates: {
    id: string
    command: string[]
    required: boolean
  }[]
}
export interface Manifest {
  id: string
  study: 'pilot' | 'held-out'
  pilotHash: string | null
  seed: number
  repeats: number
  cache: 'cold' | 'warm' | 'uncontrolled'
  timeoutMs: number
  repairs: number
  tracing: 'strace' | 'top-level'
  commonInstructions: string
  runners: Record<Mode, {
    model: string
    reasoning: string
    command: string[]
  }>
  artifacts: {
    path: string
    sha256: string
  }[]
  versions: string[][]
  usageImports: {
    path: string
    cutoff: string
    role: 'arm' | 'controller'
    phase: Phase
    task: string
    mode: Mode
    repeat: number
    attempt: number
  }[]
  tasks: Task[]
  endpoint: 'delivery-completed'
  usageBoundary: 'complete-responses-through-command-close'
}
const modes: Mode[] = ['direct', 'forced', 'hybrid']
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object.')
  return value as Record<string, unknown>
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim())
    throw new Error('Expected non-empty text.')
  return value
}
function integer(value: unknown, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new Error('Expected a valid integer.')
  return value
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value))
    throw new Error('Expected an array.')
  return value
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T))
    throw new Error(`Expected one of: ${choices.join(', ')}.`)
  return value as T
}
export function projectPath(value: unknown): string {
  const path = text(value)
  if (isAbsolute(path) || path.includes('\\') || normalize(path).startsWith('..') || path.split('/').includes('..') || path === '.')
    throw new Error('Project paths must stay inside the project.')
  return path
}
function files(value: unknown, nullable: boolean): Record<string, string | null> {
  return Object.fromEntries(Object.entries(object(value)).map(([path, content]) => {
    if (typeof content !== 'string' && !(nullable && content === null))
      throw new Error('Expected file content.')
    return [projectPath(path), content as string | null]
  }))
}
function command(value: unknown): string[] {
  const result = array(value).map(text)
  if (!result.length)
    throw new Error('Command is empty.')
  return result
}
function phaseCommands(value: unknown): Command[] {
  return array(value).map((raw) => {
    const row = object(raw)
    return { command: command(row.command), phase: choice(row.phase, ['setup', 'discovery', 'architecture', 'mechanical', 'verification', 'implementation', 'commit', 'publication']), role: choice(row.role, ['arm', 'controller']) }
  })
}
function site(raw: unknown): SymbolSite {
  const row = object(raw)
  return { file: projectPath(row.file), name: text(row.name), occurrence: integer(row.occurrence ?? 0) }
}
function task(raw: unknown): Task {
  const row = object(raw)
  const source = object(row.source)
  const parsedSource: Task['source'] = source.files
    ? { _tag: 'Files', files: files(source.files, false) as Record<string, string> }
    : { _tag: 'Git', repository: text(source.repository), commit: text(source.commit) }
  if (parsedSource._tag === 'Git' && !/^[a-f\d]{40}$/.test(parsedSource.commit))
    throw new Error('Freeze a complete Git commit.')
  return {
    id: projectPath(row.id),
    cohort: choice(row.cohort, ['mechanical', 'architecture', 'mixed']),
    operation: text(row.operation),
    prompt: text(row.prompt),
    source: parsedSource,
    expected: files(row.expected, true),
    generatedDirectories: array(row.generatedDirectories).map(projectPath),
    setup: phaseCommands(row.setup),
    checks: phaseCommands(row.checks),
    symbols: array(row.symbols).map((raw) => {
      const s = object(raw)
      return { declaration: site(s.declaration), references: array(s.references).map(site) }
    }),
    qualityGates: array(row.qualityGates).map((raw) => {
      const g = object(raw)
      if (typeof g.required !== 'boolean')
        throw new Error('Declare whether a quality gate is required.')
      return { id: text(g.id), command: command(g.command), required: g.required }
    }),
  }
}
export function parseManifest(raw: unknown): Result<Manifest> {
  try {
    const row = object(raw)
    const runners = object(row.runners)
    const value: Manifest = {
      id: projectPath(row.id),
      study: choice(row.study, ['pilot', 'held-out']),
      pilotHash: row.pilotHash === null ? null : text(row.pilotHash),
      seed: integer(row.seed),
      repeats: integer(row.repeats, 1),
      cache: choice(row.cache, ['cold', 'warm', 'uncontrolled']),
      timeoutMs: integer(row.timeoutMs, 1),
      repairs: integer(row.repairs),
      tracing: choice(row.tracing, ['strace', 'top-level']),
      commonInstructions: text(row.commonInstructions),
      runners: Object.fromEntries(modes.map((mode) => {
        const r = object(runners[mode])
        const cmd = command(r.command)
        if (!cmd.length)
          throw new Error('Runner command is empty.')
        return [mode, { model: text(r.model), reasoning: text(r.reasoning), command: cmd }]
      })) as Manifest['runners'],
      artifacts: array(row.artifacts).map((raw) => {
        const a = object(raw)
        const sha256 = text(a.sha256)
        if (!/^[a-f\d]{64}$/.test(sha256))
          throw new Error('Freeze artifact SHA-256.')
        return { path: text(a.path), sha256 }
      }),
      versions: array(row.versions).map(command),
      usageImports: array(row.usageImports ?? []).map((raw) => {
        const source = object(raw)
        const cutoff = text(source.cutoff)
        if (!Number.isFinite(Date.parse(cutoff)))
          throw new Error('Usage import cutoff must be valid.')
        return { path: text(source.path), cutoff, role: choice(source.role, ['arm', 'controller']), phase: choice(source.phase, ['setup', 'discovery', 'architecture', 'mechanical', 'verification', 'implementation', 'commit', 'publication']), task: text(source.task), mode: choice(source.mode, modes), repeat: integer(source.repeat), attempt: integer(source.attempt) }
      }),
      tasks: array(row.tasks).map(task),
      endpoint: 'delivery-completed',
      usageBoundary: 'complete-responses-through-command-close',
    }
    if (!value.tasks.length || new Set(value.tasks.map(t => t.id)).size !== value.tasks.length)
      throw new Error('Tasks must have unique IDs.')
    if (value.usageImports.some(source => !value.artifacts.some(artifact => artifact.path === source.path)))
      throw new Error('Pin every imported usage artifact.')
    const importedHashes = value.usageImports.map(source => value.artifacts.find(artifact => artifact.path === source.path)!.sha256)
    if (new Set(importedHashes).size !== importedHashes.length)
      throw new Error('Each imported usage artifact must have one owner.')
    if (row.endpoint !== undefined && row.endpoint !== value.endpoint)
      throw new Error('Delivery must use the registered complete endpoint.')
    if (row.usageBoundary !== undefined && row.usageBoundary !== value.usageBoundary)
      throw new Error('Usage must use complete responses through command close.')
    if (value.study === 'held-out' && (!value.pilotHash || !/^[a-f\d]{64}$/.test(value.pilotHash) || value.repeats % 6 || value.tracing !== 'strace' || !value.artifacts.length))
      throw new Error('Held-out studies require a pilot hash, pinned artifacts, child tracing, and repeats divisible by six.')
    if (value.study === 'held-out' && value.tasks.some(task => !task.checks.length || !task.qualityGates.some(gate => gate.required)))
      throw new Error('Held-out tasks require independent checks and a required common quality gate.')
    if (value.study === 'held-out' && !value.artifacts.some(artifact => artifact.sha256 === value.pilotHash))
      throw new Error('Pin the reviewed pilot analysis artifact before a held-out study.')
    if (value.study === 'held-out' && (new Set(modes.map(mode => value.runners[mode].model)).size !== 1 || new Set(modes.map(mode => value.runners[mode].reasoning)).size !== 1))
      throw new Error('Use the same model and reasoning within each held-out study.')
    return { _tag: 'Ok', value }
  }
  catch (error) {
    return { _tag: 'Err', message: (error as Error).message }
  }
}
export function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value))
    return value.map(canonical)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)]))
  return value
}
function freezeRuntime(value: unknown): void {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value))
      freezeRuntime(child)
    Object.freeze(value)
  }
}
export function freezeManifest(manifest: Manifest, directory: string): {
  path: string
  hash: string
} {
  freezeRuntime(manifest)
  const encoded = `${JSON.stringify(canonical(manifest), null, 2)}\n`
  const path = join(directory, 'manifest.json')
  writeFileSync(path, encoded, { flag: 'wx', mode: 0o400 })
  chmodSync(path, 0o400)
  const hash = sha256(encoded)
  writeFileSync(join(directory, 'manifest.sha256'), `${hash}\n`, { flag: 'wx', mode: 0o400 })
  return Object.freeze({ path, hash })
}
export function verifyFrozenManifest(frozen: {
  path: string
  hash: string
}): Result<true> {
  if (sha256(readFileSync(frozen.path)) !== frozen.hash)
    return { _tag: 'Err', message: 'The preregistered manifest changed.' }
  return { _tag: 'Ok', value: true }
}
export function verifyArtifacts(manifest: Manifest): Result<true> {
  for (const artifact of manifest.artifacts) {
    if (sha256(readFileSync(artifact.path)) !== artifact.sha256)
      return { _tag: 'Err', message: `Pinned artifact changed: ${artifact.path}` }
  }
  return { _tag: 'Ok', value: true }
}
export function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 4294967296
  }
}
export function buildSchedule(manifest: Manifest): {
  task: string
  mode: Mode
  repeat: number
  position: number
}[] {
  const rng = random(manifest.seed)
  const orders: Mode[][] = [['direct', 'forced', 'hybrid'], ['forced', 'hybrid', 'direct'], ['hybrid', 'direct', 'forced'], ['hybrid', 'forced', 'direct'], ['forced', 'direct', 'hybrid'], ['direct', 'hybrid', 'forced']]
  const shuffled = <T>(items: T[]): T[] => {
    const next = [...items]
    for (let i = next.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [next[i], next[j]] = [next[j], next[i]]
    }
    ;
    return next
  }
  const result: {
    task: string
    mode: Mode
    repeat: number
    position: number
  }[] = []
  const offsets = new Map(manifest.tasks.map(t => [t.id, Math.floor(rng() * 6)]))
  for (let repeat = 0; repeat < manifest.repeats; repeat++) {
    for (const task of shuffled(manifest.tasks)) {
      for (const [position, mode] of orders[(repeat + offsets.get(task.id)!) % 6].entries())
        result.push({ task: task.id, mode, repeat, position })
    }
  }
  return result
}
