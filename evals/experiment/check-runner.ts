import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkCases } from './check-cases.ts'
import { projectContext, workflowInstructions } from './check-context.ts'

const [action, project, promptFile, task, root, model, opencode, variant = 'baseline', scope = 'slices', provenance] = process.argv.slice(2)
function run(command: string[], env = process.env) {
  const result = spawnSync(command[0], command.slice(1), { cwd: project, env, stdio: 'inherit' })
  if (result.error)
    throw result.error
  if (result.signal)
    throw new Error(`Child terminated: ${result.signal}`)
  return result.status ?? 1
}
if (action === 'setup') {
  for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.name=Eval', '-c', 'user.email=eval@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'baseline']]) {
    if (run(['git', ...args]))
      throw new Error('Git fixture setup failed.')
  }
}
else {
  const record = process.env.RIPIDE_EXPERIMENT_RECORD_DIRECTORY
  const mode = process.env.RIPIDE_EXPERIMENT_MODE
  if (!record || !provenance || !existsSync(provenance) || !mode || !['direct', 'forced', 'hybrid'].includes(mode))
    throw new Error('Supply the record directory, registered provenance, and workflow mode.')
  const baseline = join(record, 'baseline-commit.txt')
  if (action === 'preflight')
    writeFileSync(baseline, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8' }).trim(), { flag: 'wx', mode: 0o400 })
  if (!existsSync(baseline))
    throw new Error('Run fixture preflight before the workflow.')
  const home = join(record, 'home')
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  const shell = (value: string) => `'${value.replaceAll('\'', '\'\\\'\'')}'`
  const cli = join(root, 'packages/cli/bin/ripide.mjs')
  const vitest = join(project, 'node_modules/vitest/vitest.mjs')
  const wrapper = fileURLToPath(new URL('./check-command.ts', import.meta.url))
  for (const [name, path] of [['ripide', cli], ['vitest', vitest]]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nexec ${shell(process.execPath)} ${shell(wrapper)} ${shell(name)} ${shell(path)} "$@"\n`, { mode: 0o755 })
  }
  writeFileSync(join(bin, 'check-behavior'), `#!/bin/sh\nexec ${shell(process.execPath)} ${shell(fileURLToPath(new URL('./check-quality.ts', import.meta.url)))} ${shell(project)} ${shell(task)} ${shell(provenance)} ${shell(mode)}\n`, { mode: 0o755 })
  const configPath = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'opencode/opencode.json')
  const provider: unknown = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')).provider : {}
  const authPath = join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'opencode/auth.json')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_DATA_HOME: join(home, 'data'),
    XDG_STATE_HOME: join(home, 'state'),
    PATH: `${bin}:${process.env.PATH}`,
    RIPIDE_EXPERIMENT_TEST_PATH: join(project, scope === 'projects' ? projectContext(task).testPath : '.checks/proof.test.ts'),
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider, autoupdate: false, share: 'disabled', instructions: [], agent: { build: { steps: 24 } }, permission: { task: 'deny', external_directory: 'deny', webfetch: 'deny', websearch: 'deny', skill: 'deny' } }),
    ...(existsSync(authPath) ? { OPENCODE_AUTH_CONTENT: readFileSync(authPath, 'utf8') } : {}),
  }
  delete env.OPENCODE_CONFIG
  delete env.OPENCODE_CONFIG_DIR
  const smoke = spawnSync('sh', ['-c', 'pwd; test -t 0 || test -r /dev/null; command -v node; command -v vitest'], { cwd: project, env, encoding: 'utf8' })
  writeFileSync(join(record, 'shell-preflight.json'), JSON.stringify({ arguments: ['sh', '-c', 'pwd; test -t 0 || test -r /dev/null; command -v node; command -v vitest'], status: smoke.status, stdout: smoke.stdout, stderr: smoke.stderr }), { mode: 0o600 })
  if (smoke.error)
    throw smoke.error
  if (smoke.status)
    throw new Error('Child shell preflight failed.')
  for (const [name, command] of [
    ['pty', ['script', '-q', '-c', 'test -t 0 && test -t 1 && node --version', '/dev/null']],
    ['native-agent', [opencode, 'debug', '--pure', 'agent', 'build']],
    ['native-skills', [opencode, 'debug', '--pure', 'skill']],
  ] as const) {
    const checked = spawnSync(command[0], command.slice(1), { cwd: project, env, encoding: 'utf8' })
    writeFileSync(join(record, `${name}-preflight.json`), JSON.stringify({ arguments: command, status: checked.status, stdout: checked.stdout, stderr: checked.stderr }), { mode: 0o600 })
    if (checked.error)
      throw checked.error
    if (checked.status)
      throw new Error(`Child ${name} preflight failed.`)
  }
  if (action === 'preflight')
    process.exit(0)
  const prompt = readFileSync(promptFile, 'utf8')
  const scenario = checkCases.find(row => row.id === task)!
  const text = `${prompt}\n\n${workflowInstructions(action, scenario, scope, variant)}`
  writeFileSync(join(record, 'effective-prompt.txt'), text, { mode: 0o600 })
  // A fixed title avoids an unrelated title-model request during evaluation.
  process.exitCode = run([opencode, 'run', '--pure', '--auto', '--title', 'ripide eval', '--format', 'json', '--dir', project, '-m', model, text], env)
}
