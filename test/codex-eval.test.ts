import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCodexConfig, parseCodexEvents, runCodex } from '../evals/codex-runner.ts'

describe('codex eval configuration', () => {
  it('preserves the historical defaults', () => {
    expect(parseCodexConfig({})).toEqual({ codexModel: 'gpt-6-luna', codexReasoning: 'medium' })
  })

  it.each([
    { model: '' },
    { model: '   ' },
    { model: 42 },
    { model: null },
    { reasoning: 'maximum' },
    { reasoning: 'high"' },
    { reasoning: null },
  ])('rejects invalid configuration before execution: %j', (input) => {
    expect(() => parseCodexConfig(input)).toThrow(/--codex-/)
  })

  it('rejects invalid CLI settings before source setup or model dispatch', () => {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', 'evals/projects.ts', '--runner', 'both', '--codex-reasoning', 'maximum'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('--codex-reasoning requires')
    expect(result.stdout).not.toContain('Results:')
  })

  it('uses the recorded model and reasoning in the spawned command', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ripide-codex-config-'))
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const fake = join(dir, 'fake-codex.ts')
    writeFileSync(fake, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))\n')
    writeFileSync(join(bin, 'codex'), `#!/bin/sh\nexec '${process.execPath}' --experimental-strip-types '${fake}' "$@"\n`, { mode: 0o755 })
    try {
      const config = parseCodexConfig({ model: 'gpt-6.1-sol', reasoning: 'high' })
      const result = await runCodex(dir, 'No model call', { PATH: bin, CODEX_HOME: dir }, 5000, config)
      const args = JSON.parse(result.stdout) as string[]
      expect(result.code).toBe(0)
      expect(args[args.indexOf('-m') + 1]).toBe(result.configuration.codexModel)
      expect(args).toContain(`model_reasoning_effort="${result.configuration.codexReasoning}"`)
      expect(result.configuration).toEqual({ codexModel: 'gpt-6.1-sol', codexReasoning: 'high' })
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('codex eval events', () => {
  it('counts cached input and reasoning output once', () => {
    const event = { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 10, output_tokens: 20, reasoning_output_tokens: 5 } }
    expect(parseCodexEvents(JSON.stringify(event)).usage).toEqual({ input: 30, cacheRead: 60, cacheWrite: 10, output: 15, reasoning: 5, total: 120, cost: 0 })
  })

  it.each([
    { input_tokens: 100, output_tokens: 20 },
    { input_tokens: 100, cached_input_tokens: 101, output_tokens: 20 },
    { input_tokens: -1, cached_input_tokens: 0, output_tokens: 20 },
  ])('rejects malformed usage %j', (usage) => {
    const result = parseCodexEvents(JSON.stringify({ type: 'turn.completed', usage }))
    expect(result.usage).toBeNull()
    expect(result.issues).toContain('Incomplete or invalid Codex token usage event')
  })

  it('reports provider failures and absent usage', () => {
    const result = parseCodexEvents('{"type":"turn.failed","error":{"message":"Rate limit"}}\n')
    expect(result.issues).toEqual(['Codex error: {"message":"Rate limit"}', 'No token usage events'])
    expect(result.usage).toBeNull()
  })

  it('counts completed commands once and preserves their text', () => {
    const started = { type: 'item.started', item: { id: 'one', type: 'command_execution', command: 'check-snapshot' } }
    const completed = { ...started, type: 'item.completed' }
    const result = parseCodexEvents(`${JSON.stringify(started)}\n${JSON.stringify(completed)}\n`)
    expect(result.tools).toBe(1)
    expect(result.commands).toEqual(['check-snapshot'])
  })
})
