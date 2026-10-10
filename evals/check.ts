import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { buildCheckChecklist, runCheck } from '../packages/cli/src/check.ts'
import { parseEvents } from './core.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessHash = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
const { values } = parseArgs({ options: {
  model: { type: 'string', default: 'zai-coding-plan/glm-5.3-flash' },
  timeout: { type: 'string', default: '240' },
  out: { type: 'string' },
  preflight: { type: 'boolean', default: false },
} })
const timeoutMs = Number(values.timeout) * 1000
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000)
  throw new Error('Pass a positive timeout in seconds.')
const scratch = join(homedir(), 'scratch')
mkdirSync(scratch, { recursive: true })
const out = values.out ? resolve(values.out) : mkdtempSync(join(scratch, 'ripide-check-evals-'))
if (existsSync(out) && readdirSync(out).length)
  throw new Error('Choose an empty output directory.')
mkdirSync(out, { recursive: true })
const configPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode/opencode.json')
const provider: unknown = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')).provider : {}
const authPath = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'opencode/auth.json')
const auth = existsSync(authPath) ? readFileSync(authPath, 'utf8') : undefined
const cli = join(root, 'packages/cli/bin/ripide.mjs')
const cases = [
  {
    name: 'boundary',
    symbol: 'clamp',
    from: 'value.ts',
    files: { 'value.ts': 'export function clamp(value: number, maximum: number) { return Math.min(value, maximum) }\n' },
    task: 'Fix clamp. It must clamp into [0, maximum]. Demonstrate a failing negative-input check before editing.',
    correction: 'export function clamp(value: number, maximum: number) { return Math.max(0, Math.min(value, maximum)) }\n',
    red: 'test(\'negative\', () => expect(clamp(-2, 10)).toBe(0))',
    green: 'test(\'boundaries\', () => { expect(clamp(-2, 10)).toBe(0); expect(clamp(5, 10)).toBe(5); expect(clamp(20, 10)).toBe(10) })',
  },
  {
    name: 'mock',
    symbol: 'double',
    from: 'service.ts',
    files: { 'dependency.ts': 'export function read() { throw new Error("No network in eval") }\n', 'service.ts': 'import { read } from "./dependency.ts"\nexport function double() { return read() }\n' },
    task: 'Fix double. It must return twice the dependency result. Mock read with native vi.mock. The real dependency must not run.',
    correction: 'import { read } from "./dependency.ts"\nexport function double() { return read() * 2 }\n',
    red: 'vi.mock(\'./dependency.ts\', () => ({ read: () => 7 }))\ntest(\'double\', () => expect(double()).toBe(14))',
    green: 'vi.mock(\'./dependency.ts\', () => ({ read: () => 7 }))\ntest(\'double\', () => expect(double()).toBe(14))',
  },
  {
    name: 'integration-stale',
    symbol: 'display',
    from: 'consumer.ts',
    files: { 'value.ts': 'export function positive(value: number) { return value }\n', 'consumer.ts': 'import { positive } from "./value.ts"\nexport function display(value: number) { return "value:" + positive(value) }\n' },
    task: 'Fix positive to return an absolute value. Check display through the real positive function. Then edit positive again to an equivalent implementation. Save a checklist showing stale evidence. Recheck display.',
    correction: 'export function positive(value: number) { return Math.abs(value) }\n',
    red: 'test(\'real caller\', () => expect(display(-3)).toBe(\'value:3\'))',
    green: 'test(\'real caller\', () => { expect(display(-3)).toBe(\'value:3\'); expect(display(2)).toBe(\'value:2\') })',
  },
]

function command(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  if (result.error || result.status !== 0)
    throw new Error(`${command} failed: ${result.error?.message ?? result.stderr}`)
  return result.stdout
}
function shell(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}
function runtimeHash(): string {
  const digest = createHash('sha256')
  for (const directory of ['packages/cli/dist', 'packages/core/dist', 'packages/cli/bin']) {
    const absolute = join(root, directory)
    const files = readdirSync(absolute, { recursive: true, withFileTypes: true }).filter(entry => !entry.isDirectory()).map(entry => join(entry.parentPath, entry.name)).sort()
    for (const file of files) digest.update(file).update(readFileSync(file))
  }
  return digest.digest('hex')
}
async function agent(prompt: string, cwd: string, env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean }>((done, reject) => {
    const child = spawn('opencode', ['run', '--pure', '--auto', '--format', 'json', '--dir', cwd, '-m', values.model!, prompt], { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
        }
        else {
          try {
            process.kill(-child.pid, 'SIGKILL')
          }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
              reject(error)
          }
        }
      }
    }, timeoutMs)
    child.stdout.on('data', chunk => stdout += chunk)
    child.stderr.on('data', chunk => stderr += chunk)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, stdout, stderr, timedOut })
    })
  })
}
async function main() {
  const results = []
  const metadata = {
    model: values.model,
    preflight: values.preflight,
    revision: command('git', ['rev-parse', 'HEAD'], root).trim(),
    harnessHash,
    runtimeHash: runtimeHash(),
    opencode: values.preflight ? null : command('opencode', ['--version'], root).trim(),
  }
  writeFileSync(join(out, 'metadata.json'), JSON.stringify(metadata, null, 2))
  console.log(`Evidence: ${out}`)
  for (const scenario of cases) {
    const directory = join(out, scenario.name)
    const project = join(directory, 'project')
    const home = join(directory, 'home')
    const bin = join(home, 'bin')
    mkdirSync(project, { recursive: true })
    mkdirSync(bin, { recursive: true })
    for (const [file, source] of Object.entries(scenario.files))
      writeFileSync(join(project, file), source)
    writeFileSync(join(project, 'package.json'), '{"type":"module","private":true}\n')
    command('git', ['init', '--quiet'], project)
    command('git', ['add', '.'], project)
    command('git', ['-c', 'user.name=Eval', '-c', 'user.email=eval@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'baseline'], project)
    // Seed a real working change so the initial checklist has an obligation.
    writeFileSync(join(project, scenario.from), `${readFileSync(join(project, scenario.from), 'utf8')}\n`)
    writeFileSync(join(bin, 'ripide'), `#!/bin/sh\nexec ${shell(process.execPath)} ${shell(cli)} "$@"\n`, { mode: 0o755 })
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data'), XDG_STATE_HOME: join(home, 'state'), PATH: `${bin}:${process.env.PATH}`, OPENCODE_DISABLE_EXTERNAL_SKILLS: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider, autoupdate: false, share: 'disabled', agent: { build: { steps: 24 } }, permission: { task: 'deny', external_directory: 'deny', webfetch: 'deny', websearch: 'deny', skill: 'deny' } }), ...(auth ? { OPENCODE_AUTH_CONTENT: auth } : {}) }
    delete env.OPENCODE_CONFIG
    delete env.OPENCODE_CONFIG_DIR
    const prompt = `${scenario.task}\nUse ripide check. Tests go through stdin. Do not create test files or install dependencies.\nFor a named export: ripide check NAME --base HEAD --json --artifact red.json <<'TS'\ntest('behaviour', () => expect(NAME(...)).toBe(...))\nTS\nThe CLI imports the selected function, test, expect, and vi. Supply top-level vi.mock before test blocks.\nSave the failing check to red.json, the final passing check to green.json, and a final checklist with ripide check --base HEAD --json --artifact checklist.json. For the stale task, save stale.json after the equivalent edit and before rechecking. Artifacts may stay in the project. Do not read external files or the evaluator. Give a brief result.`
    const started = performance.now()
    const beforeRuntime = runtimeHash()
    let execution = { code: 0 as number | null, stdout: '', stderr: '', timedOut: false }
    if (values.preflight) {
      const red = await runCheck({ cwd: project, symbol: scenario.symbol, from: scenario.from, base: 'HEAD', source: scenario.red })
      writeFileSync(join(project, 'red.json'), JSON.stringify({ data: red }))
      writeFileSync(join(project, scenario.name === 'integration-stale' ? 'value.ts' : scenario.from), scenario.correction)
      const green = await runCheck({ cwd: project, symbol: scenario.symbol, from: scenario.from, base: 'HEAD', source: scenario.green })
      writeFileSync(join(project, 'green.json'), JSON.stringify({ data: green }))
      if (scenario.name === 'integration-stale') {
        writeFileSync(join(project, 'value.ts'), `${scenario.correction}\n`)
        writeFileSync(join(project, 'stale.json'), JSON.stringify({ data: { checklist: buildCheckChecklist({ cwd: project }) } }))
        await runCheck({ cwd: project, symbol: scenario.symbol, from: scenario.from, base: 'HEAD', source: scenario.green })
      }
      writeFileSync(join(project, 'checklist.json'), JSON.stringify({ data: { checklist: buildCheckChecklist({ cwd: project }) } }))
    }
    else {
      execution = await agent(prompt, project, env)
    }
    writeFileSync(join(directory, 'transcript.jsonl'), execution.stdout, { mode: 0o600 })
    writeFileSync(join(directory, 'stderr.txt'), execution.stderr, { mode: 0o600 })
    const issues: string[] = []
    const report = (file: string): { result?: { _tag: string }, checklist?: { items: { status: string }[] } } => {
      if (!existsSync(join(project, file)))
        return {}
      const value = JSON.parse(readFileSync(join(project, file), 'utf8'))
      return value.data ?? value
    }
    if (runtimeHash() !== beforeRuntime)
      issues.push('The runtime changed during the eval. Reject this attempt.')
    if (execution.code !== 0 || execution.timedOut)
      issues.push('Agent execution failed or timed out.')
    if (report('red.json').result?._tag !== 'Failed')
      issues.push('No failing assertion evidence.')
    if (report('green.json').result?._tag !== 'Passed')
      issues.push('No passing assertion evidence.')
    if (!report('checklist.json').checklist)
      issues.push('No checklist evidence.')
    if (scenario.name === 'integration-stale' && !report('stale.json').checklist?.items.some((item: { status: string }) => item.status === 'stale'))
      issues.push('No stale evidence after editing.')
    const extraFiles = command('git', ['ls-files', '--others', '--exclude-standard'], project).trim().split('\n').filter(file => file && !['red.json', 'green.json', 'checklist.json', 'stale.json'].includes(file))
    if (extraFiles.length)
      issues.push(`Unexpected files: ${extraFiles.join(', ')}`)
    const independent = await runCheck({ cwd: project, symbol: scenario.symbol, from: scenario.from, source: scenario.green })
    if (independent._tag !== 'Run' || independent.result._tag !== 'Passed')
      issues.push('Independent behaviour check failed.')
    const transcript = parseEvents(execution.stdout)
    if (!values.preflight && !transcript.commands.some(command => command.includes('ripide check')))
      issues.push('Agent did not invoke ripide check.')
    const result = { name: scenario.name, passed: issues.length === 0, issues, runtimeHash: beforeRuntime, seconds: (performance.now() - started) / 1000, usage: transcript.usage, commands: transcript.commands }
    results.push(result)
    console.log(`${scenario.name}: ${result.passed ? 'PASS' : 'FAIL'}${issues.length ? `: ${issues.join(' ')}` : ''}`)
  }
  writeFileSync(join(out, 'results.json'), JSON.stringify({ ...metadata, results }, null, 2))
  if (results.some(result => !result.passed))
    process.exitCode = 1
}
void main()
