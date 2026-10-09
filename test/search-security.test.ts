import assert from 'node:assert/strict'
import { join } from 'node:path'
import { rgFiles, rgFilesMany } from 'ripide-api/adapter'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

it.each(['--version', '--pre=missing-command', '-e', '-n'])('search treats %s as text, without enabling ripgrep options', (pattern) => {
  const fx = makeFixture({ 'match.ts': `// ${pattern}\n`, 'other.ts': '// unrelated\n' }, false)
  try {
    const expected = [join(fx.dir, 'match.ts')]
    assert.deepEqual(rgFiles(pattern, { cwd: fx.dir }), expected)
    assert.deepEqual(rgFiles(pattern, { cwd: fx.dir, fixedStrings: false }), expected)
    assert.deepEqual(rgFilesMany([pattern], { cwd: fx.dir }), expected)
  }
  finally { fx.cleanup() }
})
