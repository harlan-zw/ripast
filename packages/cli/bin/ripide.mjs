#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import spawn from 'cross-spawn'

const FRAMEWORK_MARKERS = {
  vue: ['vue', 'nuxt', '@nuxt/kit'],
  // svelte: ['svelte', '@sveltejs/kit'], // adapter not yet published
}

function detectFrameworks(cwd) {
  const out = []
  let dir = cwd
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies }
        for (const [name, markers] of Object.entries(FRAMEWORK_MARKERS)) {
          if (out.includes(name))
            continue
          if (markers.some(m => allDeps[m]))
            out.push(name)
        }
      }
      catch {}
    }
    const parent = dirname(dir)
    if (parent === dir)
      break
    dir = parent
  }
  return out
}

function jsonRequested(rawArgs) {
  let requested = false
  for (const arg of rawArgs) {
    if (arg === '--')
      break
    if (arg === '--json' || arg === '--json=true')
      requested = true
    if (arg === '--no-json' || arg === '--json=false')
      requested = false
  }
  return requested
}

function ensureAdapters(needed) {
  if (process.env.RIPIDE_REEXEC)
    return
  if (!needed.length)
    return

  const missing = []
  for (const name of needed) {
    try {
      if (!existsSync(new URL(import.meta.resolve(`ripide-${name}`))))
        missing.push(`ripide-${name}`)
    }
    catch { missing.push(`ripide-${name}`) }
  }
  if (!missing.length)
    return

  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const packages = ['ripide', ...missing].map(name => `--package=${name}@${version}`)
  const args = ['dlx', ...packages, 'ripide', ...process.argv.slice(2)]
  const json = jsonRequested(process.argv.slice(2))
  const options = { stdio: json ? ['inherit', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8', maxBuffer: 100 * 1024 * 1024, env: { ...process.env, RIPIDE_REEXEC: '1' } }
  let manager = 'pnpm'
  let res = spawn.sync(manager, args, options)
  if (res.error?.code === 'ENOENT') {
    manager = 'npm'
    // Keep npm's project metadata separate. The executed CLI still uses the caller's cwd.
    const prefix = mkdtempSync(join(tmpdir(), 'ripide-adapters-'))
    try {
      res = spawn.sync(manager, ['exec', '--yes', `--prefix=${prefix}`, ...packages, '--', 'ripide', ...process.argv.slice(2)], options)
    }
    finally { rmSync(prefix, { recursive: true, force: true }) }
  }
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      process.stderr.write([
        `ripide: Neither pnpm nor npm was found on PATH. Missing adapters: ${missing.join(', ')}.`,
        'If either package manager is installed, add its directory to PATH.',
        'Install pnpm: https://pnpm.io/installation',
        'Then run pnpm --version and retry.',
        'After installing npm, you can install the CLI and adapters together:',
        `  npm install -g ripide ${missing.join(' ')}`,
        'For script-only rename, move, or rename-file commands, retry with --no-vue.',
        '',
      ].join('\n'))
    }
    else {
      process.stderr.write(`ripide: Could not start ${manager}: ${res.error.message}\n`)
    }
  }
  if (json) {
    if (res.error)
      throw new Error(`Could not start ${manager}. Install the required adapter, then retry.`, { cause: res.error })
    if (!res.stdout?.trim())
      throw new Error(`Adapter command returned no JSON (exit ${res.status ?? 'unknown'}). Install ${missing.join(', ')} manually.`)
    // Parse the subprocess boundary before forwarding exactly one complete JSON value.
    const result = JSON.parse(res.stdout)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  }
  process.exitCode = res.status ?? 1
  return true
}

const { runCli } = await import('../dist/cli.mjs')
await runCli(process.argv.slice(2), () => ensureAdapters(detectFrameworks(process.cwd())))
