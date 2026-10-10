import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkCases } from './check-cases.ts'
import { sha256 } from './manifest.ts'

const [name, executable, ...args] = process.argv.slice(2)
const directory = process.env.RIPIDE_EXPERIMENT_RECORD_DIRECTORY!
const stdin = name === 'ripide' && args[0] === 'check' && args[1] && !args[1].startsWith('--')
  ? readFileSync(0)
  : undefined
const path = process.env.RIPIDE_EXPERIMENT_TEST_PATH
const assertions = stdin ?? (path && existsSync(path) ? readFileSync(path) : undefined)
const started = new Date().toISOString()
const sourceFile = checkCases.find(scenario => scenario.id === process.env.RIPIDE_EXPERIMENT_TASK)?.file
const sourceHash = sourceFile ? sha256(readFileSync(sourceFile)) : null
const result = spawnSync(process.execPath, [executable, ...args], { input: stdin, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
appendFileSync(join(directory, 'commands.called'), `${name}\n`)
appendFileSync(join(directory, 'check-commands.jsonl'), `${JSON.stringify({ name, args, started, completed: new Date().toISOString(), exit: result.status, signal: result.signal, sourceHash, assertionHash: assertions ? sha256(assertions) : null, stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderrBytes: Buffer.byteLength(result.stderr ?? '') })}\n`)
process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
if (result.error)
  throw result.error
if (result.signal)
  throw new Error(`Check process terminated: ${result.signal}`)
process.exitCode = result.status ?? 1
