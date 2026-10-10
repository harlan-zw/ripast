import type { Manifest, Result } from './manifest.ts'
import type { AttemptMetric } from './report.ts'
import { median } from './report.ts'

export interface CheckCommand {
  name: string
  args: string[]
  exit: number | null
  assertionHash: string | null
  stdoutBytes: number
  stderrBytes: number
}

export function summarizeCheckCommands(commands: CheckCommand[]) {
  const hashes = commands.flatMap(command => command.assertionHash ? [command.assertionHash] : [])
  const evidence = (color: string) => commands.filter(command => command.args.some(arg => arg.endsWith(`.checks/${color}.json`))).at(-1)
  const method = (evidence('green') ?? evidence('red'))?.name
  return {
    invocations: commands.length,
    failedExecutions: commands.filter(command => command.exit !== 0).length,
    assertionVersions: new Set(hashes).size,
    toolOutputBytes: commands.reduce((sum, command) => sum + command.stdoutBytes + command.stderrBytes, 0),
    workflow: method === 'ripide' || method === 'vitest' ? method : 'unavailable',
  }
}

export function compareCheckStudies(baseline: Manifest, candidate: Manifest, baselineRows: AttemptMetric[], candidateRows: AttemptMetric[]): Result<{
  comparisons: { mode: string, task: string, completedPairs: number, baselinePassed: number, candidatePassed: number, medianPreparedSecondsChange: number | null, medianArmSecondsChange: number | null, medianUncachedInputChange: number | null, medianOutputChange: number | null }[]
  decision: 'Reject' | 'Investigate'
  reason: string
}> {
  const provenance = (manifest: Manifest) => manifest.artifacts.find(artifact => artifact.path.endsWith('/source-provenance.json'))?.path
  const normalizeCommand = (command: string[]) => command.map((arg, index) => index === 9 && command[1]?.endsWith('/check-runner.ts') ? '<variant>' : arg)
  const normalized = (manifest: Manifest) => {
    const encoded = JSON.stringify({ tasks: manifest.tasks.map(task => ({ ...task, setup: task.setup.map(stage => ({ ...stage, command: normalizeCommand(stage.command) })) })), commonInstructions: manifest.commonInstructions, seed: manifest.seed, repeats: manifest.repeats, cache: manifest.cache, timeoutMs: manifest.timeoutMs, timeoutPolicy: manifest.timeoutPolicy, repairs: manifest.repairs, tracing: manifest.tracing, versions: manifest.versions, runners: Object.fromEntries(Object.entries(manifest.runners).map(([mode, runner]) => [mode, { ...runner, command: normalizeCommand(runner.command) }])), artifacts: manifest.artifacts.map(artifact => ({ ...artifact, path: artifact.path === provenance(manifest) ? '<provenance>' : artifact.path })).sort((a, b) => a.path.localeCompare(b.path)) })
    const path = provenance(manifest)
    return path ? encoded.replaceAll(path, '<provenance>') : encoded
  }
  if (normalized(baseline) !== normalized(candidate))
    return { _tag: 'Err', message: 'Inputs, runtime artifacts, model, oracle, schedule, or budgets differ. Register a controlled comparison.' }
  for (const [label, input] of [['Baseline', baselineRows], ['Candidate', candidateRows]] as const) {
    if (input.some(row => !baseline.tasks.some(task => task.id === row.task)
      || !['direct', 'forced', 'hybrid'].includes(row.mode)
      || !Number.isSafeInteger(row.repeat) || row.repeat < 0 || row.repeat >= baseline.repeats
      || !Number.isSafeInteger(row.attempt) || row.attempt < 0 || row.attempt > baseline.repairs)) {
      return { _tag: 'Err', message: `${label} contains an unregistered task, mode, repeat, or repair attempt.` }
    }
    for (const task of baseline.tasks) {
      for (const mode of ['direct', 'forced', 'hybrid']) {
        for (let repeat = 0; repeat < baseline.repeats; repeat++) {
          const rows = input.filter(row => row.task === task.id && row.mode === mode && row.repeat === repeat).sort((a, b) => a.attempt - b.attempt)
          if (!rows.length || rows.some((row, index) => row.attempt !== index))
            return { _tag: 'Err', message: `${label} needs complete, unique, consecutive attempts for ${task.id}/${mode}/${repeat}.` }
        }
      }
    }
  }
  const comparisons = baseline.tasks.flatMap(task => ['direct', 'forced', 'hybrid'].map((mode) => {
    const rows = (input: AttemptMetric[]) => input.filter(row => row.task === task.id && row.mode === mode).sort((a, b) => a.attempt - b.attempt)
    const before = rows(baselineRows)
    const after = rows(candidateRows)
    const pairs = Array.from({ length: baseline.repeats }, (_, repeat) => ({ before: before.filter(row => row.repeat === repeat), after: after.filter(row => row.repeat === repeat) }))
    const sum = (input: AttemptMetric[], field: 'uncachedInput' | 'output') => input.every(row => row.usage._tag === 'Recorded') ? input.reduce((sum, row) => sum + (row.usage._tag === 'Recorded' ? row.usage.value.tokens[field] : 0), 0) : null
    const tokenDelta = (field: 'uncachedInput' | 'output') => {
      const deltas = pairs.flatMap((pair) => {
        const a = sum(pair.before, field)
        const b = sum(pair.after, field)
        return a !== null && b !== null ? [b - a] : []
      })
      return deltas.length === pairs.length && deltas.length ? median(deltas) : null
    }
    return {
      mode,
      task: task.id,
      completedPairs: pairs.length,
      baselinePassed: pairs.filter(pair => pair.before.at(-1)!.quality === 'passed').length,
      candidatePassed: pairs.filter(pair => pair.after.at(-1)!.quality === 'passed').length,
      medianPreparedSecondsChange: pairs.length ? median(pairs.map(pair => pair.after.reduce((sum, row) => sum + (row.preparedSeconds ?? row.seconds), 0) - pair.before.reduce((sum, row) => sum + (row.preparedSeconds ?? row.seconds), 0))) : null,
      medianArmSecondsChange: pairs.length && pairs.every(pair => [...pair.before, ...pair.after].every(row => row.armSeconds !== undefined)) ? median(pairs.map(pair => pair.after.reduce((sum, row) => sum + row.armSeconds!, 0) - pair.before.reduce((sum, row) => sum + row.armSeconds!, 0))) : null,
      medianUncachedInputChange: tokenDelta('uncachedInput'),
      medianOutputChange: tokenDelta('output'),
    }
  }))
  const regression = comparisons.some(row => row.candidatePassed < row.baselinePassed)
  return { _tag: 'Ok', value: { comparisons, decision: regression ? 'Reject' : 'Investigate', reason: regression ? 'The candidate lost independently verified workflows. Resource savings cannot justify this change.' : 'Inspect paired costs and failure traces. Pilot repeats and uncontrolled provider caches cannot prove general savings.' } }
}
