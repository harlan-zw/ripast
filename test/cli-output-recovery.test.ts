import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

const cli = resolve('packages/cli/src/cli.ts')
function run(cwd: string, args: string[]) {
  return spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 30_000 })
}
it('blocked file move flushes large full JSON and leaves all files unchanged', () => {
  const source = 'import { value } from \'local-dependency\'\nexport { value }\n'
  const consumer = `import { value } from './packages/source/index'\nconst text: string = value\n${'// bulk context\n'.repeat(1400)}`
  const fixture = makeFixture({ 'packages/source/index.ts': source, 'packages/source/node_modules/local-dependency/package.json': '{"types":"index.d.ts"}', 'packages/source/node_modules/local-dependency/index.d.ts': 'export declare const value: number\n', ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`consumer-${i}.ts`, consumer])) })
  try {
    const result = run(fixture.dir, ['rename-file', 'packages/source/index.ts', 'packages/dest/index.ts', '--no-vue', '--apply', '--json', '--profile', 'full'])
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 1, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.blockedByRegression, true)
    assert.ok(payload.regressions.length > 0)
    assert.ok(result.stdout.length > 500_000)
    assert.equal(fixture.read('packages/source/index.ts'), source)
    for (let i = 0; i < 40; i++)
      assert.equal(fixture.read(`consumer-${i}.ts`), consumer)
    assert.equal(existsSync(resolve(fixture.dir, 'packages/dest/index.ts')), false)
  }
  finally { fixture.cleanup() }
})
it.each([
  ['scan', 'value', '--kind', 'unknown'],
  ['scan', 'value', '--graph', 'dot', '--json'],
  ['css-class-rename', 'x', 'y', '--apply', '--profile', 'invalid'],
  ['components', 'Missing'],
  ['doctor', '--checks', 'unknown'],
])('invalid command returns actionable JSON before writes: %s', (...args) => {
  const source = 'export const value = "x"\n'
  const fixture = makeFixture({ 'source.ts': source })
  try {
    const result = run(fixture.dir, [...args, '--json'])
    assert.notEqual(result.status, 0)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.status, 'error')
    assert.ok(payload.error.message)
    assert.ok(payload.error.next)
    assert.equal(fixture.read('source.ts'), source)
  }
  finally { fixture.cleanup() }
})
it('scan JSON page exposes totals and focused retrieval without source payloads', () => {
  const fixture = makeFixture(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`file-${String(i).padStart(2, '0')}.ts`, 'export const value = 1\n'])))
  try {
    const first = run(fixture.dir, ['scan', 'value', '--json', '--profile', 'agent', '--limit', '3'])
    const next = run(fixture.dir, ['scan', 'value', '--json', '--profile', 'agent', '--limit', '3', '--offset', '3', '--fields', 'file,line'])
    assert.equal(first.status, 0, first.stderr)
    const a = JSON.parse(first.stdout)
    const b = JSON.parse(next.stdout)
    assert.equal(a.total, 12)
    assert.equal(a.omitted, 9)
    assert.equal(a.results.length, 3)
    assert.equal(b.results[0].file, 'file-03.ts')
    assert.equal(b.results[0].snippet, undefined)
    assert.equal(fixture.read('file-00.ts'), 'export const value = 1\n')
  }
  finally { fixture.cleanup() }
})

it('jSON help and version produce valid structured outcomes', () => {
  const fixture = makeFixture()
  try {
    const result = run(fixture.dir, ['scan', '--help', '--json'])
    assert.equal(result.status, 0)
    assert.equal(JSON.parse(result.stdout).status, 'help')
    assert.match(JSON.parse(result.stdout).usage, /scan/)
  }
  finally { fixture.cleanup() }
})

it('refused rename closes its child service and terminates within a deadline', async () => {
  const fixture = makeFixture({ 'source.ts': 'export const value = 1\nexport const taken = 2\n' })
  try {
    const result = await runTracked(fixture.dir, ['rename', 'value', 'taken', '--no-vue', '--apply', '--json'])
    assert.equal(result.code, 1)
    assert.equal(result.signal, null)
    assert.equal(JSON.parse(result.stdout).status, 'refused')
    if (process.platform === 'linux') {
      assert.ok(result.services.length > 0)
      for (const pid of result.services)
        assert.equal(existsSync(`/proc/${pid}`), false, `Child service ${pid} must close.`)
    }
    assert.equal(fixture.read('source.ts'), 'export const value = 1\nexport const taken = 2\n')
  }
  finally { fixture.cleanup() }
})

it('compact discovery saves full evidence separately and retrieves another graph page', () => {
  const fixture = makeFixture(Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`file${i}.ts`, 'export const value = 1\n'])))
  try {
    const result = run(fixture.dir, ['scan', 'value', '--json', '--profile', 'agent', '--limit', '2', '--minify', '--artifact', 'scan.json'])
    assert.equal(result.status, 0)
    assert.equal(JSON.parse(result.stdout).omitted, 6)
    assert.equal(JSON.parse(fixture.read('scan.json')).length, 8)
    const graph = run(fixture.dir, ['scan', 'value', '--graph', 'dot', '--profile', 'agent', '--limit', '2', '--offset', '2'])
    assert.equal(graph.status, 0)
    assert.match(graph.stdout, /shown: 2, omitted: 6, offset: 2/)
    assert.match(graph.stdout, /omitted edges: 0/)
    assert.match(graph.stdout, /file2\.ts/)
    assert.doesNotMatch(graph.stdout, /file0\.ts/)
  }
  finally { fixture.cleanup() }
})

it('diagnostic retrieval filters codes and files while preserving refusal', () => {
  const fixture = makeFixture({ 'source.ts': 'export const value = 1\nexport const taken = 2\n' })
  try {
    const full = run(fixture.dir, ['rename', 'value', 'taken', '--no-vue', '--apply', '--json', '--profile', 'full'])
    const code = JSON.parse(full.stdout).regressions[0].code
    const filtered = run(fixture.dir, ['rename', 'value', 'taken', '--no-vue', '--apply', '--json', '--profile', 'agent', '--code', String(code), '--file', 'source.ts', '--limit', '1'])
    const payload = JSON.parse(filtered.stdout)
    assert.equal(filtered.status, 1)
    assert.equal(payload.status, 'refused')
    assert.equal(payload.regressions.length, 1)
    assert.equal(payload.regressions[0].code, code)
    assert.equal(payload.regressions[0].file, 'source.ts')
    assert.ok(payload.verification.length)
    assert.equal(fixture.read('source.ts'), 'export const value = 1\nexport const taken = 2\n')
  }
  finally { fixture.cleanup() }
})

function runTracked(cwd: string, args: string[]): Promise<{ code: number | null, signal: string | null, stdout: string, services: number[] }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', cli, ...args], { cwd })
    const services = new Set<number>()
    let stdout = ''
    child.stdout.on('data', chunk => stdout += String(chunk))
    const watch = setInterval(() => {
      if (process.platform !== 'linux' || !child.pid)
        return
      const path = `/proc/${child.pid}/task/${child.pid}/children`
      try {
        for (const pid of readFileSync(path, 'utf8').trim().split(/\s+/).filter(Boolean))
          services.add(Number(pid))
      }
      catch (error) {
        // The CLI may terminate between a timer tick and reading its process entry.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          reject(error)
      }
    }, 10)
    const deadline = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('CLI did not terminate within 30 seconds.'))
    }, 30_000)
    child.on('error', reject)
    child.on('close', (code, signal) => {
      clearInterval(watch)
      clearTimeout(deadline)
      setTimeout(resolveResult, 50, { code, signal, stdout, services: [...services] })
    })
  })
}

it('agent pages disclose the path base and bound unused declarations', () => {
  const fixture = makeFixture(Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`file${i}.ts`, `const unused${i} = 1\n`])))
  try {
    const result = run(fixture.dir, ['unused', '--exports', 'local', '--json', '--profile', 'agent', '--limit', '2', '--offset', '2'])
    assert.equal(result.status, 0, result.stderr)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.base, fixture.dir)
    assert.equal(payload.total, 9)
    assert.equal(payload.shown, 2)
    assert.equal(payload.omitted, 7)
    assert.equal(payload.offset, 2)
  }
  finally { fixture.cleanup() }
})

it('timings report finite phase measurements without contaminating JSON', () => {
  const fixture = makeFixture({ 'source.ts': 'export const value = 1\n' })
  try {
    const result = run(fixture.dir, ['scan', 'value', '--json', '--profile', 'agent', '--timings'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).total, 1)
    const events = result.stderr.trim().split('\n').map(line => JSON.parse(line))
    assert.ok(events.some(event => event.phase === 'command scan'))
    assert.ok(events.some(event => event.phase === 'scan discovery'))
    assert.ok(events.some(event => event.phase === 'scan parse'))
    assert.ok(events.every(event => typeof event.phase === 'string' && Number.isFinite(event.ms) && event.ms >= 0))
    assert.equal(fixture.read('source.ts'), 'export const value = 1\n')
  }
  finally { fixture.cleanup() }
})

it.each([['unknown-command', '--json'], ['--json']])('root JSON outcome stays valid: %s', (...args) => {
  const fixture = makeFixture({ 'source.ts': 'export const value = 1\n' })
  try {
    const result = run(fixture.dir, args)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.status, args[0] === '--json' ? 'help' : 'error')
    assert.equal(result.status, args[0] === '--json' ? 0 : 1)
    assert.equal(fixture.read('source.ts'), 'export const value = 1\n')
  }
  finally { fixture.cleanup() }
})

it('doctor fixes use compact text and apply every fix despite display limits', () => {
  const source = `export { missing } from './missing'\n`
  const fixture = makeFixture(Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`file${i}.ts`, source])))
  try {
    const preview = run(fixture.dir, ['doctor', '--checks', 'dangling-reexport', '--fix', '--profile', 'agent', '--limit', '1'])
    assert.equal(preview.status, 0, preview.stderr)
    assert.match(preview.stdout, /omitted: 3/)
    assert.doesNotMatch(preview.stdout, /--- a\//)
    for (let i = 0; i < 4; i++)
      assert.equal(fixture.read(`file${i}.ts`), source)
    const applied = run(fixture.dir, ['doctor', '--checks', 'dangling-reexport', '--fix', '--apply', '--json', '--profile', 'agent', '--limit', '1', '--artifact', 'fix.json'])
    assert.equal(applied.status, 0, applied.stderr)
    const payload = JSON.parse(applied.stdout)
    assert.equal(payload.changePage.total, 4)
    assert.equal(payload.changePage.omitted, 3)
    assert.equal(JSON.parse(fixture.read('fix.json')).changes.length, 4)
    for (let i = 0; i < 4; i++)
      assert.doesNotMatch(fixture.read(`file${i}.ts`), /missing/)
  }
  finally { fixture.cleanup() }
})
