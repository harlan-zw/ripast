import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { startTsServer } from 'ripide-api'
import { it } from 'vitest'

function terminateChild(cwd: string): void {
  const pid = Number(readFileSync(join(cwd, 'server.pid'), 'utf8'))
  try {
    process.kill(pid, 'SIGKILL')
  }
  catch (error) {
    // An already terminated child needs no additional cleanup.
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH'))
      throw error
  }
}

it.each(['deadline', 'cancellation'])('rejects a live stalled server request through %s', async (mode) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ripide-deadline-'))
  const controller = new AbortController()
  const server = await startTsServer(cwd, {
    binary: process.execPath,
    args: ['--experimental-strip-types', fileURLToPath(new URL('./fixtures/lsp/stall.ts', import.meta.url))],
    requestTimeoutMs: 1000,
    signal: controller.signal,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const path = join(cwd, 'source.ts')
    writeFileSync(path, 'export const value = 1')
    const request = server.definition(path, 13).then(() => 'success', error => error)
    if (mode === 'cancellation')
      controller.abort(new Error('Requested cancellation'))
    const result = await Promise.race([request, new Promise((resolve) => {
      timer = setTimeout(resolve, 3000, 'missed deadline')
    })])
    assert.ok(result instanceof Error, String(result))
    assert.match(result.message, mode === 'deadline' ? /deadline.*textDocument\/definition/i : /cancel/i)
    await assert.rejects(server.definition(path, 13), error => error === result)
    await delay(1500)
    const pid = Number(readFileSync(join(cwd, 'server.pid'), 'utf8'))
    assert.throws(() => process.kill(pid, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
  finally {
    clearTimeout(timer)
    server.dispose()
    terminateChild(cwd)
    rmSync(cwd, { recursive: true, force: true })
  }
})

it('bounds initialization when a live child refuses graceful shutdown', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'ripide-initialize-'))
  try {
    await assert.rejects(startTsServer(cwd, {
      binary: process.execPath,
      args: ['--experimental-strip-types', fileURLToPath(new URL('./fixtures/lsp/stall.ts', import.meta.url)), '--stall-initialize'],
      requestTimeoutMs: 1000,
    }), /deadline.*initialize/i)
    await delay(1500)
    const pid = Number(readFileSync(join(cwd, 'server.pid'), 'utf8'))
    assert.throws(() => process.kill(pid, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH')
  }
  finally {
    terminateChild(cwd)
    rmSync(cwd, { recursive: true, force: true })
  }
})
