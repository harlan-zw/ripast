import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { resolveNativeTsc, runMove, writeChanges } from '../packages/core/src/index.ts'
import { makeFixture } from './helpers.ts'

it('moves a declaration with package imports into a new directory', async () => {
  const fx = makeFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', paths: { '@/*': ['./src/*'] }, noEmit: true },
      include: ['src/**/*.ts'],
    }),
    'src/dependency.ts': 'export const count = 1\n',
    'src/Counter.ts': 'import { count } from \'@/dependency\'\nexport function Counter() { return count }\n',
  })
  try {
    const result = await runMove('Counter', 'src/Counter.ts', 'src/components/Counter.ts', { cwd: fx.dir, vue: false })
    expect(result.regressions).toEqual([])
    expect(existsSync(join(fx.dir, 'src/components'))).toBe(false)
    writeChanges(result.changes)
    const checked = spawnSync(resolveNativeTsc(), ['--noEmit', '-p', join(fx.dir, 'tsconfig.json')], { encoding: 'utf8' })
    expect(checked.stdout + checked.stderr).toBe('')
    expect(checked.status).toBe(0)
  }
  finally {
    fx.cleanup()
  }
})
