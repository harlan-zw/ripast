import { describe, expect, it } from 'vitest'
import { parseCodexEvents } from '../evals/codex-runner.ts'

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
