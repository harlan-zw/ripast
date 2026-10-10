import { describe, expect, it } from 'vitest'
import { checkCases } from '../evals/experiment/check-cases.ts'
import { checkPrompt, workflowInstructions } from '../evals/experiment/check-context.ts'

describe('check workflow context', () => {
  it('distinguishes the repaired guard from the checked caller', () => {
    const prompt = checkPrompt(checkCases.find(row => row.id === 'unhead-real-caller')!)
    expect(prompt).toContain('Repair source: packages/unhead/src/utils/unsafeKey.ts.')
    expect(prompt).toContain('Selected export: walkResolver. Source: packages/unhead/src/utils/walkResolver.ts.')
  })

  it('runs the selected export from its known source file', () => {
    const context = workflowInstructions('forced', checkCases.find(row => row.id === 'unhead-real-caller')!, 'projects', 'guided')
    expect(context).toContain('check walkResolver --from packages/unhead/src/utils/walkResolver.ts')
  })
})
