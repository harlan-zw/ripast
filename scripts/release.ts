import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'

const folders = ['core', 'vue', 'cli'] as const
const packageNames = { core: 'ripide-api', vue: 'ripide-vue', cli: 'ripide' } as const
interface ReleasePackage { name: string, version: string }
interface RegistryResponse { status: number | null, stdout: string }

function parseRegistryValue(output: string): unknown {
  const value: unknown = JSON.parse(output)
  return Array.isArray(value) && value.length === 1 ? value[0] : value
}

export function assertReplacementPublished(response: RegistryResponse, version: string) {
  if (response.status !== 0 || !response.stdout.trim() || parseRegistryValue(response.stdout) !== version)
    throw new Error('Publish the replacement release before deprecating legacy packages.')
}

export async function downloadPublishedPackages(pack: () => RegistryResponse, pause: () => Promise<void>, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const response = pack()
    if (response.status === 0)
      return
    if (response.status === null || !response.stdout.trim())
      throw new Error('Package download failed. Check npm connectivity before retrying.')
    const value: unknown = JSON.parse(response.stdout)
    if (typeof value !== 'object' || value === null || !('error' in value)
      || typeof value.error !== 'object' || value.error === null
      || !('code' in value.error) || !['E404', 'ETARGET'].includes(String(value.error.code))) {
      throw new Error('Package download failed. Resolve the npm error before retrying.')
    }
    if (attempt + 1 < attempts)
      await pause()
  }
  throw new Error('Published packages are not available. Retry after npm finishes processing them.')
}

export function planRelease(tag: string, packages: ReleasePackage[]) {
  const match = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-z-][\da-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][\da-z-]*))*))?)$/i.exec(tag)
  if (!match)
    throw new Error('Pass a version tag, such as v0.5.0 or v0.6.0-beta.1.')
  const version = match[1]
  const names = new Set(packages.map(pkg => pkg.name))
  if (packages.length !== 3 || names.size !== 3 || folders.some(folder => !names.has(packageNames[folder])))
    throw new Error('Release the core, Vue, and CLI packages together.')
  if (packages.some(pkg => pkg.version !== version))
    throw new Error('Every package version must match the release tag.')
  const channel = match[2]?.split('.')[0].toLowerCase()
  return { version, npmTag: channel ? ['alpha', 'beta', 'rc'].includes(channel) ? channel : 'next' : 'latest' }
}

export function publicationDecision(response: RegistryResponse, integrity: string): 'publish' | 'skip' {
  if (response.status === null || !response.stdout.trim())
    throw new Error('Registry lookup failed. Retry after checking npm connectivity.')
  const value = parseRegistryValue(response.stdout)
  if (response.status !== 0) {
    if (typeof value === 'object' && value !== null && 'error' in value
      && typeof value.error === 'object' && value.error !== null
      && 'code' in value.error && value.error.code === 'E404') {
      return 'publish'
    }
    throw new Error('Registry lookup failed. Resolve the npm error before publishing.')
  }
  if (value !== integrity)
    throw new Error('This version contains a different artifact. Use a new version.')
  return 'skip'
}

function readPackages(cwd: string): ReleasePackage[] {
  return folders.map((folder) => {
    const value: unknown = JSON.parse(readFileSync(join(cwd, 'packages', folder, 'package.json'), 'utf8'))
    if (typeof value !== 'object' || value === null || !('name' in value) || !('version' in value)
      || typeof value.name !== 'string' || typeof value.version !== 'string') {
      throw new Error(`Invalid package metadata: packages/${folder}/package.json.`)
    }
    return { name: value.name, version: value.version }
  })
}

async function run() {
  const [command, tag = '', directory] = process.argv.slice(2)
  const plan = planRelease(tag, readPackages(process.cwd()))
  if (command === 'plan') {
    process.stdout.write(`version=${plan.version}\nnpmTag=${plan.npmTag}\n`)
    return
  }
  if (command === 'deprecate' && process.env.npm_execpath?.endsWith('npm-cli.js')) {
    const npm = process.env.npm_execpath
    for (const folder of folders) {
      const response = spawnSync(process.execPath, [npm, 'view', `${packageNames[folder]}@${plan.version}`, 'version', '--json'], { encoding: 'utf8' })
      if (response.error)
        throw response.error
      assertReplacementPublished(response, plan.version)
    }
    for (const folder of folders) {
      const legacy = `@ripast/${folder}`
      const replacement = packageNames[folder]
      const response = spawnSync(process.execPath, [npm, 'deprecate', legacy, `Renamed to ${replacement}. Install ${replacement} instead.`], { stdio: 'inherit' })
      if (response.error)
        throw response.error
      if (response.status !== 0)
        throw new Error(`Deprecation failed for ${legacy}. Check npm authentication before retrying.`)
    }
    return
  }
  if (!['publish', 'download'].includes(command) || !directory || !process.env.npm_execpath?.endsWith('npm-cli.js'))
    throw new Error('Run npm run release:publish or release:download with a version tag and tarball directory.')
  const npm = process.env.npm_execpath
  if (command === 'download') {
    mkdirSync(directory, { recursive: true })
    await downloadPublishedPackages(() => {
      const response = spawnSync(process.execPath, [npm, 'pack', ...folders.map(folder => `${packageNames[folder]}@${plan.version}`), '--json', '--pack-destination', directory, '--registry=https://registry.npmjs.org'], { encoding: 'utf8' })
      if (response.error)
        throw response.error
      if (response.stderr)
        process.stderr.write(response.stderr)
      return response
    }, () => {
      process.stdout.write('npm is processing published packages. Retry the download in 20 seconds.\n')
      return setTimeout(20_000)
    })
    return
  }
  const artifacts = folders.map((folder) => {
    const name = packageNames[folder]
    const tarball = join(directory, `${name.replace(/^@/, '').replace('/', '-')}-${plan.version}.tgz`)
    const integrity = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
    const response = spawnSync(process.execPath, [npm, 'view', `${name}@${plan.version}`, 'dist.integrity', '--json', '--registry=https://registry.npmjs.org'], { encoding: 'utf8' })
    if (response.error)
      throw response.error
    return { name, tarball, decision: publicationDecision(response, integrity) }
  })
  for (const { name, tarball, decision } of artifacts) {
    if (decision === 'skip') {
      process.stdout.write(`${name}@${plan.version} already contains this artifact.\n`)
      continue
    }
    const published = spawnSync(process.execPath, [npm, 'publish', tarball, '--access=public', `--tag=${plan.npmTag}`, '--registry=https://registry.npmjs.org'], { stdio: 'inherit' })
    if (published.error)
      throw published.error
    if (published.status !== 0)
      throw new Error(`Publication failed for ${name}. Retry this release after resolving the npm error.`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await run()
