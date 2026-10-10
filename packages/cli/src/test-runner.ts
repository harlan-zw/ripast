import type { ChildProcess } from 'node:child_process'
import type { InlineTestLogs, InlineTestRequest, InlineTestResult, ResolvedInlineTestRequest } from './test-result.ts'
import { Buffer } from 'node:buffer'
import { execFile, fork } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { appendTestLog, emptyTestReport, isInlineTestResult, MAX_TEST_SOURCE_BYTES } from './test-result.ts'

export type { InlineTestCase, InlineTestError, InlineTestLogs, InlineTestReport, InlineTestRequest, InlineTestResult } from './test-result.ts'

function inputError(message: string, phase: 'input' | 'resolve' = 'input'): InlineTestResult {
  return { ...emptyTestReport(), _tag: 'Error', phase, message, errors: [] }
}

function resolveRequest(input: InlineTestRequest): ResolvedInlineTestRequest | InlineTestResult {
  if (typeof input.source !== 'string' || !input.source.trim())
    return inputError('Pipe a TypeScript test module through stdin.')
  if (Buffer.byteLength(input.source) > MAX_TEST_SOURCE_BYTES)
    return inputError('The test module exceeds the 1 MiB input limit.')
  if (typeof input.from !== 'string' || !input.from.trim())
    return inputError('Pass the source file with --from.')
  const timeoutMs = input.timeoutMs ?? 30000
  const testTimeoutMs = input.testTimeoutMs ?? 5000
  if (![timeoutMs, testTimeoutMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647))
    return inputError('Timeouts must be positive integers below 2147483648 milliseconds.')
  const directory = resolve(input.cwd ?? process.cwd())
  if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory())
    return inputError(`Project directory does not exist: ${directory}.`, 'resolve')
  const cwd = realpathSync.native(directory)
  const from = resolve(cwd, input.from)
  if (!statSync(from, { throwIfNoEntry: false })?.isFile())
    return inputError(`Source file does not exist: ${from}.`, 'resolve')
  const config = input.config ? resolve(cwd, input.config) : undefined
  if (config && !statSync(config, { throwIfNoEntry: false })?.isFile())
    return inputError(`Configuration file does not exist: ${config}.`, 'resolve')
  if (input.symbol !== undefined && !/^[$A-Z_][$\w]*$/i.test(input.symbol))
    return inputError('The symbol must be a JavaScript identifier.')
  return { source: input.source, from, cwd, config, project: input.project, timeoutMs, testTimeoutMs, symbol: input.symbol, importName: input.importName, coverageFiles: input.coverageFiles }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  }
  catch (error) {
    // The process group may already have exited after Vitest closed its workers.
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
      throw error
  }
}

async function terminateWorker(child: ChildProcess): Promise<void> {
  if (!child.pid)
    return
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null)
      return
    const pid = child.pid
    await new Promise<void>((resolve, reject) => {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], (error) => {
        if (error && child.exitCode === null && child.signalCode === null) {
          try {
            process.kill(pid, 0)
          }
          catch (probeError) {
            // The worker can exit before Node receives its exit event.
            if (probeError instanceof Error && 'code' in probeError && probeError.code === 'ESRCH') {
              resolve()
              return
            }
            reject(probeError)
            return
          }
          reject(error)
          return
        }
        resolve()
      })
    })
    return
  }
  signalGroup(child.pid, 'SIGTERM')
  await new Promise(resolve => setTimeout(resolve, 100))
  signalGroup(child.pid, 'SIGKILL')
}

/** Execute one supplied test module. This does not generate a repository test file. */
export async function runInlineTest(input: InlineTestRequest, options: { signal?: AbortSignal } = {}): Promise<InlineTestResult> {
  const request = resolveRequest(input)
  if ('_tag' in request)
    return request
  const start = performance.now()
  const logs: InlineTestLogs = { stdout: '', stderr: '', truncated: false }
  if (options.signal?.aborted)
    return inputError('Test execution was cancelled.')
  const scratch = join(homedir(), 'scratch')
  mkdirSync(scratch, { recursive: true })
  const reportsDirectory = mkdtempSync(join(scratch, 'ripide-coverage-'))
  request.reportsDirectory = reportsDirectory
  const sourceMode = import.meta.url.endsWith('.ts')
  const worker = sourceMode ? new URL('./test-worker.ts', import.meta.url) : new URL(import.meta.resolve('#test-worker'))
  const child = fork(fileURLToPath(worker), [], {
    cwd: request.cwd,
    execArgv: sourceMode ? ['--experimental-strip-types', '--no-warnings'] : [],
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    // The runner owns a fresh test context, independent of any parent Vitest worker.
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITEST_'))),
  })
  child.stdout?.on('data', chunk => appendTestLog(logs, 'stdout', String(chunk)))
  child.stderr?.on('data', chunk => appendTestLog(logs, 'stderr', String(chunk)))
  let removeAbort = () => {}
  const result = await new Promise<InlineTestResult>((resolve) => {
    let settled = false
    const finish = (result: InlineTestResult) => {
      if (settled)
        return
      settled = true
      clearTimeout(deadline)
      removeAbort()
      resolve(result)
    }
    const failure = (message: string) => finish({ ...emptyTestReport(), _tag: 'Error', phase: 'execute', message, errors: [] })
    const deadline = setTimeout(() => finish({ ...emptyTestReport(), _tag: 'TimedOut', timeoutMs: request.timeoutMs }), request.timeoutMs)
    const cancel = () => failure('Test execution was cancelled.')
    options.signal?.addEventListener('abort', cancel, { once: true })
    removeAbort = () => options.signal?.removeEventListener('abort', cancel)
    child.on('error', error => failure(`Could not start the test worker: ${error.message}`))
    child.on('exit', (code, signal) => failure(`The test worker exited without a result (${signal ?? code}).`))
    child.on('message', (message: unknown) => {
      if (isInlineTestResult(message))
        finish(message)
      else
        failure('The test worker returned an invalid report.')
    })
    child.send(request, error => error && failure(`Could not send the test module: ${error.message}`))
  })
  await terminateWorker(child).finally(() => rm(reportsDirectory, { recursive: true, force: true }))
  appendTestLog(logs, 'stdout', result.logs.stdout)
  appendTestLog(logs, 'stderr', result.logs.stderr)
  logs.truncated ||= result.logs.truncated
  return { ...result, durationMs: performance.now() - start, logs }
}
