import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { captureCheckCase, checkCases } from './check-cases.ts'
import { projectContext } from './check-context.ts'
import { parseManifest, sha256 } from './manifest.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const { values } = parseArgs({ options: { out: { type: 'string' }, model: { type: 'string', default: 'zai-coding-plan/glm-5.3-flash' }, case: { type: 'string' }, timeout: { type: 'string', default: '360000' }, repeats: { type: 'string', default: '2' }, seed: { type: 'string', default: '20261010' }, scope: { type: 'string', default: 'slices' }, variant: { type: 'string', default: 'baseline' } } })
const repeats = Number(values.repeats)
const seed = Number(values.seed)
if (!Number.isSafeInteger(repeats) || repeats < 1 || !Number.isSafeInteger(seed))
  throw new Error('Repeats and seed must be integers. Repeats must be positive.')
if (!['slices', 'projects'].includes(values.scope!) || !['baseline', 'guided'].includes(values.variant!))
  throw new Error('Choose slices or projects, and baseline or guided.')
const timeoutMs = Number(values.timeout)
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
  throw new Error('Timeout must be a positive integer in milliseconds.')
const selected = values.case ? checkCases.filter(scenario => scenario.id === values.case) : checkCases
if (!selected.length)
  throw new Error('Choose a registered check case.')
const out = values.out ? resolve(values.out) : mkdtempSync(join(homedir(), 'scratch/ripide-check-study-registration-'))
mkdirSync(out, { recursive: true, mode: 0o700 })
if (readdirSync(out).length)
  throw new Error('Choose an empty registration directory.')
const runner = fileURLToPath(new URL('./check-runner.ts', import.meta.url))
const quality = fileURLToPath(new URL('./check-quality.ts', import.meta.url))
const opencode = execFileSync('which', ['opencode'], { encoding: 'utf8' }).trim()
const lockProject = join(out, 'dependency-lock')
mkdirSync(lockProject)
const packageSource = '{"name":"ripide-check-study","private":true,"type":"module","devDependencies":{"vitest":"5.0.3"}}\n'
writeFileSync(join(lockProject, 'package.json'), packageSource)
execFileSync('pnpm', ['install', '--lockfile-only', '--offline', '--ignore-scripts'], { cwd: lockProject, stdio: 'pipe' })
// Warm the store before model dispatch. Attempt setup still records each offline installation.
execFileSync('pnpm', ['install', '--ignore-scripts', '--frozen-lockfile'], { cwd: lockProject, stdio: 'pipe' })
const lock = readFileSync(join(lockProject, 'pnpm-lock.yaml'), 'utf8')
const captured = selected.map(scenario => ({ scenario, capture: captureCheckCase(scenario) }))
const sourcePath = join(out, 'source-provenance.json')
writeFileSync(sourcePath, JSON.stringify(captured, null, 2), { flag: 'wx', mode: 0o400 })
const files = (directory: string): string[] => readdirSync(directory, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
const pinned = [process.execPath, opencode, join(root, 'pnpm-lock.yaml'), join(root, 'packages/cli/bin/ripide.mjs'), sourcePath, ...files(join(root, 'packages/core/dist')), ...files(join(root, 'packages/cli/dist')), ...files(join(root, 'evals/experiment'))]
const manifest = parseManifest({
  id: `check-${values.scope}-${values.variant}`,
  study: 'pilot',
  pilotHash: null,
  seed,
  repeats,
  cache: 'uncontrolled',
  timeoutMs,
  timeoutPolicy: 'continue-study',
  repairs: 0,
  tracing: 'strace',
  commonInstructions: `This is a ${values.scope === 'projects' ? 'complete Git project' : 'Git source slice'} with a seeded bug. Dependencies are installed. Show failing assertions before editing, repair only the named function body, then show passing assertions. Preserve signatures, comments, other functions, existing tests, configuration, and dependencies. Use TypeScript for new code. Remove newly authored test modules. The supplied vitest, ripide, and check-behavior executables are on PATH. Do not install dependencies.`,
  runners: Object.fromEntries(['direct', 'forced', 'hybrid'].map(mode => [mode, { model: values.model, reasoning: 'provider-default', command: [process.execPath, runner, mode, '{project}', '{promptFile}', '{task}', root, values.model!, opencode, values.variant!, values.scope!, sourcePath] }])),
  artifacts: [...new Set(pinned)].map(path => ({ path, sha256: sha256(readFileSync(path)) })),
  versions: [[process.execPath, '--version'], ['pnpm', '--version'], ['opencode', '--version'], ['/usr/bin/strace', '--version']],
  usageImports: [],
  tasks: captured.map(({ scenario, capture }) => ({
    id: scenario.id,
    cohort: 'mixed',
    operation: 'behavior-repair',
    prompt: `${scenario.prompt}\nSelected export: ${scenario.symbol}. Source: ${scenario.file}.`,
    source: values.scope === 'projects' ? { _tag: 'Git', repository: join(homedir(), scenario.repository), commit: capture.provenance.commit } : { files: { ...capture.files, 'package.json': packageSource, 'pnpm-lock.yaml': lock } },
    expected: {},
    acceptance: { _tag: 'Behavior', files: [scenario.file] },
    generatedDirectories: ['.checks', '.build', ...(values.scope === 'projects' ? projectContext(scenario.id).generated : [])],
    setup: [
      { command: ['pnpm', 'install', '--offline', '--ignore-scripts', '--frozen-lockfile'], phase: 'setup', role: 'controller' },
      ...(values.scope === 'projects'
        ? [
            ...projectContext(scenario.id).prepare.map(command => ({ command, phase: 'setup', role: 'controller' })),
            { command: [process.execPath, fileURLToPath(new URL('./check-project-setup.ts', import.meta.url)), '{project}', sourcePath, scenario.id], phase: 'setup', role: 'controller' },
          ]
        : [{ command: [process.execPath, runner, 'setup', '{project}'], phase: 'setup', role: 'controller' }]),
      { command: [process.execPath, runner, 'preflight', '{project}', '-', scenario.id, root, values.model!, opencode, values.variant!, values.scope!, sourcePath], phase: 'setup', role: 'controller' },
    ],
    checks: [
      { command: [process.execPath, quality, '{project}', scenario.id], phase: 'verification', role: 'controller' },
      ...(values.scope === 'projects' ? projectContext(scenario.id).checks.map(command => ({ command, phase: 'verification', role: 'controller' })) : []),
    ],
    symbols: [],
    qualityGates: [{ id: 'behavior-and-evidence', command: [process.execPath, quality, '{project}', scenario.id, sourcePath, '{mode}'], required: true }],
  })),
})
if (manifest._tag === 'Err')
  throw new Error(manifest.message)
writeFileSync(join(out, 'check-manifest.json'), JSON.stringify(manifest.value, null, 2), { flag: 'wx', mode: 0o400 })
console.log(join(out, 'check-manifest.json'))
