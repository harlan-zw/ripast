import type { CheckCase } from './check-cases.ts'

export function projectContext(id: string) {
  if (id === 'link-checker-concurrency') {
    return {
      args: ['--project', 'unit'],
      testPath: 'test/unit/transient-eval.test.ts',
      prepare: [['pnpm', 'build'], ['pnpm', 'typecheck']],
      checks: [['pnpm', 'build'], ['pnpm', 'typecheck']],
      generated: ['dist', 'playground/.nuxt', 'playground/node_modules', '.nuxt'],
    }
  }
  if (id === 'unhead-real-caller') {
    const typecheck = ['pnpm', 'typecheck', '--incremental', '--tsBuildInfoFile', '.checks/types.tsbuildinfo']
    return {
      args: ['--config', 'packages/unhead/vitest.config.ts'],
      testPath: 'packages/unhead/test/transient-eval.test.ts',
      prepare: [['pnpm', 'build'], typecheck],
      checks: [['pnpm', 'build'], typecheck],
      generated: ['angular', 'bundler', 'cli', 'devtools', 'dom', 'eslint-plugin', 'react', 'schema-org', 'shared', 'solid-js', 'ssr', 'svelte', 'unhead', 'vue', 'devtools-app'].map(name => `packages/${name}/dist`),
    }
  }
  throw new Error('Choose a registered check case.')
}

export function workflowInstructions(mode: string, scenario: CheckCase, scope: string, variant: string): string {
  const context = scope === 'projects' ? projectContext(scenario.id) : { args: [], testPath: '.checks/proof.test.ts' }
  const args = context.args.join(' ')
  const direct = `Use the supplied vitest executable. Write ${context.testPath} with explicit imports. Run vitest run ${context.testPath} ${args} --reporter=json --outputFile=.checks/red.json. Save green.json after repair. Delete your test module. Preserve existing tests.`
  const forced = `Use ripide check ${scenario.symbol} ${args} --base HEAD --json --artifact .checks/red.json with TypeScript on stdin. Save green.json after repair. The CLI imports missing subject, test, expect, and vi bindings. Relative imports and mocks resolve beside the selected source file. Remove existing artifacts before reusing paths. Do not create test modules.`
  const choice = mode === 'direct' ? `${direct} Do not use ripide.` : mode === 'forced' ? forced : `Choose one workflow. ${direct} Or: ${forced}`
  const guide = variant === 'guided' ? 'Read the selected function and real caller first. Choose assertions from the requested behavior. Keep one assertion source in .checks/assertions.txt. Reuse it unchanged for red and green. A collection error is not a failing assertion. Fix collection errors before changing source. If assertions are wrong, correct them and repeat red before repairing. Run only your temporary module. For ripide, omit automatic imports unless another symbol is needed. Use the full artifact only when short errors lack detail.' : 'Use identical assertions for the failing and passing runs.'
  const summary = variant === 'guided' && mode !== 'direct' ? 'If you used ripide, finish with ripide check --base HEAD --json. Report executed counts separately from pending API and integration review.' : ''
  return `${choice}\n${guide}\n${summary}\nOnly .checks may hold other temporary helpers. Finish by running check-behavior. Do not read external repositories or harness files. Give a brief result.`
}
