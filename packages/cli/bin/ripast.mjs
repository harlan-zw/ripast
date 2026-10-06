#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
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

function ensureAdapters(needed) {
  if (process.env.RIPAST_REEXEC)
    return
  if (!needed.length)
    return

  const require = createRequire(import.meta.url)
  const missing = []
  for (const name of needed) {
    try {
      require.resolve(`@ripast/${name}`)
    }
    catch { missing.push(`@ripast/${name}`) }
  }
  if (!missing.length)
    return

  const args = ['dlx', '--package=@ripast/cli', ...missing.map(p => `--package=${p}`), 'ripast', ...process.argv.slice(2)]
  const options = { stdio: 'inherit', env: { ...process.env, RIPAST_REEXEC: '1' } }
  let manager = 'pnpm'
  let res = spawn.sync(manager, args, options)
  if (res.error?.code === 'ENOENT') {
    manager = 'npm'
    // Keep npm's project metadata separate. The executed CLI still uses the caller's cwd.
    const prefix = mkdtempSync(join(tmpdir(), 'ripast-adapters-'))
    try {
      res = spawn.sync(manager, ['exec', '--yes', `--prefix=${prefix}`, '--package=@ripast/cli', ...missing.map(p => `--package=${p}`), '--', 'ripast', ...process.argv.slice(2)], options)
    }
    finally { rmSync(prefix, { recursive: true, force: true }) }
  }
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      process.stderr.write([
        `ripast: Neither pnpm nor npm was found on PATH. Missing adapters: ${missing.join(', ')}.`,
        'If either package manager is installed, add its directory to PATH.',
        'Install pnpm: https://pnpm.io/installation',
        'Then run pnpm --version and retry.',
        'After installing npm, you can install the CLI and adapters together:',
        `  npm install -g @ripast/cli ${missing.join(' ')}`,
        'For script-only rename, move, or rename-file commands, retry with --no-vue.',
        '',
      ].join('\n'))
    }
    else {
      process.stderr.write(`ripast: Could not start ${manager}: ${res.error.message}\n`)
    }
  }
  process.exit(res.status ?? 1)
}

ensureAdapters(process.argv.includes('--no-vue') ? [] : detectFrameworks(process.cwd()))

await import('../dist/cli.mjs')
