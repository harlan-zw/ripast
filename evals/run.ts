import type { Arm, CaseName, EvalCase, Measurement } from './core.ts'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { caseNames, gradeFiles, makeCase, parseEvents, summarize } from './core.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function integer(value: string, option: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${option} requires a positive integer`)
  return parsed
}

function commandVersion(command: string, args = ['--version']): string {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.error || result.status !== 0)
    throw new Error(`Cannot run ${command}: ${result.error?.message ?? result.stderr}`)
  return result.stdout.trim()
}

function writeFiles(dir: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
}

function readFiles(dir: string, prefix = ''): Record<string, string> {
  if (!existsSync(dir))
    return {}
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? Object.entries(readFiles(join(dir, entry.name), `${prefix}${entry.name}/`))
      : [[`${prefix}${entry.name}`, readFileSync(join(dir, entry.name), 'utf8')]],
  ))
}

function run(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null, timedOut: boolean, stdout: string, stderr: string, seconds: number }> {
  return new Promise((done, reject) => {
    const started = performance.now()
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const kill = (signal: NodeJS.Signals) => {
      if (child.pid) {
        try {
          process.kill(-child.pid, signal)
        }
        catch (error) {
          // The process can exit between the timer firing and the signal.
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            throw error
        }
      }
    }
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    const timer = setTimeout(() => {
      timedOut = true
      kill('SIGTERM')
      forceTimer = setTimeout(kill, 3000, 'SIGKILL')
    }, timeoutMs)
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
      clearTimeout(forceTimer)
      done({ code, timedOut, stdout, stderr, seconds: (performance.now() - started) / 1000 })
    })
  })
}

interface Result extends Measurement {
  caseName: CaseName
  repetition: number
  code: number | null
  timedOut: boolean
  issues: string[]
  transcript: ReturnType<typeof parseEvents>
  checkSeconds: number
}

function format(value: number | null, digits = 1): string {
  return value === null ? 'n/a' : value.toFixed(digits)
}

async function main() {
  const { values } = parseArgs({ options: {
    model: { type: 'string', default: 'zai-coding-plan/glm-5.3-flash' },
    runs: { type: 'string', default: '2' },
    consumers: { type: 'string', default: '12' },
    timeout: { type: 'string', default: '300' },
    case: { type: 'string' },
    arm: { type: 'string', default: 'both' },
    out: { type: 'string' },
    preflight: { type: 'boolean', default: false },
    skill: { type: 'string' },
  } })
  const repetitions = integer(values.runs, '--runs')
  const consumers = integer(values.consumers, '--consumers')
  const timeout = integer(values.timeout, '--timeout') * 1000
  if (values.case && !caseNames.includes(values.case as CaseName))
    throw new Error(`Unknown case: ${values.case}`)
  if (!['both', 'agent', 'ripast'].includes(values.arm))
    throw new Error('--arm requires both, agent, or ripast')
  const arms: Arm[] = values.arm === 'both' ? ['ripast', 'agent'] : [values.arm as Arm]
  const cases = (values.case ? [values.case as CaseName] : caseNames).map(name => makeCase(name, consumers))
  const skill = values.skill ? readFileSync(values.skill === 'current' ? join(root, 'packages/cli/skills/ripast/SKILL.md') : resolve(values.skill), 'utf8') : null
  const cli = join(root, 'packages/cli/bin/ripast.mjs')
  if (!existsSync(join(root, 'packages/cli/dist/cli.mjs')))
    throw new Error('If the CLI build is missing, run pnpm build')
  const tsc = join(root, 'node_modules/@typescript/native/bin/tsc')
  if (!existsSync(tsc))
    throw new Error('If the compiler is missing, run pnpm install')
  const scratch = join(homedir(), 'scratch')
  mkdirSync(scratch, { recursive: true })
  const out = values.out ? resolve(values.out) : mkdtempSync(join(scratch, 'ripast-evals-'))
  if (existsSync(out) && readdirSync(out).length)
    throw new Error('If the output directory contains files, choose a fresh --out directory')
  mkdirSync(out, { recursive: true })
  const metadata = {
    model: values.model,
    repetitions,
    consumers,
    opencode: values.preflight ? null : commandVersion('opencode'),
    node: process.version,
    ripast: (JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8')) as { version: string }).version,
    revision: commandVersion('git', ['-C', root, 'rev-parse', 'HEAD']),
    started: new Date().toISOString(),
    timeoutMs: timeout,
    preflight: values.preflight,
    skillHash: skill ? createHash('sha256').update(skill).digest('hex') : null,
  }
  writeFileSync(join(out, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  // Read only provider settings. Do not inherit global plugins, MCP, instructions, or Skills.
  const configFile = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode/opencode.json')
  const provider: unknown = existsSync(configFile) ? (JSON.parse(readFileSync(configFile, 'utf8')) as { provider?: unknown }).provider : {}
  const authFile = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'opencode/auth.json')
  const auth = existsSync(authFile) ? readFileSync(authFile, 'utf8') : null
  const results: Result[] = []
  console.log(`Results: ${out}`)

  async function execute(evalCase: EvalCase, arm: Arm, repetition: number) {
    const dir = join(out, `${evalCase.name}-${arm}-${repetition}`)
    const project = join(dir, 'project')
    const home = join(dir, 'home')
    const bin = join(home, 'bin')
    mkdirSync(bin, { recursive: true })
    const tsconfig = `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true }, include: ['src/**/*.ts'] }, null, 2)}\n`
    const pkg = '{"name":"refactor-fixture","private":true,"type":"module"}\n'
    writeFiles(project, { ...evalCase.initial, 'tsconfig.json': tsconfig, 'package.json': pkg })
    // A local launcher avoids npm install time and measures this exact checkout.
    writeFileSync(join(bin, 'ripast'), `#!/bin/sh\nexec '${process.execPath.replaceAll('\'', '\'\\\'\'')}' '${cli.replaceAll('\'', '\'\\\'\'')}' "$@"\n`, { mode: 0o755 })
    const config = {
      $schema: 'https://opencode.ai/config.json',
      provider: provider ?? {},
      autoupdate: false,
      share: 'disabled',
      agent: { build: { steps: 30 } },
      permission: { external_directory: 'deny', task: 'deny', webfetch: 'deny', websearch: 'deny', skill: 'deny' },
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: join(home, 'config'),
      XDG_DATA_HOME: join(home, 'data'),
      XDG_STATE_HOME: join(home, 'state'),
      XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
      OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
      OPENCODE_DISABLE_CLAUDE_CODE: '1',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
      OPENCODE_DISABLE_SHARE: '1',
      PATH: `${bin}:${process.env.PATH ?? ''}`,
    }
    delete env.OPENCODE_CONFIG
    delete env.OPENCODE_CONFIG_DIR
    delete env.OPENCODE_AUTH_CONTENT
    if (auth)
      env.OPENCODE_AUTH_CONTENT = auth
    const checkCommand = `node '${tsc}' --noEmit`
    const prompt = [
      evalCase.task,
      'Preserve the unrelated calculateTotal in src/decoy.ts and the string in src/labels.ts.',
      'Do not change configuration or add dependencies. Work only in this fixture. Do not read external Skills or repositories.',
      arm === 'ripast' && skill
        ? `Use the provided Ripast Skill. The ripast executable is on PATH.\n<skill>\n${skill}\n</skill>`
        : arm === 'ripast'
          ? `Use the local ripast CLI for this refactor. It is on PATH. Run: ${evalCase.command}. You may inspect files and use --help.`
          : 'Use your normal read, edit, and shell tools. You may write scripts. Do not use Ripast or another refactor CLI.',
      `After the refactor, run this typecheck: ${checkCommand}. Give a brief result.`,
    ].join('\n')
    writeFileSync(join(dir, 'prompt.txt'), prompt)
    const execution = values.preflight
      ? await run('ripast', evalCase.command.split(' ').slice(1), project, env, timeout)
      : await run('opencode', ['run', '--format', 'json', '--dir', project, '--auto', '--pure', '-m', values.model, prompt], project, env, timeout)
    writeFileSync(join(dir, 'events.jsonl'), execution.stdout)
    writeFileSync(join(dir, 'stderr.log'), execution.stderr)
    const transcript = values.preflight ? { usage: null, steps: 0, tools: 0, commands: [evalCase.command], issues: [] } : parseEvents(execution.stdout)
    const check = await run(process.execPath, [tsc, '--noEmit'], project, env, 30_000)
    writeFileSync(join(dir, 'typecheck.log'), check.stdout + check.stderr)
    const issues = [...transcript.issues, ...gradeFiles(evalCase.expected, readFiles(join(project, 'src'), 'src/'))]
    if (execution.timedOut || execution.code !== 0)
      issues.push(`Run failed: ${execution.timedOut ? 'timeout' : execution.code}`)
    if (check.timedOut || check.code !== 0)
      issues.push('Typecheck failed')
    if (readFileSync(join(project, 'tsconfig.json'), 'utf8') !== tsconfig || readFileSync(join(project, 'package.json'), 'utf8') !== pkg)
      issues.push('Configuration changed')
    const usedRipast = transcript.commands.some(c => /\bripast(?:\s|$)/.test(c))
    if (arm === 'ripast' && !usedRipast)
      issues.push('Ripast arm did not invoke Ripast')
    if (arm === 'agent' && usedRipast)
      issues.push('Agent arm invoked Ripast')
    if (!values.preflight && !transcript.commands.some(c => c.includes(tsc) && c.includes('--noEmit')))
      issues.push('Agent did not run the requested typecheck')
    const result: Result = {
      caseName: evalCase.name,
      arm,
      repetition,
      passed: issues.length === 0,
      seconds: execution.seconds,
      tokens: transcript.usage?.total ?? null,
      code: execution.code,
      timedOut: execution.timedOut,
      issues,
      transcript,
      checkSeconds: check.seconds,
    }
    results.push(result)
    writeFileSync(join(dir, 'run.json'), `${JSON.stringify(result, null, 2)}\n`)
    writeFileSync(join(out, 'summary.json'), `${JSON.stringify(results, null, 2)}\n`)
    console.log(`${evalCase.name} ${arm} #${repetition}: ${result.passed ? 'PASS' : 'FAIL'}, ${format(result.seconds)}s, ${result.tokens ?? 'n/a'} tokens${issues.length ? `, ${issues.join('; ')}` : ''}`)
  }

  // Sequential runs avoid competition for CPU. Alternate the first arm to reduce ordering bias.
  for (let repetition = 1; repetition <= (values.preflight ? 1 : repetitions); repetition++) {
    for (const [index, evalCase] of cases.entries()) {
      const order = values.preflight ? ['ripast' as const] : (repetition + index) % 2 ? arms : [...arms].reverse()
      for (const arm of order)
        await execute(evalCase, arm, repetition)
    }
  }
  const lines = [
    '# Ripast OpenCode eval',
    '',
    `Model: ${metadata.model}. OpenCode: ${metadata.opencode}. Consumers per task: ${consumers}.`,
    `Revision: ${metadata.revision}. Repetitions: ${values.preflight ? 1 : repetitions}.`,
    '',
    '| Task | Ripast pass | Agent pass | Ripast seconds | Agent seconds | Speedup | Ripast tokens | Agent tokens | Token reduction |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const evalCase of cases) {
    const s = summarize(results.filter(r => r.caseName === evalCase.name))
    lines.push(`| ${evalCase.name} | ${s.ripast.passed}/${s.ripast.runs} | ${s.agent.passed}/${s.agent.runs} | ${format(s.ripast.seconds)} | ${format(s.agent.seconds)} | ${s.speedup === null ? 'n/a' : `${format(s.speedup, 2)}x`} | ${format(s.ripast.tokens, 0)} | ${format(s.agent.tokens, 0)} | ${s.tokenReduction === null ? 'n/a' : `${format(s.tokenReduction * 100)}%`} |`)
  }
  lines.push('', 'Times and tokens use medians of correct runs only. Compare each task separately.', 'Time includes OpenCode startup, agent inspection, refactor, and the requested typecheck. The independent grading check is excluded.', 'Tokens include input, output, reasoning, cache reads, and cache writes. Raw categories and provider cost remain in run.json.', 'Cache state is shared. Repetition order alternates. This is a small synthetic sample, not a general speed claim.', 'The CLI is prebuilt. Dependency installation and Skill loading are excluded. Each arm receives direct workflow instructions.', 'AST checks accept formatting and quote changes. They preserve symbols, aliases, imports, and strings. Comments are not graded.', '', ...results.filter(r => !r.passed).map(r => `- ${r.caseName} ${r.arm} #${r.repetition}: ${r.issues.join('; ')}`))
  writeFileSync(join(out, 'report.md'), `${lines.join('\n')}\n`)
  console.log(lines.join('\n'))
  if (results.some(r => !r.passed))
    process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
