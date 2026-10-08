import { describe, expect, it } from 'vitest'
import { runnersForCase } from '../evals/project-plan.ts'

describe('project runner assignment', () => {
  it('runs both models on every case and alternates which model starts', () => {
    expect(runnersForCase('both', 0, 10)).toEqual(['codex', 'opencode'])
    expect(runnersForCase('both', 1, 10)).toEqual(['opencode', 'codex'])
  })

  it('preserves split assignment when a later case is filtered', () => {
    expect(runnersForCase('split', 7, 10)).toEqual(['opencode'])
    expect(runnersForCase('split', 4, 10)).toEqual(['codex'])
  })

  it('uses the selected model throughout a single-model batch', () => {
    expect(runnersForCase('codex', 9, 10)).toEqual(['codex'])
    expect(runnersForCase('opencode', 0, 10)).toEqual(['opencode'])
  })
})
