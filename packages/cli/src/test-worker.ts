import type { UserWorkspaceConfig } from 'vitest/config'
import type { ResolvedConfig, TestModule, Vitest } from 'vitest/node'
import type { InlineTestCase, InlineTestError, InlineTestReport, InlineTestResult, ResolvedInlineTestRequest } from './test-result.ts'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'
import { createVitest, resolveConfig, version } from 'vitest/node'
import { appendTestLog, emptyTestReport, MAX_TEST_SOURCE_BYTES } from './test-result.ts'

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : { message: String(value) }
}

function errorReport(value: unknown, virtualPath: string, lineOffset = 0): InlineTestError {
  const error = object(value)
  const frame = Array.isArray(error.stacks) ? error.stacks.find((entry: unknown) => object(entry).file === virtualPath) : undefined
  const position = frame ? object(frame) : undefined
  return {
    message: String(error.message ?? value).slice(0, 2000),
    ...(error.expected !== undefined ? { expected: (typeof error.expected === 'string' ? error.expected : inspect(error.expected, { depth: 3, colors: false })).slice(0, 1000) } : {}),
    ...(error.actual !== undefined ? { actual: (typeof error.actual === 'string' ? error.actual : inspect(error.actual, { depth: 3, colors: false })).slice(0, 1000) } : {}),
    ...(typeof error.diff === 'string' ? { diff: error.diff.slice(0, 2000) } : {}),
    ...(typeof error.stack === 'string' ? { stack: error.stack.split(virtualPath).join('<stdin>').slice(0, 2000) } : {}),
    ...(typeof position?.line === 'number' ? { line: Math.max(1, position.line - lineOffset) } : {}),
    ...(typeof position?.column === 'number' ? { column: position.column } : {}),
  }
}

function buildReport(modules: TestModule[], unhandledErrors: unknown[], report: InlineTestReport, virtualPath: string, lineOffset: number): InlineTestResult {
  const moduleErrors = modules.flatMap(module => module.errors())
  const errors = [...moduleErrors, ...unhandledErrors].slice(0, 10).map(error => errorReport(error, virtualPath, lineOffset))
  for (const module of modules) {
    for (const test of module.children.allTests()) {
      const result = test.result()
      const state = result.state === 'pending' ? 'failed' : result.state
      report.counts[state]++
      const entry: InlineTestCase = {
        name: test.fullName.slice(0, 1000),
        state,
        errors: result.state === 'failed' ? result.errors.slice(0, 3).map(error => errorReport(error, virtualPath, lineOffset)) : [],
      }
      if (report.tests.length < 50)
        report.tests.push(entry)
      else
        report.omitted++
    }
  }
  if (moduleErrors.length)
    return { ...report, _tag: 'Error', phase: 'collect', message: errors[0].message, errors }
  if (report.counts.failed || unhandledErrors.length)
    return { ...report, _tag: 'Failed', errors }
  if (!report.counts.passed)
    return { ...report, _tag: 'Error', phase: 'execute', message: 'No tests completed. Supply at least one test that runs.', errors }
  return { ...report, _tag: 'Passed' }
}

async function execute(request: ResolvedInlineTestRequest): Promise<InlineTestResult> {
  // Vite resolves module IDs with forward slashes on every platform.
  const virtualPath = join(dirname(request.from), `__ripide_inline_${randomUUID()}.test.ts`).replaceAll('\\', '/')
  const rootRelative = `/${relative(request.cwd, virtualPath).replaceAll('\\', '/')}`
  const vitestEntry = import.meta.resolve('vitest')
  const report = { ...emptyTestReport(), runner: { name: 'vitest' as const, version } }
  const prologue = request.symbol
    ? `import { test, expect, vi } from 'vitest'\nimport ${request.importName === 'default' ? request.symbol : `{ ${request.symbol} }`} from ${JSON.stringify(`./${relative(dirname(request.from), request.from).replaceAll('\\', '/')}`)}\n`
    : ''
  const plugin = {
    name: 'ripide-inline-test',
    enforce: 'pre' as const,
    async config(config: UserWorkspaceConfig) {
      if (!config.test?.projects)
        return
      const fileProjects = config.test.projects.some(entry => typeof entry === 'string')
        ? await resolveConfig({ root: request.cwd, config: request.config, project: request.project ? [request.project] : undefined })
        : undefined
      const resolvedTest = fileProjects?.test as ResolvedConfig | undefined
      const projectNames = new Map(resolvedTest?.resolvedProjects.map(entry => [entry.viteConfig.configFile?.replaceAll('\\', '/'), entry.projectConfig.name]))
      config.test.projects = config.test.projects.map((entry) => {
        if (typeof entry === 'string') {
          if (/[*{}]/.test(entry))
            throw new Error('Pass a project configuration file with --config instead of a project glob.')
          const path = resolve(request.cwd, entry).replaceAll('\\', '/')
          return { extends: path, plugins: [plugin], test: { name: projectNames.get(path) } }
        }
        if (typeof entry === 'function' || entry instanceof Promise)
          throw new Error('Pass a project configuration file with --config for computed projects.')
        return { ...entry, plugins: [...entry.plugins ?? [], plugin] }
      })
    },
    resolveId(source: string) {
      if (source === virtualPath || source === rootRelative)
        return virtualPath
      if (source === 'vitest')
        return fileURLToPath(vitestEntry)
    },
    load(source: string) {
      if (source === virtualPath || source === rootRelative)
        return prologue + request.source
    },
  }
  let runner: Vitest | undefined
  return (async (): Promise<InlineTestResult> => {
    runner = await createVitest({
      root: request.cwd,
      config: request.config,
      project: request.project ? [request.project] : undefined,
      watch: false,
      maxWorkers: 1,
      fileParallelism: false,
      retry: 0,
      expect: { requireAssertions: true },
      testTimeout: request.testTimeoutMs,
      hookTimeout: request.testTimeoutMs,
      update: false,
      coverage: {
        enabled: Boolean(request.coverageFiles?.length),
        provider: 'v8',
        include: request.coverageFiles,
        reportsDirectory: request.reportsDirectory,
        reporter: [],
        reportOnFailure: true,
        thresholds: {},
      },
      cache: false,
      reporters: [{
        onCoverage(coverage) {
          const data = object(object(coverage).data)
          for (const [file, raw] of Object.entries(data)) {
            const value = object(object(raw).data ?? raw)
            const counts = object(value.f)
            const branchMap = object(value.branchMap)
            const branchCounts = object(value.b)
            for (const [id, rawFunction] of Object.entries(object(value.fnMap))) {
              const fn = object(rawFunction)
              const location = object(fn.loc)
              const startLine = Number(object(location.start).line)
              const endLine = Number(object(location.end).line)
              report.coverage.push({
                file: relative(request.cwd, file).replaceAll('\\', '/'),
                name: String(fn.name),
                startLine,
                startColumn: Number(object(location.start).column),
                endLine,
                hits: Number(counts[id] ?? 0),
                branches: Object.entries(branchMap).flatMap(([id, rawBranch]) => {
                  const line = Number(object(object(rawBranch).loc).start && object(object(object(rawBranch).loc).start).line)
                  return line >= startLine && line <= endLine
                    ? [{ line, hits: Array.isArray(branchCounts[id]) ? branchCounts[id] as number[] : [] }]
                    : []
                }),
              })
            }
          }
        },
        onUserConsoleLog(log) {
          appendTestLog(report.logs, log.type === 'stdout' ? 'stdout' : 'stderr', log.content)
        },
      }],
    }, { plugins: [plugin] })
    const projects = runner.projects
    if (projects.length !== 1)
      return { ...report, _tag: 'Error', phase: 'resolve', message: 'Several test projects match. Select one with --project.', errors: [] }
    const project = projects[0]
    if (project.config.browser.enabled)
      return { ...report, _tag: 'Error', phase: 'resolve', message: 'Browser test projects are unsupported. Select a Node test project.', errors: [] }
    await runner.standalone()
    const result = await runner.runTestSpecifications([project.createSpecification(virtualPath)])
    return buildReport(result.testModules, result.unhandledErrors, report, virtualPath, request.symbol ? 2 : 0)
  })().catch((error: unknown): InlineTestResult => ({
    ...report,
    _tag: 'Error',
    phase: 'execute',
    message: error instanceof Error ? error.message : String(error),
    errors: [errorReport(error, virtualPath)],
  })).finally(async () => {
    await runner?.close()
  })
}

function parseRequest(value: unknown): ResolvedInlineTestRequest {
  const input = object(value)
  if (typeof input.source !== 'string' || Buffer.byteLength(input.source) > MAX_TEST_SOURCE_BYTES
    || typeof input.from !== 'string' || typeof input.cwd !== 'string'
    || typeof input.timeoutMs !== 'number' || typeof input.testTimeoutMs !== 'number'
    || (input.config !== undefined && typeof input.config !== 'string')
    || (input.project !== undefined && typeof input.project !== 'string')) {
    throw new Error('The test worker received an invalid request.')
  }
  return input as unknown as ResolvedInlineTestRequest
}

process.once('message', (message: unknown) => {
  void Promise.resolve().then(() => execute(parseRequest(message))).catch((error: unknown): InlineTestResult => ({
    ...emptyTestReport(),
    _tag: 'Error',
    phase: 'execute',
    message: error instanceof Error ? error.message : String(error),
    errors: [],
  })).then((result) => {
    process.send?.(result, () => process.disconnect?.())
  })
})
