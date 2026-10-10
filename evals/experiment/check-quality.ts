import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { checkCases } from './check-cases.ts'
import { sha256 } from './manifest.ts'

async function main() {
  const [project, task, provenance, mode] = process.argv.slice(2)
  function authored(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
      ['node_modules', '.git', '.build'].includes(entry.name) ? [] : entry.isDirectory() ? authored(join(directory, entry.name)) : [join(directory, entry.name)])
  }
  const paths = authored(project)
  const record = process.env.RIPIDE_EXPERIMENT_RECORD_DIRECTORY
  assert.ok(record, 'Supply the experiment record directory.')
  const baseline = readFileSync(join(record, 'baseline-commit.txt'), 'utf8').trim()
  assert.match(baseline, /^[a-f0-9]{40,64}$/, 'Record the frozen fixture commit during preflight.')
  const tracked = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', baseline], { cwd: project, encoding: 'utf8' }).split('\0'))
  assert.deepEqual(paths.filter(path => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) && !tracked.has(relative(project, path))), [], 'Remove every new test module.')
  assert.deepEqual(paths.filter(path => relative(project, path).replaceAll('\\', '/').startsWith('.checks/') && /\.[cm]?[jt]sx?$/.test(path) && !tracked.has(relative(project, path))), [], 'Remove every new code helper from .checks.')
  const build = join(record, 'oracle-build')
  mkdirSync(build, { recursive: true })
  writeFileSync(join(build, 'package.json'), '{"type":"commonjs"}')
  const scenario = checkCases.find(row => row.id === task)!
  for (const path of scenario.paths.map(path => join(project, path))) {
    const source = readFileSync(path, 'utf8')
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, fileName: path, reportDiagnostics: true })
    assert.equal(compiled.diagnostics?.length ?? 0, 0, 'Source must compile.')
    const destination = join(build, path.slice(project.length + 1).replace(/\.ts$/, '.js'))
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, compiled.outputText)
  }
  const require = createRequire(join(build, 'oracle.cjs'))
  if (task === 'link-checker-concurrency') {
    const { runParallel, truncateString } = require('./src/build/util.js') as {
      runParallel: (values: number[], cb: (value: number, index: number) => Promise<void>, options: { concurrency: number }) => Promise<void>
      truncateString: (text: string, length: number) => string
    }
    for (const concurrency of [0, 1, 2, 3, 20]) {
      let active = 0
      let peak = 0
      const visited: [number, number][] = []
      let release!: () => void
      const gate = new Promise<void>((done) => {
        release = done
      })
      const work = runParallel([4, 5, 6, 7], async (value, index) => {
        visited.push([value, index])
        active++
        peak = Math.max(peak, active)
        await gate
        active--
      }, { concurrency })
      await Promise.resolve()
      const overlap = peak
      release()
      await work
      assert.equal(overlap, Math.min(Math.max(concurrency, 1), 4))
      assert.equal(peak, overlap)
      assert.deepEqual(visited.sort((a, b) => a[1] - b[1]), [[4, 0], [5, 1], [6, 2], [7, 3]])
    }
    const errors: unknown[] = []
    const saved = console.error
    console.error = error => errors.push(error)
    const failure = new Error('oracle callback')
    const seen: number[] = []
    try {
      await runParallel([1, 2, 3], async (value) => {
        seen.push(value)
        if (value === 2)
          throw failure
      }, { concurrency: 2 })
    }
    finally { console.error = saved }
    assert.deepEqual(seen.sort(), [1, 2, 3])
    assert.deepEqual(errors, [failure])
    assert.equal(truncateString('abcdef', 5), 'ab...')
    assert.equal(truncateString('abc', 3), 'abc')
  }
  else if (task === 'unhead-real-caller') {
    const { isUnsafeKey } = require('./packages/unhead/src/utils/unsafeKey.js') as { isUnsafeKey: (key: string) => boolean }
    const { walkResolver } = require('./packages/unhead/src/utils/walkResolver.js') as { walkResolver: (input: unknown) => unknown }
    for (const key of ['__proto__', 'constructor', 'prototype']) assert.equal(isUnsafeKey(key), true)
    for (const key of ['', 'safe', 'Prototype', 'constructorName']) assert.equal(isUnsafeKey(key), false)
    const input = { title: 'safe', nested: [1, 2] }
    assert.equal(walkResolver(input), input)
    assert.deepEqual(walkResolver({ title: () => 'resolved', prototype: 'unsafe', nested: [() => 4] }), { title: 'resolved', nested: [4] })
    assert.deepEqual(walkResolver(JSON.parse('{"__proto__":{"polluted":true},"safe":2}')), { safe: 2 })
  }
  else {
    throw new Error('Unknown check task.')
  }
  if (provenance) {
    const captured = JSON.parse(readFileSync(provenance, 'utf8')) as { scenario: { id: string, file: string }, capture: { files: Record<string, string> } }[]
    const selected = captured.find(row => row.scenario.id === task)!
    const functionName = task === 'link-checker-concurrency' ? 'runParallel' : 'isUnsafeKey'
    const withoutBody = (source: string) => {
      const parsed = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true)
      const declaration = parsed.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === functionName)
      assert.ok(declaration && ts.isFunctionDeclaration(declaration) && declaration.body, 'Preserve the named function.')
      return `${source.slice(0, declaration.body.getStart(parsed))}<body>${source.slice(declaration.body.end)}`
    }
    assert.equal(withoutBody(readFileSync(join(project, selected.scenario.file), 'utf8')), withoutBody(selected.capture.files[selected.scenario.file]), 'Preserve everything outside the repaired body.')
    const json = (name: string) => JSON.parse(readFileSync(join(project, '.checks', `${name}.json`), 'utf8'))
    const red = json('red')
    const green = json('green')
    const result = (value: typeof red) => value.data?.result ?? value.result
    if (result(red)) {
      assert.equal(result(red)._tag, 'Failed')
      assert.ok(result(red).counts.failed > 0)
      assert.equal(result(green)._tag, 'Passed')
      assert.ok(result(green).counts.passed > 0)
    }
    else {
      assert.equal(red.success, false)
      assert.ok(red.numFailedTests > 0)
      assert.equal(green.success, true)
      assert.ok(green.numPassedTests > 0)
    }
    const called = readFileSync(join(process.env.RIPIDE_EXPERIMENT_RECORD_DIRECTORY!, 'commands.called'), 'utf8').trim().split('\n')
    const commandFile = join(process.env.RIPIDE_EXPERIMENT_RECORD_DIRECTORY!, 'check-commands.jsonl')
    const commands = readFileSync(commandFile, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { name: string, args: string[], started: string, assertionHash: string | null, sourceHash: string | null, exit: number })
    const evidence = (color: string) => commands.filter(command => command.args.some(arg => arg.endsWith(`.checks/${color}.json`))).at(-1)
    const before = evidence('red')
    const after = evidence('green')
    assert.ok(before?.assertionHash && after?.assertionHash, 'Record both assertion sources.')
    assert.equal(before.exit, 1, 'Record a failing execution before repair.')
    assert.equal(after.exit, 0, 'Record a passing execution after repair.')
    assert.equal(before.assertionHash, after.assertionHash, 'Reuse identical assertions for red and green.')
    assert.equal(before.sourceHash, sha256(selected.capture.files[selected.scenario.file]), 'Run red against the seeded source.')
    assert.equal(after.sourceHash, sha256(readFileSync(join(project, selected.scenario.file))), 'Run green against the submitted source.')
    assert.ok(before.started < after.started, 'Record red before green.')
    if (mode === 'forced') {
      assert.ok(called.includes('ripide'), 'Use the supplied check command.')
      assert.equal(before.name, 'ripide', 'Use transient checks for red.')
      assert.equal(after.name, 'ripide', 'Use transient checks for green.')
    }
    if (mode === 'direct') {
      assert.ok(called.includes('vitest'))
      assert.ok(!called.includes('ripide'))
      assert.equal(before.name, 'vitest')
      assert.equal(after.name, 'vitest')
    }
    let checklist: unknown = { _tag: 'Unavailable', reason: 'Ordinary Vitest does not record check receipts.' }
    if (after.name === 'ripide') {
      const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
      const record = process.env.RIPIDE_EXPERIMENT_RECORD_DIRECTORY!
      const output = execFileSync(process.execPath, [join(root, 'packages/cli/bin/ripide.mjs'), 'check', '--base', 'HEAD', '--profile', 'full', '--json'], { cwd: project, env: { ...process.env, HOME: join(record, 'home') }, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      const value = JSON.parse(output) as { data: { checklist: { items: { kind: string, status: string }[], counts: unknown } } }
      assert.ok(value.data.checklist.items.filter(item => item.kind === 'integration' || item.kind === 'api' || item.kind === 'manual').every(item => item.status !== 'executed'), 'Keep assertion review separate from execution.')
      assert.ok(value.data.checklist.items.some(item => item.kind === 'unit' && item.status === 'executed'), 'Record execution of the repaired function.')
      checklist = value.data.checklist
    }
    writeFileSync(join(project, '.checks', 'quality.json'), JSON.stringify({ _tag: 'Passed', newTestFiles: 0, assertionHash: before.assertionHash, workflow: after.name, checklist }))
  }
  console.log('Independent Node behavior checks passed.')
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
