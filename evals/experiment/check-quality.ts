import assert from 'node:assert/strict'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import ts from 'typescript'

async function main() {
  const [project, task, provenance, mode] = process.argv.slice(2)
  function authored(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
      ['node_modules', '.git', '.build'].includes(entry.name) ? [] : entry.isDirectory() ? authored(join(directory, entry.name)) : [join(directory, entry.name)])
  }
  const paths = authored(project)
  assert.deepEqual(paths.filter(path => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path)), [], 'Remove every temporary test module.')
  const build = join(project, '.build')
  mkdirSync(build, { recursive: true })
  writeFileSync(join(build, 'package.json'), '{"type":"commonjs"}')
  for (const path of paths.filter(path => path.endsWith('.ts') && !relative(project, path).startsWith('.checks/'))) {
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
    if (mode === 'forced')
      assert.ok(called.includes('ripide'), 'Use the supplied check command.')
    if (mode === 'direct') {
      assert.ok(called.includes('vitest'))
      assert.ok(!called.includes('ripide'))
    }
    writeFileSync(join(project, '.checks', 'quality.json'), JSON.stringify({ _tag: 'Passed', testFiles: 0, workflow: called.includes('ripide') ? 'ripide' : 'vitest' }))
  }
  console.log('Independent Node behavior checks passed.')
}
main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
