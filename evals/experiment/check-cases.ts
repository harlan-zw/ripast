import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CheckCase {
  id: string
  repository: string
  paths: string[]
  file: string
  symbol: string
  prompt: string
  mutation: [string, string]
  tests: string
}
export const checkCases: CheckCase[] = [
  {
    id: 'link-checker-concurrency',
    repository: 'pkg/nuxt-link-checker',
    paths: ['src/build/util.ts'],
    file: 'src/build/util.ts',
    symbol: 'runParallel',
    prompt: 'Repair runParallel. Honor the requested concurrency, keep callback indices, and finish all inputs after callback errors. Demonstrate overlapping callbacks with deterministic promise gates. Mock console.error when checking callback errors. Preserve truncateString.',
    mutation: ['Math.min(Math.max(opts.concurrency, 1), queue.length)', '1'],
    tests: `test('overlap and finish', async () => {
  let active = 0; let peak = 0; const visited: number[] = []
  let release!: () => void
  const gate = new Promise<void>(done => { release = done })
  const work = runParallel([0, 1, 2, 3], async (value, index) => {
    visited.push(index); active++; peak = Math.max(peak, active)
    await gate; active--
  }, { concurrency: 2 })
  await Promise.resolve(); const overlap = peak; release(); await work
  expect(overlap).toBe(2); expect(peak).toBe(2); expect(visited.sort()).toEqual([0, 1, 2, 3])
})
test('callback errors keep remaining work', async () => {
  const error = new Error('callback'); const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  const visited: number[] = []
  await runParallel([0, 1, 2], async value => { visited.push(value); if (value === 1) throw error }, { concurrency: 2 })
  expect(visited.sort()).toEqual([0, 1, 2]); expect(log).toHaveBeenCalledWith(error); log.mockRestore()
})`,
  },
  {
    id: 'unhead-real-caller',
    repository: 'pkg/unhead',
    paths: ['packages/unhead/src/utils/unsafeKey.ts', 'packages/unhead/src/utils/walkResolver.ts'],
    file: 'packages/unhead/src/utils/unsafeKey.ts',
    symbol: 'walkResolver',
    prompt: 'Repair isUnsafeKey so it rejects __proto__, constructor, and prototype. Test walkResolver through the real guard. Static safe input must retain object identity. Changed input must unwrap functions, drop unsafe keys, and preserve safe values. Do not mock the guard.',
    mutation: [' || key === \'prototype\'', ''],
    tests: `test('real guard drops unsafe keys', () => {
  const input = JSON.parse('{"prototype":"unsafe","safe":2}')
  expect(walkResolver(input)).toEqual({ safe: 2 })
})
test('static sharing and function values', () => {
  const input = { safe: 2 }; expect(walkResolver(input)).toBe(input)
  expect(walkResolver({ safe: () => 3 })).toEqual({ safe: 3 })
})`,
  },
]

export function captureCheckCase(scenario: CheckCase) {
  const repository = join(homedir(), scenario.repository)
  const git = (args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trimEnd()
  const commit = git(['rev-parse', 'HEAD'])
  const files = Object.fromEntries(scenario.paths.map(path => [path, `${git(['show', `${commit}:${path}`])}\n`]))
  const original = files[scenario.file]
  if (!original.includes(scenario.mutation[0]))
    throw new Error(`The registered mutation does not match ${scenario.id}.`)
  files[scenario.file] = original.replace(...scenario.mutation)
  return { files, original, provenance: { repository: scenario.repository, commit, paths: scenario.paths } }
}
