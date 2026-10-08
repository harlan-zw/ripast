import type { Usage } from './core.ts'
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export const codexModel = 'gpt-6-luna'
export const codexReasoning = 'medium'

/** Keep user Skills and configuration out of both arms. Copy authentication into the isolated home. */
export async function runCodex(project: string, prompt: string, env: NodeJS.ProcessEnv, timeout: number): Promise<{ stdout: string, stderr: string, code: number | null, seconds: number, timedOut: boolean }> {
  const isolated = mkdtempSync(join(tmpdir(), 'ripast-codex-'))
  const codexHome = join(isolated, '.codex')
  mkdirSync(codexHome)
  const auth = join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json')
  if (existsSync(auth)) {
    copyFileSync(auth, join(codexHome, 'auth.json'))
    chmodSync(join(codexHome, 'auth.json'), 0o600)
  }
  const executionEnv = { ...env, HOME: isolated, CODEX_HOME: codexHome, XDG_CONFIG_HOME: join(isolated, '.config') }
  try {
    return await new Promise((done, reject) => {
      const started = performance.now()
      const child = spawn('codex', [
        'exec',
        '--ignore-user-config',
        '--ignore-rules',
        '--ephemeral',
        '--skip-git-repo-check',
        '--json',
        '--color',
        'never',
        '-m',
        codexModel,
        '-c',
        `model_reasoning_effort="${codexReasoning}"`,
        '-c',
        'approval_policy="never"',
        '-c',
        'project_doc_max_bytes=0',
        '-s',
        // Match OpenCode execution: CLI compiler verification launches nested processes.
        // Both runners receive source copies. Prompts restrict edits to those copies.
        'danger-full-access',
        '-C',
        project,
        ...(env.HOME ? ['--add-dir', env.HOME] : []),
        prompt,
      ], { env: executionEnv, cwd: project, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
        clearTimeout(force)
        reject(error)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        clearTimeout(force)
        done({ stdout, stderr, code, timedOut, seconds: (performance.now() - started) / 1000 })
      })
    })
  }
  finally {
    rmSync(isolated, { recursive: true, force: true })
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function parseCodexEvents(jsonl: string): { usage: Usage | null, steps: number, tools: number, commands: string[], issues: string[] } {
  const usage: Usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 }
  let steps = 0
  let tools = 0
  const commands: string[] = []
  const issues: string[] = []
  for (const [index, line] of jsonl.split('\n').entries()) {
    if (!line.trim())
      continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    }
    catch {
      issues.push(`Invalid JSON event on line ${index + 1}`)
      continue
    }
    const event = record(parsed)
    if (event.type === 'error' || event.type === 'turn.failed')
      issues.push(`Codex error: ${JSON.stringify(event.error ?? event.message)}`)
    const item = record(event.item)
    if (event.type === 'item.completed' && ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(String(item.type))) {
      tools++
      if (typeof item.command === 'string')
        commands.push(item.command)
    }
    if (event.type !== 'turn.completed')
      continue
    const tokens = record(event.usage)
    const input = tokens.input_tokens
    const output = tokens.output_tokens
    const cacheRead = tokens.cached_input_tokens
    const cacheWrite = tokens.cache_write_input_tokens ?? 0
    const reasoning = tokens.reasoning_output_tokens ?? 0
    if (![input, output, cacheRead, cacheWrite, reasoning].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)
      || (cacheRead as number) + (cacheWrite as number) > (input as number) || (reasoning as number) > (output as number)) {
      issues.push('Incomplete or invalid Codex token usage event')
      continue
    }
    steps++
    // Codex input and output already include cache and reasoning subsets.
    // Normalize categories to the disjoint OpenCode Usage shape, without double counting.
    usage.input += (input as number) - (cacheRead as number) - (cacheWrite as number)
    usage.output += (output as number) - (reasoning as number)
    usage.reasoning += reasoning as number
    usage.cacheRead += cacheRead as number
    usage.cacheWrite += cacheWrite as number
    usage.total += (input as number) + (output as number)
  }
  if (!steps)
    issues.push('No token usage events')
  return { usage: steps ? usage : null, steps, tools, commands, issues }
}
