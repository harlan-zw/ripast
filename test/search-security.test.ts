import assert from 'node:assert/strict'
import { join } from 'node:path'
import { findFiles, findFilesMany } from '@ripast/core/adapter'
import { it } from 'vitest'
import { makeGitFixture } from './helpers.ts'

it.each(['--version', '--pre=missing-command', '-e', '-n'])('search treats %s as text, without enabling Git options', (pattern) => {
  const fx = makeGitFixture({ 'match.ts': `// ${pattern}\n`, 'other.ts': '// unrelated\n' }, false)
  try {
    const expected = [join(fx.dir, 'match.ts')]
    assert.deepEqual(findFiles(pattern, { cwd: fx.dir }), expected)
    assert.deepEqual(findFiles(pattern, { cwd: fx.dir, fixedStrings: false }), expected)
    assert.deepEqual(findFilesMany([pattern], { cwd: fx.dir }), expected)
  }
  finally { fx.cleanup() }
})
