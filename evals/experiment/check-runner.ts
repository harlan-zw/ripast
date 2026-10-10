import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [action, project, promptFile, task, root, model, opencode] = process.argv.slice(2)
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
  const record = process.env.RIPIDE_EXPERIMENT_RECORD_DIRECTORY!
  const home = join(record, 'home')
  const bin = join(home, 'bin')
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  const shell = (value: string) => `'${value.replaceAll('\'', '\'\\\'\'')}'`
  const cli = join(root, 'packages/cli/bin/ripide.mjs')
  const vitest = join(project, 'node_modules/vitest/vitest.mjs')
  for (const [name, path] of [['ripide', cli], ['vitest', vitest]]) {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' ${shell(name)} >> ${shell(join(record, 'commands.called'))}\nexec ${shell(process.execPath)} ${shell(path)} "$@"\n`, { mode: 0o755 })
  }
  writeFileSync(join(bin, 'check-behavior'), `#!/bin/sh\nexec ${shell(process.execPath)} ${shell(fileURLToPath(new URL('./check-quality.ts', import.meta.url)))} ${shell(project)} ${shell(task)}\n`, { mode: 0o755 })
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
  if (process.argv[9] === 'preflight')
    process.exit(0)
  const prompt = readFileSync(promptFile, 'utf8')
  const commands: Record<string, string> = {
    direct: 'Use ordinary Vitest through the supplied vitest executable. Write temporary .checks/*.test.ts modules with explicit imports. Run vitest run --reporter=json --outputFile=.checks/red.json for the failing case. Save green.json similarly after repair. Delete every test module after the final passing run. Do not use ripide.',
    forced: 'Use ripide check SYMBOL --json --artifact .checks/red.json with TypeScript on stdin. The CLI imports SYMBOL, test, expect, and vi unless already declared. Relative imports and mocks resolve beside the selected source file. Save green.json after repair. Remove an existing artifact before reusing its path. Do not create test files. Pass --from only for ambiguity.',
    hybrid: 'Choose ordinary Vitest with temporary test modules or ripide check with TypeScript on stdin. Ripide imports missing bindings for the selected function, test, expect, and vi. Its relative imports and mocks resolve beside the selected source file. Preserve failing and passing JSON in .checks/red.json and .checks/green.json. Remove existing artifacts before reusing their paths. Delete all temporary test modules after checks.',
  }
  const text = `${prompt}\n\n${commands[action]}\nOnly .checks may hold temporary helpers and JSON evidence. Finish by running check-behavior. Do not read external repositories or harness files. Give a brief result.`
  writeFileSync(join(record, 'effective-prompt.txt'), text, { mode: 0o600 })
  process.exitCode = run([opencode, 'run', '--pure', '--auto', '--format', 'json', '--dir', project, '-m', model, text], env)
}
