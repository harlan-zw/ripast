import type { ProfileEvent, ProfileSink } from 'ripide-api'
import type { BenchFixture } from './fixture.ts'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, platform, release } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { buildDeclarationTree, buildScanGraph, buildUnusedDeclarations, runMove, runRename, runRenameFile, scan } from 'ripide-api'
import { makeBenchFixture } from './fixture.ts'

interface BenchCase {
  name: string
  runs?: number
  profile?: boolean
  tsconfig?: string
  fn: (fixture: BenchFixture, profile?: ProfileSink) => void | Promise<void>
}

interface BenchResult {
  name: string
  runs: number
  medianMs: number
  minMs: number
  maxMs: number
  phases?: PhaseResult[]
}

interface PhaseResult {
  phase: string
  medianMs: number
  pct: number
}

const FILE_COUNT = Number(process.env.RIPIDE_BENCH_FILES ?? 500)
const IMPORTERS_PER_SYMBOL = Number(process.env.RIPIDE_BENCH_IMPORTERS ?? 160)
const RUNS = Number(process.env.RIPIDE_BENCH_RUNS ?? 5)
const SCAN_HITS_PER_SYMBOL = IMPORTERS_PER_SYMBOL * 2 + 1

const benches: BenchCase[] = [
  {
    name: 'unused exported',
    fn: async (fixture) => {
      const result = await buildUnusedDeclarations({ cwd: fixture.dir, exports: 'exported' })
      assertCount('unused exported declarations', result.files.reduce((count, file) => count + file.declarations.length, 0), FILE_COUNT * 3 + 2)
    },
  },
  {
    name: 'rename-file nested config verify',
    tsconfig: 'app/.nuxt/tsconfig.app.json',
    fn: async (fixture) => {
      const tsconfig = 'app/.nuxt/tsconfig.app.json'
      const result = await runRenameFile('src/hot.ts', 'src/renamed.ts', { cwd: fixture.dir, tsconfig })
      assertCount('rename-file changes', result.changes.length, IMPORTERS_PER_SYMBOL)
      assertCount('rename-file regressions', result.regressions.length, 0)
    },
  },
  {
    name: 'scan identifier',
    fn: (fixture) => {
      const hits = scan('hotSymbol', { cwd: fixture.dir })
      assertCount('scan identifier hits', hits.length, SCAN_HITS_PER_SYMBOL)
    },
  },
  {
    name: 'scan graph',
    fn: (fixture) => {
      const graph = buildScanGraph('hotSymbol', { cwd: fixture.dir })
      assertCount('scan graph nodes', graph.nodes.length, IMPORTERS_PER_SYMBOL + 1)
    },
  },
  {
    name: 'tree exported',
    fn: (fixture) => {
      const tree = buildDeclarationTree({ cwd: fixture.dir, exports: 'exported' })
      assertCount('tree files', tree.files.length, FILE_COUNT + 3)
    },
  },
  {
    name: 'rename no verify',
    profile: true,
    fn: async (fixture, profile) => {
      const result = await runRename('hotSymbol', 'hotSymbolRenamed', { cwd: fixture.dir, verify: false, vue: false, profile })
      assertCount('rename no verify changes', result.changes.length, IMPORTERS_PER_SYMBOL + 1)
    },
  },
  {
    name: 'rename verify',
    runs: Math.max(3, Math.min(RUNS, 5)),
    profile: true,
    fn: async (fixture, profile) => {
      const result = await runRename('hotSymbol', 'hotSymbolRenamed', { cwd: fixture.dir, verify: true, vue: false, profile })
      assertCount('rename verify changes', result.changes.length, IMPORTERS_PER_SYMBOL + 1)
      assertCount('rename verify regressions', result.regressions.length, 0)
    },
  },
  {
    name: 'move no verify',
    profile: true,
    fn: async (fixture, profile) => {
      const result = await runMove('movedSymbol', 'src/source.ts', 'src/target.ts', { cwd: fixture.dir, verify: false, vue: false, profile })
      assertCount('move no verify changes', result.changes.length, IMPORTERS_PER_SYMBOL + 2)
    },
  },
  {
    name: 'move verify',
    runs: Math.max(3, Math.min(RUNS, 5)),
    profile: true,
    fn: async (fixture, profile) => {
      const result = await runMove('movedSymbol', 'src/source.ts', 'src/target.ts', { cwd: fixture.dir, verify: true, vue: false, profile })
      assertCount('move verify changes', result.changes.length, IMPORTERS_PER_SYMBOL + 2)
      assertCount('move verify regressions', result.regressions.length, 0)
    },
  },
]

async function main(): Promise<void> {
  const fixture = makeBenchFixture({ files: FILE_COUNT, importersPerSymbol: IMPORTERS_PER_SYMBOL })
  try {
    console.log(`ripide bench: ${FILE_COUNT} files, ${IMPORTERS_PER_SYMBOL} importers/symbol, ${RUNS} runs`)
    console.log(`fixture: ${fixture.dir}`)
  }
  finally {
    fixture.cleanup()
  }

  const started = new Date().toISOString()
  const initialLoad = loadavg()
  const raw: { name: string, round: number, warmup: boolean, milliseconds: number, phases: ProfileEvent[] }[] = []
  const results: BenchResult[] = []
  for (const bench of benches) {
    raw.push({ name: bench.name, round: -1, warmup: true, milliseconds: await measure(bench), phases: [] })
    const times: number[] = []
    const profiles: ProfileEvent[][] = []
    const runs = bench.runs ?? RUNS
    for (let i = 0; i < runs; i++) {
      const events: ProfileEvent[] = []
      const profile = bench.profile ? (event: ProfileEvent) => events.push(event) : undefined
      const milliseconds = await measure(bench, profile)
      times.push(milliseconds)
      raw.push({ name: bench.name, round: i, warmup: false, milliseconds, phases: events })
      if (bench.profile)
        profiles.push(events)
    }
    results.push(summarize(bench.name, times, profiles))
  }

  if (process.env.RIPIDE_BENCH_OUT) {
    const root = process.cwd()
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
    const artifactPaths = ['bench/bench.ts', 'bench/fixture.ts', 'pnpm-lock.yaml', ...readdirSync(join(root, 'packages/core/dist')).filter(name => name.endsWith('.mjs')).map(name => `packages/core/dist/${name}`)]
    const report = { kind: 'warm-sdk-microbenchmark', started, completed: new Date().toISOString(), config: { files: FILE_COUNT, importers: IMPORTERS_PER_SYMBOL, requestedRuns: RUNS }, revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), trackedChanges: execFileSync('git', ['diff', '--name-only'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean), node: process.version, platform: platform(), kernel: release(), cpus: cpus().map(cpu => cpu.model), initialLoad, finalLoad: loadavg(), artifacts: artifactPaths.map(path => ({ path, sha256: hash(join(root, path)) })), raw, summaries: results, boundary: 'Fresh fixture creation and cleanup excluded. One warmup per case. SDK operation only. No writes, model, CLI startup, installation, or agent work.' }
    writeFileSync(resolve(process.env.RIPIDE_BENCH_OUT), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
  const nameWidth = Math.max(...results.map(r => r.name.length), 'case'.length)
  console.log('')
  console.log(`${pad('case', nameWidth)}  runs  median    min       max`)
  for (const result of results) {
    console.log(`${pad(result.name, nameWidth)}  ${String(result.runs).padStart(4)}  ${fmt(result.medianMs)}  ${fmt(result.minMs)}  ${fmt(result.maxMs)}`)
  }

  const profiled = results.filter(r => r.phases?.length)
  if (profiled.length) {
    console.log('')
    console.log('phase budget')
    for (const result of profiled) {
      console.log(`\n${result.name}`)
      for (const phase of result.phases!)
        console.log(`  ${pad(phase.phase, 22)} ${fmt(phase.medianMs)}  ${phase.pct.toFixed(1).padStart(5)}%`)
    }
  }
}

async function measure(bench: BenchCase, profile?: ProfileSink): Promise<number> {
  const fixture = makeBenchFixture({ files: FILE_COUNT, importersPerSymbol: IMPORTERS_PER_SYMBOL, tsconfig: bench.tsconfig })
  try {
    const start = performance.now()
    await bench.fn(fixture, profile)
    return performance.now() - start
  }
  finally {
    fixture.cleanup()
  }
}

function summarize(name: string, times: number[], profiles: ProfileEvent[][] = []): BenchResult {
  const sorted = [...times].sort((a, b) => a - b)
  const medianMs = sorted[Math.floor(sorted.length / 2)] ?? 0
  return {
    name,
    runs: times.length,
    medianMs,
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    phases: summarizePhases(profiles, medianMs),
  }
}

function summarizePhases(profiles: ProfileEvent[][], totalMs: number): PhaseResult[] | undefined {
  if (!profiles.length)
    return undefined
  const byPhase = new Map<string, number[]>()
  for (const events of profiles) {
    const totals = new Map<string, number>()
    for (const event of events)
      totals.set(event.phase, (totals.get(event.phase) ?? 0) + event.ms)
    for (const [phase, ms] of totals)
      byPhase.set(phase, [...(byPhase.get(phase) ?? []), ms])
  }
  return [...byPhase.entries()]
    .map(([phase, values]) => {
      const medianMs = median(values)
      return { phase, medianMs, pct: totalMs > 0 ? (medianMs / totalMs) * 100 : 0 }
    })
    .filter(phase => phase.medianMs >= 0.1)
    .sort((a, b) => b.medianMs - a.medianMs)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function assertCount(label: string, actual: number, expected: number): void {
  if (actual !== expected)
    throw new Error(`${label}: expected ${expected}, got ${actual}`)
}

function pad(value: string, width: number): string {
  return value.padEnd(width)
}

function fmt(ms: number): string {
  return `${ms.toFixed(1).padStart(7)}ms`
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
