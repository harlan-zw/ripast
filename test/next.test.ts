import type { Buffer } from 'node:buffer'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, renameSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { resolveNativeTsc, runMove, runRename, runRenameFile, scan, writeChanges } from '@ripast/core'
import { describe, expect, it } from 'vitest'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

const require = createRequire(import.meta.url)

function makeNextFixture() {
  const fx = makeFixture({}, false)
  cpSync(resolve('test/fixtures/next'), fx.dir, { recursive: true })
  for (const name of ['next', 'react', 'react-dom', 'typescript', '@types/react', '@types/react-dom', '@types/node']) {
    const destination = join(fx.dir, 'node_modules', name)
    mkdirSync(dirname(destination), { recursive: true })
    symlinkSync(dirname(require.resolve(`${name}/package.json`)), destination, 'junction')
  }
  return fx
}

function checkProject(cwd: string) {
  execFileSync(resolveNativeTsc(), ['--noEmit', '--project', join(cwd, 'tsconfig.json')], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
  })
}

async function withNextServer(cwd: string, check: (url: string) => Promise<void>): Promise<void> {
  const server = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '0'], {
    cwd,
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = new Promise<void>(resolve => server.once('close', () => resolve()))
  try {
    const url = await new Promise<string>((resolve, reject) => {
      let output = ''
      const timer = setTimeout(() => reject(new Error(`Next server startup timed out: ${output}`)), 30000)
      const fail = (error: Error) => {
        clearTimeout(timer)
        reject(error)
      }
      const read = (chunk: Buffer) => {
        output += chunk.toString()
        const address = /http:\/\/127\.0\.0\.1:\d+/.exec(output)?.[0]
        if (address && output.includes('Ready in')) {
          clearTimeout(timer)
          resolve(address)
        }
      }
      server.stdout.on('data', read)
      server.stderr.on('data', read)
      server.once('error', fail)
      server.once('exit', code => fail(new Error(`Next server exited with ${code}: ${output}`)))
    })
    await check(url)
  }
  finally {
    server.kill()
    await exited
  }
}

describe('next App Router fixture', () => {
  it('finds shared helpers in server, client, and route consumers', () => {
    const fx = makeNextFixture()
    try {
      const hits = scan('formatCount', { ...{ cwd: fx.dir }, engine: vueServices() })
      expect(hits.filter(hit => hit.kind === 'identifier-reference').map(hit => hit.file).sort()).toEqual([
        'app/api/status/route.ts',
        'app/page.tsx',
        'components/Counter.tsx',
      ])
    }
    finally { fx.cleanup() }
  })

  it('renames shared helpers across path aliases without type regressions', async () => {
    const fx = makeNextFixture()
    try {
      checkProject(fx.dir)
      const result = await runRename('formatCount', 'displayCount', { ...{ cwd: fx.dir, verify: 'project' }, engine: vueServices() })
      expect(result.regressions).toEqual([])
      expect(result.changes.map(change => change.rel).sort()).toEqual([
        'app/api/status/route.ts',
        'app/page.tsx',
        'components/Counter.tsx',
        'lib/count.ts',
      ])
      writeChanges(result.changes)
      checkProject(fx.dir)
      expect(scan('formatCount', { ...{ cwd: fx.dir }, engine: vueServices() })).toEqual([])
      expect(scan('displayCount', { ...{ cwd: fx.dir }, engine: vueServices() }).filter(hit => hit.kind === 'identifier-reference')).toHaveLength(3)
    }
    finally { fx.cleanup() }
  })

  it('builds and prerenders after a client component rename, file move, and helper move', async () => {
    const fx = makeNextFixture()
    try {
      checkProject(fx.dir)
      const renamed = await runRename('Counter', 'CountButton', { ...{ cwd: fx.dir, verify: 'project' }, engine: vueServices() })
      expect(renamed.regressions).toEqual([])
      writeChanges(renamed.changes)

      const file = await runRenameFile('components/Counter.tsx', 'components/controls/CountButton.tsx', { ...{
        cwd: fx.dir,
        verify: 'project',
      }, engine: vueServices() })
      expect(file.regressions).toEqual([])
      writeChanges(file.changes)
      mkdirSync(dirname(file.fileMove.to), { recursive: true })
      renameSync(file.fileMove.from, file.fileMove.to)
      if (file.selfChange)
        fx.write('components/controls/CountButton.tsx', file.selfChange.after)

      const moved = await runMove('formatCount', 'lib/count.ts', 'lib/display.ts', { ...{
        cwd: fx.dir,
        verify: 'project',
      }, engine: vueServices() })
      expect(moved.regressions).toEqual([])
      writeChanges(moved.changes)
      checkProject(fx.dir)

      execFileSync(process.execPath, [require.resolve('next/dist/bin/next'), 'build', '--webpack'], {
        cwd: fx.dir,
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
        encoding: 'utf8',
        timeout: 120000,
        maxBuffer: 8 * 1024 * 1024,
      })
      const html = readFileSync(join(fx.dir, '.next/server/app/index.html'), 'utf8')
      expect(html).toContain('<h1>Count: 2</h1>')
      expect(html).toContain('<button class="rounded p-2">Count: 2</button>')
      expect(html).toContain('href="/api/status"')
      await withNextServer(fx.dir, async (url) => {
        const page = await fetch(url, { signal: AbortSignal.timeout(10000) })
        expect(page.status).toBe(200)
        expect(await page.text()).toContain('<h1>Count: 2</h1>')
        const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(10000) })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ label: 'Count: 2' })
      })
    }
    finally { fx.cleanup() }
  }, 180000)
})
