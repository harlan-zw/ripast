import type { Arm, Measurement } from './core.ts'
import type { ProjectCase } from './project-cases.ts'
import type { ProjectEvidence } from './project-check.ts'
import type { RunnerMode } from './project-plan.ts'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { parseCodexEvents, runCodex } from './codex-runner.ts'
import { parseEvents, summarize } from './core.ts'
import { projectCases, projectCasesBatchTwo, renameIdentifiers, renameStaticClasses } from './project-cases.ts'
import { checkProject, diagnostics } from './project-check.ts'
import { runnersForCase } from './project-plan.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const model = 'zai-coding-plan/glm-5.3-flash'

function git(dir: string, args: string[]): string {
  const result = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 20_000_000 })
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message ?? result.stderr)
  return result.stdout
}

function writeFiles(dir: string, files: Record<string, string>) {
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), source)
  }
}

function snapshot(c: ProjectCase) {
  const source = join(homedir(), c.source)
  const revision = git(source, ['rev-parse', 'HEAD']).trim()
  const paths = git(source, ['ls-tree', '-r', '--name-only', revision, '--', c.prefix]).trim().split('\n').filter(path => c._tag === 'Class' ? path.endsWith('.vue') : /\.tsx?$/.test(path))
  const initial: Record<string, string> = {}
  let targets = 0
  let decoys = 0
  for (const path of paths) {
    const text = git(source, ['show', `${revision}:${path}`])
    if (c._tag === 'Class') {
      if (text.includes(c.from)) {
        // Keep ten real Vue files whose target occurs only in static class attributes.
        const changed = renameStaticClasses(text, c.from, c.to)
        if (targets >= 10 || changed === text || changed.includes(c.from))
          continue
        targets++
      }
      else {
        if (decoys >= 10)
          continue
        decoys++
      }
    }
    initial[path] = text
    if (c._tag === 'Class' && targets >= 10 && decoys >= 10)
      break
  }
  const expected = Object.fromEntries(Object.entries(initial).map(([path, text]) => [path, c._tag === 'Class' ? renameStaticClasses(text, c.from, c.to) : renameIdentifiers(text, c.from, c.to)]))
  const changedFiles = Object.keys(initial).filter(path => initial[path] !== expected[path])
  if (!changedFiles.length || (c._tag === 'Symbol' && !initial[c.declaration]))
    throw new Error(`No usable source for ${c.name}`)
  return { source, revision, initial, expected, changedFiles }
}

function runAgent(project: string, prompt: string, env: NodeJS.ProcessEnv, timeout: number): Promise<{ stdout: string, stderr: string, code: number | null, seconds: number, timedOut: boolean }> {
  return new Promise((done, reject) => {
    const started = performance.now()
    const child = spawn('opencode', ['run', '--pure', '--auto', '--format', 'json', '--dir', project, '-m', model, prompt], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let force: ReturnType<typeof setTimeout> | undefined
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid)
        return
      try {
        process.kill(-child.pid, signal)
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
          throw error
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill('SIGTERM')
      force = setTimeout(kill, 3000, 'SIGKILL')
    }, timeout)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      clearTimeout(force)
      done({ stdout, stderr, code, timedOut, seconds: (performance.now() - started) / 1000 })
    })
  })
}

async function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' }, preflight: { type: 'boolean', default: false }, case: { type: 'string' }, timeout: { type: 'string', default: '150' }, batch: { type: 'string', default: 'first' }, runner: { type: 'string', default: 'opencode' } } })
  if (!['first', 'second'].includes(values.batch) || !['opencode', 'codex', 'split', 'both'].includes(values.runner))
    throw new Error('Use --batch first|second and --runner opencode|codex|split|both')
  const mode = values.runner as RunnerMode
  const cases = values.batch === 'second' ? projectCasesBatchTwo : projectCases
  const selected = cases.filter(c => !values.case || c.name === values.case)
  if (!selected.length)
    throw new Error('No project case matches')
  const needsOpenCode = !values.preflight && selected.some(c => runnersForCase(mode, cases.indexOf(c), cases.length).includes('opencode'))
  const timeout = Number(values.timeout) * 1000
  if (!Number.isFinite(timeout) || timeout < 1000)
    throw new Error('--timeout requires positive seconds')
  const scratch = join(homedir(), 'scratch')
  mkdirSync(scratch, { recursive: true })
  const out = values.out ? resolve(values.out) : mkdtempSync(join(scratch, 'ripide-projects-'))
  if (values.out && existsSync(out))
    throw new Error('Choose a new --out directory')
  mkdirSync(out, { recursive: true })
  const skill = readFileSync(join(root, 'packages/cli/skills/ripast/SKILL.md'), 'utf8')
  const providerFile = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode/opencode.json')
  const provider = needsOpenCode ? (JSON.parse(readFileSync(providerFile, 'utf8')) as { provider?: unknown }).provider ?? {} : {}
  const authFile = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'opencode/auth.json')
  const auth = existsSync(authFile) ? readFileSync(authFile, 'utf8') : null
  const cli = join(root, 'packages/cli/bin/ripide.mjs')
  const shell = (text: string) => `'${text.replaceAll('\'', '\'\\\'\'')}'`
  const results: (Measurement & { caseName: string, runner: string, model: string, issues: string[], tools: number, steps: number })[] = []
  const harnessHashes = Object.fromEntries(['projects.ts', 'project-cases.ts', 'project-check.ts', 'project-plan.ts', 'core.ts', 'codex-runner.ts'].map(path => [path, createHash('sha256').update(readFileSync(join(root, 'evals', path))).digest('hex')]))
  const metadata = { opencodeModel: model, codexModel: 'gpt-6-luna', codexReasoning: 'medium', runner: values.runner, batch: values.batch, revision: git(root, ['rev-parse', 'HEAD']).trim(), harnessHashes, started: new Date().toISOString(), skillHash: createHash('sha256').update(skill).digest('hex'), sourceMode: 'tracked HEAD source slices', concurrency: values.preflight ? 1 : 3 }
  console.log(`Results: ${out}`)
  writeFileSync(join(out, 'metadata.json'), JSON.stringify(metadata, null, 2))
  async function executeProject(c: ProjectCase, index: number) {
    const source = snapshot(c)
    writeFileSync(join(out, `${c.name}-source.json`), JSON.stringify({ ...source, initial: undefined, expected: undefined }, null, 2))
    const runners = values.preflight ? ['opencode'] as const : runnersForCase(mode, cases.indexOf(c), cases.length)
    for (const [runnerIndex, runner] of runners.entries()) {
      const order: Arm[] = values.preflight ? ['ripide'] : (index + runnerIndex) % 2 ? ['agent', 'ripide'] : ['ripide', 'agent']
      for (const arm of order) {
        const dir = join(out, mode === 'both' && !values.preflight ? `${c.name}-${runner}-${arm}` : `${c.name}-${arm}`)
        const project = join(dir, 'project')
        const home = join(dir, 'home')
        const bin = join(home, 'bin')
        mkdirSync(bin, { recursive: true })
        const configuration = { 'package.json': '{"name":"source-eval","private":true,"type":"module"}\n', 'tsconfig.json': '{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","strict":true,"noEmit":true,"skipLibCheck":true},"include":["**/*.ts","**/*.tsx"]}\n' }
        writeFiles(project, { ...source.initial, ...configuration })
        const evidence: ProjectEvidence = { initial: source.initial, expected: source.expected, baseline: diagnostics(project), configuration }
        const evidenceFile = join(dir, 'expected.json')
        writeFileSync(evidenceFile, JSON.stringify(evidence))
        const called = join(home, 'ripide.called')
        writeFileSync(join(bin, 'ripide'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shell(called)}\nexec ${shell(process.execPath)} ${shell(cli)} "$@"\n`, { mode: 0o755 })
        writeFileSync(join(bin, 'check-snapshot'), `#!/bin/sh\n${shell(process.execPath)} --experimental-strip-types ${shell(join(root, 'evals/project-check.ts'))} ${shell(project)} ${shell(evidenceFile)}\nresult=$?\nif [ "$result" -eq 0 ]; then touch ${shell(join(home, 'check.called'))}; fi\nexit "$result"\n`, { mode: 0o755 })
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider, autoupdate: false, share: 'disabled', agent: { build: { steps: 25 } }, permission: { external_directory: 'deny', task: 'deny', webfetch: 'deny', websearch: 'deny', skill: 'deny' } }), OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_SHARE: '1', PATH: `${bin}:${process.env.PATH ?? ''}` }
        delete env.OPENCODE_CONFIG
        delete env.OPENCODE_CONFIG_DIR
        delete env.OPENCODE_AUTH_CONTENT
        if (auth)
          env.OPENCODE_AUTH_CONTENT = auth
        const task = c._tag === 'Symbol' ? `Rename the ${c.from} function in ${c.declaration} to ${c.to}. Update all references and preserve aliases, strings, and comments.` : `Rename static class token ${c.from} to ${c.to} in every Vue class attribute, including variants. Preserve prose, formatting, and all other source.`
        const prompt = [task, 'This is an isolated real-project source slice, without Git or installed dependencies. Do not add dependencies or read external repositories, Skills, or the eval harness. Do not edit configuration.', arm === 'ripide' ? `Use RipIDE with this Skill. The ripide executable is on PATH.\n<skill>\n${skill}\n</skill>` : 'Use normal read, edit, and shell tools. You may write scripts. Do not use RipIDE or another refactor CLI.', 'Finish by running check-snapshot. It checks the expected source diff and compares TypeScript diagnostics against the snapshot baseline. It substitutes for Git diff and project checks here. Give a brief result.'].join('\n')
        writeFileSync(join(dir, 'prompt.txt'), prompt)
        const args = c._tag === 'Symbol' ? ['rename', c.from, c.to, '--scope', c.declaration, '--apply', '--no-vue', '--profile', 'agent'] : ['css-class-rename', c.from, c.to, '--apply', '--profile', 'agent']
        const execution = values.preflight
          ? (() => {
              const started = performance.now()
              const result = spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: 'utf8', timeout, maxBuffer: 10_000_000 })
              return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', code: result.status, timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT', seconds: (performance.now() - started) / 1000 }
            })()
          : runner === 'codex' ? await runCodex(project, prompt, env, timeout) : await runAgent(project, prompt, env, timeout)
        writeFileSync(join(dir, 'events.jsonl'), execution.stdout)
        writeFileSync(join(dir, 'stderr.log'), execution.stderr)
        const transcript = values.preflight ? { usage: null, issues: [], tools: 0, steps: 0 } : runner === 'codex' ? parseCodexEvents(execution.stdout) : parseEvents(execution.stdout)
        const issues = [...transcript.issues, ...checkProject(project, evidence)]
        if (execution.code !== 0 || execution.timedOut)
          issues.push(`Execution failed: ${execution.timedOut ? 'timeout' : execution.code}`)
        if (!values.preflight && !existsSync(join(home, 'check.called')))
          issues.push('No successful snapshot check')
        if (!values.preflight && (arm === 'ripide') !== existsSync(called))
          issues.push('Workflow adherence failed')
        const result = { caseName: c.name, runner: values.preflight ? 'cli' : runner, model: runner === 'codex' ? 'gpt-6-luna' : model, arm, passed: issues.length === 0, seconds: execution.seconds, tokens: transcript.usage?.total ?? null, issues, tools: transcript.tools, steps: transcript.steps }
        results.push(result)
        writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...result, transcript }, null, 2))
        writeFileSync(join(out, 'summary.json'), JSON.stringify(results, null, 2))
        console.log(`${c.name} ${result.runner} ${arm}: ${result.passed ? 'PASS' : 'FAIL'}, ${result.seconds.toFixed(1)}s, ${result.tokens ?? 'n/a'} tokens, ${source.changedFiles.length}/${Object.keys(source.initial).length} files${issues.length ? `, ${issues.slice(0, 5).join('; ')}` : ''}`)
      }
    }
  }
  let next = 0
  await Promise.all(Array.from({ length: Math.min(selected.length, metadata.concurrency) }, async () => {
    while (next < selected.length) {
      const index = next++
      await executeProject(selected[index]!, index)
    }
  }))
  const lines = ['# Real project source evals', '', '| Project | Runner | RipIDE pass | Agent pass | RipIDE seconds | Agent seconds | RipIDE tokens | Agent tokens |', '| --- | --- | --- | --- | --- | --- | --- | --- |']
  for (const c of selected) {
    for (const runner of new Set(results.filter(r => r.caseName === c.name).map(r => r.runner))) {
      const s = summarize(results.filter(r => r.caseName === c.name && r.runner === runner))
      lines.push(`| ${c.name} | ${runner} | ${s.ripide.passed}/${s.ripide.runs} | ${s.agent.passed}/${s.agent.runs} | ${s.ripide.seconds?.toFixed(1) ?? 'n/a'} | ${s.agent.seconds?.toFixed(1) ?? 'n/a'} | ${s.ripide.tokens ?? 'n/a'} | ${s.agent.tokens ?? 'n/a'} |`)
    }
  }
  lines.push('', 'Source slices from recorded local HEAD commits. No original project files change.', 'No dependencies or generated Nuxt state are copied. Type checks compare baseline diagnostics; these are not full project builds.', 'Vue tasks use up to ten files with static class tokens, plus up to ten unrelated files. Vue grading requires the exact expected diff.', `One run per arm and assigned runner. ${metadata.concurrency} projects run concurrently. ${mode === 'both' ? 'Starting model alternates by task. Codex runs RipIDE first; OpenCode runs ordinary editing first.' : 'Method order alternates between projects.'} Treat small timing differences as noise.`, 'Timing includes runner startup, model work, refactoring, and the requested snapshot check.', 'The revised Skill is included in the RipIDE prompt. Baseline gets ordinary editing tools. Skill loading and CLI installation are excluded.', mode === 'both' ? 'Both models use the same captured source and task. Different tool stacks and token accounting still limit cross-runner interpretation.' : 'Report comparisons within each runner. Different models and workloads prevent a direct Codex versus OpenCode speed claim.', ...results.filter(r => !r.passed).map(r => `${r.caseName} ${r.runner} ${r.arm}: ${r.issues.slice(0, 8).join('; ')}`))
  writeFileSync(join(out, 'report.md'), `${lines.join('\n')}\n`)
  console.log(lines.join('\n'))
  if (results.some(r => !r.passed))
    process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
