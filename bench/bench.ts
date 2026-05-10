import type { ProfileEvent, ProfileSink } from '../src/index.ts'
import { performance } from 'node:perf_hooks'
import { buildDeclarationTree, buildScanGraph, runMove, runRename, scan } from '../src/index.ts'
import { makeBenchFixture } from './fixture.ts'

interface BenchCase {
  name: string
  runs?: number
  profile?: boolean
  fn: (profile?: ProfileSink) => void | Promise<void>
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

const FILE_COUNT = Number(process.env.RIPAST_BENCH_FILES ?? 500)
const IMPORTERS_PER_SYMBOL = Number(process.env.RIPAST_BENCH_IMPORTERS ?? 160)
const RUNS = Number(process.env.RIPAST_BENCH_RUNS ?? 5)
const SCAN_HITS_PER_SYMBOL = IMPORTERS_PER_SYMBOL * 2 + 1

const benches: BenchCase[] = [
  {
    name: 'scan identifier',
    fn: () => {
      const fixture = makeBenchFixture({ files: FILE_COUNT, importersPerSymbol: IMPORTERS_PER_SYMBOL })
      try {
        const hits = scan('hotSymbol', { cwd: fixture.dir })
        assertCount('scan identifier hits', hits.length, SCAN_HITS_PER_SYMBOL)
      }
      finally {
        fixture.cleanup()
      }
    },
  },
  {
    name: 'scan graph',
    fn: () => {
      const fixture = makeBenchFixture({ files: FILE_COUNT, importersPerSymbol: IMPORTERS_PER_SYMBOL })
      try {
        const graph = buildScanGraph('hotSymbol', { cwd: fixture.dir })
        assertCount('scan graph nodes', graph.nodes.length, IMPORTERS_PER_SYMBOL + 1)
      }
      finally {
        fixture.cleanup()
      }
    },
  },
  {
    name: 'tree exported',
    fn: () => {
      const fixture = makeBenchFixture({ files: FILE_COUNT, importersPerSymbol: IMPORTERS_PER_SYMBOL })
      try {
        const tree = buildDeclarationTree({ cwd: fixture.dir, exports: 'exported' })
        assertCount('tree files', tree.files.length, FILE_COUNT + 3)
      }
      finally {
        fixture.cleanup()
      }
    },
  },
  {
    name: 'rename no verify',
    profile: true,
    fn: async (profile) => {
      const fixture = makeBenchFixture({ files: FILE_COUNT, importersPerSymbol: IMPORTERS_PER_SYMBOL })
      try {
        const result = await runRename('hotSymbol', 'hotSymbolRenamed', { cwd: fixture.dir, verify: false, vue: false, profile })
        assertCount('rename no verify changes', result.changes.length, IMPORTERS_PER_SYMBOL + 1)
      }
      finally {
        fixture.cleanup()
      }
    },
  },
  {
    name: 'rename verify',
    runs: Math.max(3, Math.min(RUNS, 5)),
    profile: true,
    fn: async (profile) => {
      const fixture = makeBenchFixture({ files: FILE_COUNT, importersPerSymbol: IMPORTERS_PER_SYMBOL })
      try {
        const result = await runRename('hotSymbol', 'hotSymbolRenamed', { cwd: fixture.dir, verify: true, vue: false, profile })
        assertCount('rename verify changes', result.changes.length, IMPORTERS_PER_SYMBOL + 1)
        assertCount('rename verify regressions', result.regressions.length, 0)
      }
      finally {
        fixture.cleanup()
      }
    },
  },
  {
    name: 'move no verify',
    profile: true,
    fn: async (profile) => {
      const fixture = makeBenchFixture({ files: FILE_COUNT, importersPerSymbol: IMPORTERS_PER_SYMBOL })
      try {
        const result = await runMove('movedSymbol', 'src/source.ts', 'src/target.ts', { cwd: fixture.dir, verify: false, vue: false, profile })
        assertCount('move no verify changes', result.changes.length, IMPORTERS_PER_SYMBOL + 2)
      }
      finally {
        fixture.cleanup()
      }
    },
  },
  {
    name: 'move verify',
    runs: Math.max(3, Math.min(RUNS, 5)),
    profile: true,
    fn: async (profile) => {
      const fixture = makeBenchFixture({ files: FILE_COUNT, importersPerSymbol: IMPORTERS_PER_SYMBOL })
      try {
        const result = await runMove('movedSymbol', 'src/source.ts', 'src/target.ts', { cwd: fixture.dir, verify: true, vue: false, profile })
        assertCount('move verify changes', result.changes.length, IMPORTERS_PER_SYMBOL + 2)
        assertCount('move verify regressions', result.regressions.length, 0)
      }
      finally {
        fixture.cleanup()
      }
    },
  },
]

async function main(): Promise<void> {
  const fixture = makeBenchFixture({ files: FILE_COUNT, importersPerSymbol: IMPORTERS_PER_SYMBOL })
  try {
    console.log(`ripast bench: ${FILE_COUNT} files, ${IMPORTERS_PER_SYMBOL} importers/symbol, ${RUNS} runs`)
    console.log(`fixture: ${fixture.dir}`)
  }
  finally {
    fixture.cleanup()
  }

  const results: BenchResult[] = []
  for (const bench of benches) {
    await bench.fn()
    const times: number[] = []
    const profiles: ProfileEvent[][] = []
    const runs = bench.runs ?? RUNS
    for (let i = 0; i < runs; i++) {
      const events: ProfileEvent[] = []
      const profile = bench.profile ? (event: ProfileEvent) => events.push(event) : undefined
      const start = performance.now()
      await bench.fn(profile)
      times.push(performance.now() - start)
      if (bench.profile)
        profiles.push(events)
    }
    results.push(summarize(bench.name, times, profiles))
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
