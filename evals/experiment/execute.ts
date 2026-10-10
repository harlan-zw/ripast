import type { Manifest, Mode, Task } from './manifest.ts'
import type { RecordedCommand } from './recorder.ts'
import type { AttemptMetric } from './report.ts'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { expectedProject, gradeProject, snapshotProject } from './grading.ts'
import { buildSchedule, freezeManifest, sha256, verifyArtifacts, verifyFrozenManifest } from './manifest.ts'
import { archiveMessage, commandSucceeded, recordCommand } from './recorder.ts'
import { aggregateAttempts, combineUsage, pairAttempts, parseUsage, reportMarkdown } from './report.ts'

const treatment: Record<Mode, string> = {
  direct: 'Use ordinary read, edit, and shell tools. Do not use a refactoring CLI.',
  forced: 'Use the pinned refactoring tool for supported mechanical transformations. Use direct edits for unsupported design work.',
  hybrid: 'Choose the pinned refactoring tool when its supported operation matches the mechanical task. Otherwise use direct edits.',
}
function commandCompleted(record: RecordedCommand): boolean {
  return record.childLifecycle._tag === 'ProvenComplete' && record.exit._tag === 'Exited'
}
export async function executeExperiment(manifest: Manifest, directory: string, options: {
  allowModelCalls: boolean
} = { allowModelCalls: false }) {
  if (!options.allowModelCalls && Object.values(manifest.runners).some(r => r.model !== 'scripted'))
    throw new Error('Model execution is disabled. Register and authorize the model run separately.')
  const pinned = verifyArtifacts(manifest)
  if (pinned._tag === 'Err')
    throw new Error(pinned.message)
  const importedUsage = manifest.usageImports.map(source => ({ source, usage: parseUsage(readFileSync(source.path, 'utf8'), source.cutoff, sha256(source.path)) }))
  const ownership = importedUsage.length ? combineUsage(importedUsage.map(row => row.usage)) : { _tag: 'Ok' as const, value: null }
  if (ownership._tag === 'Err')
    throw new Error(ownership.message)
  mkdirSync(directory, { mode: 0o700 })
  const frozen = freezeManifest(manifest, directory)
  const schedule = buildSchedule(manifest)
  const records: RecordedCommand[] = []
  const attempts: AttemptMetric[] = []
  const runtimeStarted = new Date().toISOString()
  const controllerBefore = process.resourceUsage()
  const start = performance.now()
  const qualityGates: {
    task: string
    mode: Mode
    repeat: number
    attempt: number
    id: string
    _tag: 'Passed' | 'Failed' | 'Unavailable' | 'NotRun'
    required: boolean
  }[] = []
  const independentGrading: {
    phase: 'verification'
    role: 'controller'
    started: string
    completed: string
    seconds: number
    cpuSeconds: number
  }[] = []
  const abortStudy = (reason: string): never => {
    const checkpoint = {
      _tag: 'Aborted',
      reason,
      manifestHash: frozen.hash,
      runtimeStarted,
      completed: new Date().toISOString(),
      elapsedSeconds: (performance.now() - start) / 1000,
      attempts,
      records,
      qualityGates,
      independentGrading,
      importedUsage,
      summaries: aggregateAttempts(attempts, manifest.seed),
      recordedUsage: records.map(record => ({
        role: record.role,
        phase: record.phase,
        path: record.observedEvents.path,
        usage: parseUsage(readFileSync(record.observedEvents.path, 'utf8'), record.completed, sha256(record.observedEvents.path)),
      })),
    }
    writeFileSync(join(directory, 'abort-checkpoint.json'), `${JSON.stringify(checkpoint, null, 2)}\n`, { flag: 'wx', mode: 0o400 })
    throw new Error(reason)
  }
  writeFileSync(join(directory, 'schedule.json'), `${JSON.stringify(schedule, null, 2)}\n`, { flag: 'wx', mode: 0o400 })
  const dispatch = async (command: string[], cwd: string, base: string, phase: RecordedCommand['phase'], role: RecordedCommand['role'], env?: NodeJS.ProcessEnv) => {
    const record = await recordCommand({ command, cwd, directory: join(base, `command-${records.length}`), phase, role, timeoutMs: manifest.timeoutMs, tracing: manifest.tracing, env })
    records.push(record)
    return record
  }
  for (const command of manifest.versions) {
    const result = await dispatch(command, process.cwd(), directory, 'setup', 'controller')
    if (!commandSucceeded(result))
      abortStudy('A preregistered runtime version command failed. Its complete record is retained.')
  }
  for (const entry of schedule) {
    const integrity = verifyFrozenManifest(frozen)
    const artifacts = verifyArtifacts(manifest)
    if (integrity._tag === 'Err')
      abortStudy(integrity.message)
    if (artifacts._tag === 'Err')
      abortStudy(artifacts.message)
    const task = manifest.tasks.find(t => t.id === entry.task)!
    const base = join(directory, `${task.id}-${entry.repeat}-${entry.mode}`)
    mkdirSync(base, { mode: 0o700 })
    const project = join(base, 'project')
    const cache = manifest.cache === 'warm' ? join(directory, 'warm-cache') : join(base, 'cache')
    const preparationStart = performance.now()
    mkdirSync(cache, { recursive: true, mode: 0o700 })
    const environment = { ...process.env, ...(manifest.cache === 'uncontrolled' ? {} : { XDG_CACHE_HOME: cache }), RIPIDE_EXPERIMENT_MODE: entry.mode, RIPIDE_EXPERIMENT_TASK: task.id, RIPIDE_EXPERIMENT_RECORD_DIRECTORY: base }
    const expand = (command: string[], promptFile = '') => command.map(value => value.replaceAll('{project}', project).replaceAll('{promptFile}', promptFile).replaceAll('{mode}', entry.mode).replaceAll('{task}', task.id))
    const setup: RecordedCommand[] = []
    if (task.source._tag === 'Git') {
      setup.push(await dispatch(['git', 'clone', '--no-hardlinks', '--no-checkout', '--local', task.source.repository, project], base, base, 'setup', 'controller', environment))
      if (commandSucceeded(setup[0]))
        setup.push(await dispatch(['git', 'checkout', '--detach', task.source.commit], project, base, 'setup', 'controller', environment))
    }
    else {
      mkdirSync(project)
      for (const [path, text] of Object.entries(task.source.files)) {
        const absolute = join(project, path)
        mkdirSync(dirname(absolute), { recursive: true })
        writeFileSync(absolute, text)
      }
    }
    const setupCommands = async (task: Task) => {
      for (const stage of task.setup) {
        const record = await dispatch(expand(stage.command), project, base, stage.phase, stage.role, environment)
        setup.push(record)
        if (!commandSucceeded(record))
          return false
      }
      return true
    }
    if (setup.some(r => !commandSucceeded(r)) || !await setupCommands(task)) {
      const seconds = (performance.now() - preparationStart) / 1000
      attempts.push({ task: task.id, mode: entry.mode, cohort: task.cohort, repeat: entry.repeat, attempt: 0, quality: 'unavailable', seconds, setupSeconds: seconds, preparedSeconds: 0, usage: { _tag: 'Unavailable', reason: 'Preparation failed before model execution.' } })
      writeFileSync(join(base, 'outcome.json'), JSON.stringify({ _tag: 'Unavailable', reason: 'Preparation failed.', setup }, null, 2))
      abortStudy('Project preparation failed before model execution.')
    }
    const baseline = snapshotProject(project, task.generatedDirectories)
    const expected = expectedProject(baseline, task.expected)
    writeFileSync(join(base, 'baseline-hashes.json'), `${JSON.stringify(Object.fromEntries(Object.entries(baseline).map(([path, content]) => [path, sha256(content)])), null, 2)}\n`)
    const setupSeconds = (performance.now() - preparationStart) / 1000
    const qualityRecords: unknown[] = []
    for (let attempt = 0; attempt <= manifest.repairs; attempt++) {
      const promptText = [manifest.commonInstructions, task.prompt, treatment[entry.mode], attempt ? `Repair attempt ${attempt}/${manifest.repairs}. Previous independent outcome:\n${JSON.stringify(qualityRecords.at(-1))}` : '', 'Run the preregistered checks. Preserve unrelated bindings, comments, and non-source files.'].filter(Boolean).join('\n\n')
      const message = archiveMessage(join(base, 'messages'), 'controller', attempt ? 'steering' : 'prompt', promptText)
      const phase = task.cohort === 'mechanical' ? 'mechanical' : task.cohort === 'architecture' ? 'architecture' : 'implementation'
      const runner = await dispatch(expand(manifest.runners[entry.mode].command, message.path), project, base, phase, 'arm', { ...environment, RIPIDE_EXPERIMENT_PROMPT_FILE: message.path })
      const imported = manifest.usageImports.filter(source => source.role === 'arm' && source.task === task.id && source.mode === entry.mode && source.repeat === entry.repeat && source.attempt === attempt)
      const usage = imported.length ? combineUsage(imported.map(source => parseUsage(readFileSync(source.path, 'utf8'), source.cutoff, sha256(source.path)))) : parseUsage(readFileSync(runner.observedEvents.path, 'utf8'), runner.completed, sha256(runner.observedEvents.path))
      const checked: RecordedCommand[] = []
      let quality: AttemptMetric['quality'] = runner.childLifecycle._tag === 'Unavailable' ? 'unavailable' : commandSucceeded(runner) ? 'passed' : runner.exit._tag === 'Exited' && runner.exit.code === 3 ? 'refused' : 'failed'
      let infrastructureFailure = commandCompleted(runner) && runner.exit._tag === 'Exited' && [0, 3].includes(runner.exit.code)
        ? undefined
        : 'The arm runner failed or has incomplete child lifecycle.'
      const gates: {
        id: string
        _tag: 'Passed' | 'Failed' | 'Unavailable' | 'NotRun'
        required: boolean
      }[] = task.qualityGates.map(gate => ({ id: gate.id, _tag: 'NotRun', required: gate.required }))
      if (quality === 'passed') {
        for (const stage of task.checks) {
          const record = await dispatch(expand(stage.command), project, base, stage.phase, stage.role, environment)
          checked.push(record)
          if (!commandCompleted(record)) {
            quality = 'unavailable'
            infrastructureFailure = 'A preregistered check has incomplete command lifecycle.'
            break
          }
          if (!commandSucceeded(record))
            quality = 'failed'
        }
        for (const gate of infrastructureFailure ? [] : task.qualityGates) {
          const record = await dispatch(expand(gate.command), project, base, 'verification', 'controller', environment)
          checked.push(record)
          const unavailable = !commandCompleted(record) || (record.exit._tag === 'Exited' && record.exit.code === 4)
          gates[gates.findIndex(row => row.id === gate.id)] = { id: gate.id, _tag: commandSucceeded(record) ? 'Passed' : unavailable ? 'Unavailable' : 'Failed', required: gate.required }
          if (!commandSucceeded(record) && gate.required)
            quality = unavailable ? 'unavailable' : 'failed'
          if (!commandCompleted(record)) {
            quality = 'unavailable'
            infrastructureFailure = 'A quality gate has incomplete command lifecycle.'
          }
          if (infrastructureFailure || (unavailable && gate.required))
            break
        }
      }
      const gradingStarted = new Date().toISOString()
      const gradingStart = performance.now()
      const gradingBefore = process.resourceUsage()
      const grade = gradeProject(project, expected, task.generatedDirectories, task.symbols, true)
      const gradingAfter = process.resourceUsage()
      const gradingSeconds = (performance.now() - gradingStart) / 1000
      independentGrading.push({ phase: 'verification', role: 'controller', started: gradingStarted, completed: new Date().toISOString(), seconds: gradingSeconds, cpuSeconds: (gradingAfter.userCPUTime - gradingBefore.userCPUTime + gradingAfter.systemCPUTime - gradingBefore.systemCPUTime) / 1e6 })
      if (grade._tag === 'Failed' && quality === 'passed')
        quality = 'failed'
      const preparedSeconds = runner.seconds + checked.reduce((n, r) => n + r.seconds, 0) + gradingSeconds
      const metric: AttemptMetric = { task: task.id, mode: entry.mode, cohort: task.cohort, repeat: entry.repeat, attempt, quality, seconds: preparedSeconds + (attempt === 0 ? setupSeconds : 0), setupSeconds: attempt === 0 ? setupSeconds : 0, preparedSeconds, usage: usage._tag === 'Ok' ? { _tag: 'Recorded', value: usage.value } : { _tag: 'Unavailable', reason: usage.message } }
      attempts.push(metric)
      const commits = checked.filter(r => r.phase === 'commit')
      const outcome = { metric, grade, gates, usage, usageSource: imported.length ? { _tag: 'Imported', artifacts: imported } : { _tag: 'Observed', artifact: runner.observedEvents }, prompt: message, responseBoundary: runner.completed, completeCommitToolOutput: commits.length ? { _tag: 'Recorded', commands: commits.map(r => ({ completed: r.completed, exit: r.exit })) } : { _tag: 'Unavailable', reason: 'No separate commit command was registered. Runner completion does not prove a commit.' }, deliveryCompleted: new Date().toISOString() }
      qualityRecords.push(outcome)
      qualityGates.push(...gates.map(gate => ({ ...gate, task: task.id, mode: entry.mode, repeat: entry.repeat, attempt })))
      writeFileSync(join(base, `attempt-${attempt}.json`), `${JSON.stringify(outcome, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
      if (infrastructureFailure)
        abortStudy(infrastructureFailure)
      if (quality === 'unavailable')
        abortStudy('A required quality gate is unavailable.')
      if (quality === 'passed')
        break
    }
  }
  const runtimeCompleted = new Date().toISOString()
  const controllerAfter = process.resourceUsage()
  const phaseUsage = records.map(record => ({ phase: record.phase, role: record.role, completed: record.completed, usage: parseUsage(readFileSync(record.observedEvents.path, 'utf8'), record.completed) }))

  const sums = (role: 'arm' | 'controller') => records.filter(r => r.role === role).reduce((s, r) => ({ seconds: s.seconds + r.seconds, cpuSeconds: s.cpuSeconds + (r.resources._tag === 'Recorded' ? r.resources.userSeconds + r.resources.systemSeconds : 0), missingCpuRecords: s.missingCpuRecords + Number(r.resources._tag === 'Unavailable') }), { seconds: 0, cpuSeconds: 0, missingCpuRecords: 0 })
  const report = {
    manifestHash: frozen.hash,
    study: manifest.study,
    runtimeStarted,
    runtimeCompleted,
    elapsedSeconds: (performance.now() - start) / 1000,
    schedule,
    attempts,
    qualityBeforeCost: true,
    qualityGates,
    summaries: aggregateAttempts(attempts, manifest.seed),
    paired: pairAttempts(attempts, manifest.seed),
    phaseUsage,
    importedUsage,
    independentGrading,
    phases: records.map(r => ({ phase: r.phase, role: r.role, started: r.started, completed: r.completed, seconds: r.seconds, resources: r.resources, childLifecycle: r.childLifecycle, exit: r.exit })),
    resourceCategories: { armCommands: sums('arm'), controllerCommands: sums('controller'), controllerHarnessCpuSeconds: (controllerAfter.userCPUTime - controllerBefore.userCPUTime + controllerAfter.systemCPUTime - controllerBefore.systemCPUTime) / 1e6, controllerModelUsage: importedUsage.some(row => row.source.role === 'controller') ? { _tag: 'Imported', records: importedUsage.filter(row => row.source.role === 'controller') } : { _tag: 'Unavailable', reason: 'No controller model usage was supplied. Recorder process resources are separate.' } },
    cache: { declaredLocalCondition: manifest.cache, providerState: { _tag: 'Unavailable', reason: 'The harness cannot control or infer provider cache priming.' } },
    mechanicalAttribution: { commandSpans: records.filter(r => r.phase === 'mechanical'), phaseUsage: phaseUsage.filter(r => r.phase === 'mechanical'), importedUsage: importedUsage.filter(row => row.source.phase === 'mechanical'), mixedResponseTokens: { _tag: 'Unavailable', reason: 'A mixed model response cannot be split by command duration. Use externally recorded phase-specific responses.' } },
    limitations: ['One process runs at a time; unrelated host load remains recorded.', 'Timing includes equivalent child tracing and resource recording.', 'Pilot results are separate from registered held-out results.', 'Quality gates marked unavailable prevent required-gate comparisons.', 'Publication is outside implementation unless a publication command is registered.'],
    artifacts: records.flatMap(r => [r.stdout, r.stderr, r.observedEvents, ...r.processTrace._tag === 'Recorded' ? r.processTrace.artifacts : []]),
  }
  const encoded = `${JSON.stringify(report, null, 2)}\n`
  writeFileSync(join(directory, 'report.json'), encoded, { flag: 'wx', mode: 0o400 })
  writeFileSync(join(directory, 'report.md'), reportMarkdown(attempts, manifest.seed, frozen.hash, manifest.study, qualityGates), { flag: 'wx', mode: 0o400 })
  writeFileSync(join(directory, 'report.sha256'), `${sha256(encoded)}\n`, { flag: 'wx', mode: 0o400 })
  chmodSync(frozen.path, 0o400)
  return report
}
