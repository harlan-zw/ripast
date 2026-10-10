import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { checkCases } from './check-cases.ts'
import { sha256 } from './manifest.ts'

const [name, executable, ...args] = process.argv.slice(2)
const directory = process.env.RIPIDE_EXPERIMENT_RECORD_DIRECTORY!
const project = process.env.RIPIDE_EXPERIMENT_PROJECT
if (!project || !isAbsolute(project))
  throw new Error('Supply the absolute registered project directory.')
const stdin = name === 'ripide' && args[0] === 'check' && args[1] && !args[1].startsWith('--')
  ? readFileSync(0)
  : undefined
const path = process.env.RIPIDE_EXPERIMENT_TEST_PATH ? resolve(project, process.env.RIPIDE_EXPERIMENT_TEST_PATH) : undefined
const assertions = stdin ?? (path && existsSync(path) ? readFileSync(path) : undefined)
const option = name === 'vitest' ? '--outputFile' : '--artifact'
const value = args.find(arg => arg.startsWith(`${option}=`))?.slice(option.length + 1)
  ?? (args.includes(option) ? args[args.indexOf(option) + 1] : undefined)
const artifact = value ? resolve(project, value) : undefined
const fresh = artifact && !existsSync(artifact)
const started = new Date().toISOString()
const sourceFile = checkCases.find(scenario => scenario.id === process.env.RIPIDE_EXPERIMENT_TASK)?.file
const sourceHash = sourceFile ? sha256(readFileSync(resolve(project, sourceFile))) : null
const result = spawnSync(process.execPath, [executable, ...args], { cwd: project, input: stdin, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
const artifactBytes = fresh && artifact && existsSync(artifact) ? readFileSync(artifact) : undefined
let executed = name === 'ripide'
if (name === 'vitest' && artifactBytes && path) {
  const report = JSON.parse(artifactBytes.toString()) as { testResults?: { name: string }[] }
  executed = report.testResults?.length === 1 && resolve(project, report.testResults[0].name) === path
}
appendFileSync(join(directory, 'commands.called'), `${name}\n`)
appendFileSync(join(directory, 'check-commands.jsonl'), `${JSON.stringify({ name, args, started, completed: new Date().toISOString(), exit: result.status, signal: result.signal, sourceHash, assertionHash: assertions && executed ? sha256(assertions) : null, testPath: name === 'vitest' ? path : null, artifact, artifactHash: artifactBytes ? sha256(artifactBytes) : null, stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderrBytes: Buffer.byteLength(result.stderr ?? '') })}\n`)
process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
if (result.error)
  throw result.error
if (result.signal)
  throw new Error(`Check process terminated: ${result.signal}`)
process.exitCode = result.status ?? 1
