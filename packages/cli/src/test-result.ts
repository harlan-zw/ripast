import { Buffer } from 'node:buffer'

export interface InlineTestError {
  message: string
  expected?: string
  actual?: string
  diff?: string
  stack?: string
  line?: number
  column?: number
}

export interface InlineTestCase {
  name: string
  state: 'passed' | 'failed' | 'skipped'
  errors: InlineTestError[]
}

export interface InlineTestLogs {
  stdout: string
  stderr: string
  truncated: boolean
}

export interface InlineTestReport {
  coverage: FunctionCoverage[]
  runner: { name: 'vitest', version: string } | null
  durationMs: number
  counts: { passed: number, failed: number, skipped: number }
  tests: InlineTestCase[]
  omitted: number
  logs: InlineTestLogs
}

export type InlineTestResult = InlineTestReport & (
  | { _tag: 'Passed' }
  | { _tag: 'Failed', errors: InlineTestError[] }
  | { _tag: 'Error', phase: 'input' | 'resolve' | 'collect' | 'execute', message: string, errors: InlineTestError[] }
  | { _tag: 'TimedOut', timeoutMs: number }
)

export interface InlineTestRequest {
  importName?: 'default'
  symbol?: string
  coverageFiles?: string[]
  source: string
  from: string
  cwd?: string
  config?: string
  project?: string
  timeoutMs?: number
  testTimeoutMs?: number
}

export interface ResolvedInlineTestRequest {
  importName?: 'default'
  symbol?: string
  coverageFiles?: string[]
  reportsDirectory?: string
  source: string
  from: string
  cwd: string
  config?: string
  project?: string
  timeoutMs: number
  testTimeoutMs: number
}

export const MAX_TEST_SOURCE_BYTES = 1024 * 1024
export const MAX_TEST_LOG_BYTES = 16384

export interface FunctionCoverage {
  file: string
  name: string
  startLine: number
  startColumn: number
  endLine: number
  hits: number
  branches: { line: number, hits: number[] }[]
}

export function emptyTestReport(): InlineTestReport {
  return {
    coverage: [],
    runner: null,
    durationMs: 0,
    counts: { passed: 0, failed: 0, skipped: 0 },
    tests: [],
    omitted: 0,
    logs: { stdout: '', stderr: '', truncated: false },
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function finiteCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function testError(value: unknown): value is InlineTestError {
  return record(value) && typeof value.message === 'string'
    && ['expected', 'actual', 'diff', 'stack'].every(key => value[key] === undefined || typeof value[key] === 'string')
    && ['line', 'column'].every(key => value[key] === undefined || finiteCount(value[key]))
}

export function isFunctionCoverage(entry: unknown): entry is FunctionCoverage {
  return record(entry) && typeof entry.file === 'string' && typeof entry.name === 'string'
    && ['startLine', 'startColumn', 'endLine', 'hits'].every(key => finiteCount(entry[key]))
    && Array.isArray(entry.branches) && entry.branches.every(branch => record(branch)
      && finiteCount(branch.line) && Array.isArray(branch.hits) && branch.hits.every(finiteCount))
}

/** Parse the IPC boundary before treating worker output as a report. */
export function isInlineTestResult(value: unknown): value is InlineTestResult {
  if (!record(value) || !finiteCount(value.durationMs) || !finiteCount(value.omitted)
    || !Array.isArray(value.coverage) || !value.coverage.every(isFunctionCoverage)
    || !record(value.counts) || !['passed', 'failed', 'skipped'].every(key => finiteCount(value.counts && (value.counts as Record<string, unknown>)[key]))
    || !record(value.logs) || typeof value.logs.stdout !== 'string' || typeof value.logs.stderr !== 'string' || typeof value.logs.truncated !== 'boolean'
    || !(value.runner === null || (record(value.runner) && value.runner.name === 'vitest' && typeof value.runner.version === 'string'))
    || !Array.isArray(value.tests) || !value.tests.every(test => record(test) && typeof test.name === 'string'
      && ['passed', 'failed', 'skipped'].includes(String(test.state)) && Array.isArray(test.errors) && test.errors.every(testError))) {
    return false
  }
  if (value._tag === 'Passed')
    return Number(value.counts.passed) > 0 && value.counts.failed === 0
  if (value._tag === 'TimedOut')
    return finiteCount(value.timeoutMs) && value.timeoutMs > 0
  if (!Array.isArray(value.errors) || !value.errors.every(testError))
    return false
  if (value._tag === 'Failed')
    return Number(value.counts.failed) > 0 || value.errors.length > 0
  return value._tag === 'Error' && typeof value.message === 'string' && ['input', 'resolve', 'collect', 'execute'].includes(String(value.phase))
}

export function appendTestLog(logs: InlineTestLogs, stream: 'stdout' | 'stderr', value: string): void {
  const remaining = MAX_TEST_LOG_BYTES - Buffer.byteLength(logs[stream])
  const buffer = Buffer.from(value)
  let end = Math.max(0, Math.min(remaining, buffer.length))
  // Drop an incomplete UTF-8 code point at the boundary.
  while (end > 0 && end < buffer.length && (buffer[end] & 0xC0) === 0x80)
    end--
  logs[stream] += buffer.subarray(0, end).toString('utf8')
  if (buffer.length > remaining)
    logs.truncated = true
}
