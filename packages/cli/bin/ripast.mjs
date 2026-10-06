#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'

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
  const res = spawnSync('pnpm', args, {
    stdio: 'inherit',
    env: { ...process.env, RIPAST_REEXEC: '1' },
  })
  if (res.error) {
    if (res.error.code === 'ENOENT') {
      process.stderr.write([
        `ripast: pnpm was not found on PATH. It installs missing adapters: ${missing.join(', ')}.`,
        'If pnpm is already installed, add its directory to PATH.',
        'Otherwise, outside this project, run: npx get-pnpm',
        'Then run pnpm --version and retry.',
        'Installation guide: https://pnpm.io/installation',
        `Or install the CLI and adapters together: npm install -g @ripast/cli ${missing.join(' ')}`,
        'For script-only rename, move, or rename-file commands, retry with --no-vue.',
        '',
      ].join('\n'))
    }
    else {
      process.stderr.write(`ripast: Could not start pnpm: ${res.error.message}\n`)
    }
  }
  process.exit(res.status ?? 1)
}

ensureAdapters(process.argv.includes('--no-vue') ? [] : detectFrameworks(process.cwd()))

await import('../dist/cli.mjs')
