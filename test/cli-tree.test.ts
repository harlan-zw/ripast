import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { it } from 'vitest'
import { makeFixture } from './helpers.ts'

it.each(['agent', 'full'])('tree JSON respects export filters with the %s profile', (profile) => {
  const fixture = makeFixture({
    'source.ts': 'const hidden = 1\nexport const visible = hidden\n',
  })
  try {
    for (const [filter, names] of [['local', ['hidden']], ['exported', ['visible']]] as const) {
      const output = execFileSync(process.execPath, [
        '--experimental-strip-types',
        '--no-warnings',
        resolve('packages/cli/src/cli.ts'),
        'tree',
        '--profile',
        profile,
        '--exports',
        filter,
        '--json',
      ], { cwd: fixture.dir, encoding: 'utf8' })
      const tree = JSON.parse(output)
      assert.deepEqual((profile === 'agent' ? tree.results : tree.files).flatMap((file: { declarations: { name: string }[] }) => file.declarations.map(declaration => declaration.name)), names)
    }
  }
  finally { fixture.cleanup() }
})
