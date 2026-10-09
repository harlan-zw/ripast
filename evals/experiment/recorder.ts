import type { Buffer } from 'node:buffer'
import type { Writable } from 'node:stream'
import type { Phase } from './manifest.ts'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, freemem, loadavg, totalmem } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'
import { sha256 } from './manifest.ts'
import { createTraceTracker, groupMembers } from './processes.ts'

export type ParentExit = {
  _tag: 'Exited'
  code: number
} | {
  _tag: 'Signaled'
  signal: string
} | {
  _tag: 'TimedOut'
  code: number | null
  signal: string | null
} | {
  _tag: 'SpawnFailed'
  message: string
}
export type Exit = ParentExit | { _tag: 'DescendantsTerminated', parent: ParentExit, pids: number[] }
export interface RecordedCommand {
  command: string[]
  cwd: string
  phase: Phase
  role: 'arm' | 'controller'
  started: string
  completed: string
  seconds: number
  exit: Exit
  childLifecycle: { _tag: 'ProvenComplete' } | { _tag: 'Unavailable', reason: string }
  stdout: {
    path: string
    bytes: number
    sha256: string
  }
  stderr: {
    path: string
    bytes: number
    sha256: string
  }
  observedEvents: {
    path: string
    bytes: number
    sha256: string
  }
  processTrace: {
    _tag: 'Recorded'
    artifacts: {
      path: string
      sha256: string
    }[]
  } | {
    _tag: 'Unavailable'
    reason: string
  }
  resources: {
    _tag: 'Recorded'
    userSeconds: number
    systemSeconds: number
    maxRssKiB: number
    artifact: string
  } | {
    _tag: 'Unavailable'
    reason: string
  }
  load: {
    at: string
    load: number[]
    freeBytes: number
    totalBytes: number
    logicalCpus: number
  }[]
}
export function archiveMessage(directory: string, role: 'arm' | 'controller', kind: 'prompt' | 'steering', plaintext: string): {
  at: string
  path: string
  sha256: string
} {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const at = new Date().toISOString()
  const path = join(directory, `${kind}-${role}-${Date.now()}-${process.hrtime.bigint()}.txt`)
  writeFileSync(path, plaintext, { flag: 'wx', mode: 0o600 })
  const record = { at, path, sha256: sha256(plaintext) }
  writeFileSync(`${path}.json`, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 })
  return record
}
export async function recordCommand(options: {
  command: string[]
  cwd: string
  directory: string
  phase: Phase
  role: 'arm' | 'controller'
  timeoutMs: number
  tracing: 'strace' | 'top-level'
  env?: NodeJS.ProcessEnv
}, dependencies: {
  openOutput: (path: string) => Writable
} = { openOutput: path => createWriteStream(path, { mode: 0o600 }) }): Promise<RecordedCommand> {
  const { command, cwd, directory, phase, role } = options
  if (!command.length)
    throw new Error('Command is empty.')
  mkdirSync(directory, { mode: 0o700 })
  const started = new Date().toISOString()
  const start = performance.now()
  const load: RecordedCommand['load'] = []
  const sample = () => load.push({ at: new Date().toISOString(), load: loadavg(), freeBytes: freemem(), totalBytes: totalmem(), logicalCpus: cpus().length })
  sample()
  const traced = options.tracing === 'strace'
  if (traced && process.platform !== 'linux')
    throw new Error('Complete child lifecycle tracing requires Linux.')
  if (traced && (!existsSync('/usr/bin/strace') || !existsSync('/usr/bin/time')))
    throw new Error('Child tracing requires /usr/bin/strace and /usr/bin/time.')
  const timed = existsSync('/usr/bin/time')
  const timePath = join(directory, 'resources.time')
  const timedCommand = timed ? ['/usr/bin/time', '-v', '-o', timePath, ...command] : command
  const actual = traced ? ['/usr/bin/strace', '-ff', '-ttt', '-e', 'trace=%process', '-o', join(directory, 'process.trace'), ...timedCommand] : timedCommand
  writeFileSync(join(directory, 'dispatch.json'), `${JSON.stringify({ command, actual, cwd, phase, role, started })}\n`, { mode: 0o600 })
  const child = spawn(actual[0], actual.slice(1), { cwd, env: options.env ?? process.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const tracker = createTraceTracker(directory, child.pid)
  const tracking = traced ? setInterval(tracker.collect, 50) : undefined
  let timedOut = false
  const terminate = (signal: NodeJS.Signals) => {
    if (!child.pid)
      return
    if (traced && tracker.terminate(signal).length)
      return
    if (process.platform === 'win32') {
      child.kill(signal)
    }
    else {
      try {
        process.kill(-child.pid, signal)
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          throw error
      }
    }
  }
  let forced: ReturnType<typeof setTimeout> | undefined
  const timeout = setTimeout(() => {
    timedOut = true
    terminate('SIGTERM')
    forced = setTimeout(terminate, 1000, 'SIGKILL')
  }, options.timeoutMs)
  const sampling = setInterval(sample, 1000)
  const stdoutPath = join(directory, 'stdout.log')
  const stderrPath = join(directory, 'stderr.log')
  const observedPath = join(directory, 'observed-events.jsonl')
  const observed: string[] = []
  const decoder = new StringDecoder('utf8')
  let pending = ''
  const observe = (line: string) => {
    if (!line.trim().startsWith('{'))
      return
    let event: unknown
    try {
      event = JSON.parse(line)
    }
    catch {
      observed.push(JSON.stringify({ type: 'recorder.invalid_json', _observedCompleted: new Date().toISOString(), rawLineSha256: sha256(line) }))
      return
    } // Ordinary command output can include partial JSON. Raw bytes remain in stdout.log.
    if (event && typeof event === 'object' && !Array.isArray(event))
      observed.push(JSON.stringify({ ...event, _observedCompleted: new Date().toISOString() }))
  }
  const tap = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    pending += decoder.write(chunk)
    const lines = pending.split('\n')
    pending = lines.pop()!
    for (const line of lines)
      observe(line)
    callback(null, chunk)
  }, flush(callback) {
    pending += decoder.end()
    if (pending)
      observe(pending)
    callback()
  } })
  const streams = [pipeline(child.stdout, tap, dependencies.openOutput(stdoutPath)), pipeline(child.stderr, dependencies.openOutput(stderrPath))]
  const closed = new Promise<ParentExit>((resolve) => {
    child.once('error', error => resolve({ _tag: 'SpawnFailed', message: error.message }))
    child.once('close', (code, signal) => resolve(timedOut ? { _tag: 'TimedOut', code, signal } : signal ? { _tag: 'Signaled', signal } : { _tag: 'Exited', code: code ?? 1 }))
  })
  let exit: Exit
  try {
    [exit] = await Promise.all([closed, ...streams])
    const tracedRemaining = traced ? tracker.terminate('SIGKILL') : []
    if (tracedRemaining.length)
      exit = { _tag: 'DescendantsTerminated', parent: exit, pids: tracedRemaining }
    if (!traced && child.pid && process.platform === 'linux') {
      const remaining = groupMembers(child.pid)
      if (remaining.length) {
        const parent = exit as ParentExit
        terminate('SIGKILL')
        exit = { _tag: 'DescendantsTerminated', parent, pids: remaining.map(member => member.pid) }
        const deadline = performance.now() + 1000
        while (groupMembers(child.pid).length && performance.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 10))
        if (groupMembers(child.pid).length)
          throw new Error('Remaining command processes did not terminate.')
      }
    }
  }
  catch (error) {
    terminate('SIGKILL')
    await closed
    throw error
  }
  finally {
    clearInterval(sampling)
    clearInterval(tracking)
    clearTimeout(timeout)
    clearTimeout(forced)
    sample()
  }
  const completed = new Date().toISOString()
  writeFileSync(observedPath, observed.join('\n') + (observed.length ? '\n' : ''), { flag: 'wx', mode: 0o600 })
  const artifact = (path: string) => {
    const bytes = readFileSync(path)
    return { path, bytes: bytes.length, sha256: sha256(bytes) }
  }
  const traceArtifacts = readdirSync(directory).filter(name => name.startsWith('process.trace')).map(name => ({ path: join(directory, name), sha256: sha256(readFileSync(join(directory, name))) }))
  const childLifecycle: RecordedCommand['childLifecycle'] = traced && traceArtifacts.length && traceArtifacts.every(artifact => /\+\+\+ (?:exited with|killed by)/.test(readFileSync(artifact.path, 'utf8'))) ? { _tag: 'ProvenComplete' } : { _tag: 'Unavailable', reason: traced ? 'Some traced child exits lack terminal records.' : 'Top-level recording cannot prove escaped child lifecycle. Remaining same-group processes are terminated.' }
  let resources: RecordedCommand['resources'] = { _tag: 'Unavailable', reason: 'GNU time did not produce complete resource categories.' }
  if (existsSync(timePath)) {
    const text = readFileSync(timePath, 'utf8')
    const user = /User time \(seconds\): ([\d.]+)/.exec(text)
    const system = /System time \(seconds\): ([\d.]+)/.exec(text)
    const rss = /Maximum resident set size \(kbytes\): (\d+)/.exec(text)
    if (user && system && rss)
      resources = { _tag: 'Recorded', userSeconds: Number(user[1]), systemSeconds: Number(system[1]), maxRssKiB: Number(rss[1]), artifact: timePath }
  }
  const result: RecordedCommand = { command, cwd, phase, role, started, completed, seconds: (performance.now() - start) / 1000, exit, childLifecycle, stdout: artifact(stdoutPath), stderr: artifact(stderrPath), observedEvents: artifact(observedPath), processTrace: traceArtifacts.length ? { _tag: 'Recorded', artifacts: traceArtifacts } : { _tag: 'Unavailable', reason: 'Only the dispatched process exit is recorded.' }, resources, load }
  writeFileSync(join(directory, 'record.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return result
}
export function commandSucceeded(record: RecordedCommand): boolean {
  return record.exit._tag === 'Exited' && record.exit.code === 0 && record.childLifecycle._tag === 'ProvenComplete'
}
