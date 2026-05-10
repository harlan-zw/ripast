import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { it } from 'vitest'
import { runReplace } from '../packages/core/src/replace.ts'
import { writeChanges } from '../packages/core/src/util.ts'
import { makeFixture } from './helpers.ts'

it('replace swaps an imported symbol and rewrites the import', async () => {
  const fx = makeFixture({
    'utils.ts': 'export function defineAdminApiHandler(fn: Function) { return fn }\n',
    'route.ts': 'import { eventHandler } from \'h3\'\nexport default eventHandler(async () => 1)\n',
  })
  try {
    const result = await runReplace('eventHandler', 'defineAdminApiHandler', { cwd: fx.dir, verify: false })
    writeChanges(result.changes)
    const route = fx.read('route.ts')
    assert.match(route, /import \{ defineAdminApiHandler \} from ["']\.\/utils\.ts["']/)
    assert.doesNotMatch(route, /eventHandler/)
    assert.match(route, /export default defineAdminApiHandler\(async \(\) => 1\)/)
  }
  finally { fx.cleanup() }
})

it('replace removes one old named import from a mixed import', async () => {
  const fx = makeFixture({
    'utils.ts': 'export function better() { return 1 }\n',
    'old.ts': 'export function old() { return 0 }\nexport function keep() { return 2 }\n',
    'use.ts': 'import { old, keep } from \'./old.ts\'\nexport const value = old() + keep()\n',
  })
  try {
    const result = await runReplace('old', 'better', { cwd: fx.dir, verify: false })
    writeChanges(result.changes)
    const use = fx.read('use.ts')
    assert.match(use, /import \{ keep \} from '\.\/old\.ts'/)
    assert.match(use, /import \{ better \} from ["']\.\/utils\.ts["']/)
    assert.match(use, /better\(\) \+ keep\(\)/)
  }
  finally { fx.cleanup() }
})

it('replace preserves aliased old imports by replacing local references', async () => {
  const fx = makeFixture({
    'utils.ts': 'export function next() { return 1 }\n',
    'old.ts': 'export function old() { return 0 }\n',
    'use.ts': 'import { old as current } from \'./old.ts\'\nexport const value = current()\n',
  })
  try {
    const result = await runReplace('current', 'next', { cwd: fx.dir, verify: false })
    writeChanges(result.changes)
    const use = fx.read('use.ts')
    assert.doesNotMatch(use, /current/)
    assert.doesNotMatch(use, /old as/)
    assert.match(use, /import \{ next \} from ["']\.\/utils\.ts["']/)
    assert.match(use, /next\(\)/)
  }
  finally { fx.cleanup() }
})

it('replace CLI dry-run prints a diff without writing', () => {
  const fx = makeFixture({
    'utils.ts': 'export function better() { return 1 }\n',
    'old.ts': 'export function old() { return 0 }\n',
    'use.ts': 'import { old } from \'./old.ts\'\nexport const value = old()\n',
  })
  try {
    const cli = resolve(process.cwd(), 'packages/cli/src/cli.ts')
    const out = execFileSync(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', cli, 'replace', 'old', 'better', '--no-verify', '--profile', 'full'],
      { cwd: fx.dir, encoding: 'utf8' },
    )
    assert.match(out, /1 file, \+3 -2 lines/)
    assert.match(out, /better\(\)/)
    assert.match(fx.read('use.ts'), /old\(\)/)
  }
  finally { fx.cleanup() }
})
