import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { executeExperiment } from './execute.ts'
import { createFixtureManifest } from './fixtures.ts'
import { parseManifest } from './manifest.ts'
import { archiveMessage } from './recorder.ts'

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { 'manifest': { type: 'string' }, 'out': { type: 'string' }, 'allow-model-calls': { type: 'boolean', default: false }, 'text': { type: 'string' }, 'installed': { type: 'boolean', default: false }, 'nuxt': { type: 'boolean', default: false }, 'repeats': { type: 'string', default: '1' } } })
  if (!values.out)
    throw new Error('Provide --out in a private scratch directory.')
  const out = resolve(values.out)
  if (positionals[0] === 'fixture') {
    mkdirSync(out, { recursive: true, mode: 0o700 })
    const manifest = createFixtureManifest(process.cwd(), Number(values.repeats), values.installed, values.nuxt)
    const path = resolve(out, 'fixture-manifest.json')
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    console.log(path)
    return
  }
  if (positionals[0] === 'steering') {
    if (!values.text)
      throw new Error('Provide the readable steering text before dispatch.')
    console.log(JSON.stringify(archiveMessage(out, 'controller', 'steering', values.text)))
    return
  }
  if (positionals[0] !== 'run' || !values.manifest)
    throw new Error('Use fixture, steering, or run --manifest FILE --out NEW_DIRECTORY.')
  const parsed = parseManifest(JSON.parse(readFileSync(values.manifest, 'utf8')))
  if (parsed._tag === 'Err')
    throw new Error(parsed.message)
  const report = await executeExperiment(parsed.value, out, { allowModelCalls: values['allow-model-calls'] })
  console.log(JSON.stringify({ manifestHash: report.manifestHash, attempts: report.attempts.length, summaries: report.summaries }, null, 2))
  if (report.attempts.some(a => a.quality !== 'passed'))
    process.exitCode = 1
}
main().catch((error: unknown) => {
  console.error((error as Error).message)
  process.exitCode = 1
})
