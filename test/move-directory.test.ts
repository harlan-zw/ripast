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

it.each(['touched', 'project'] as const)('keeps a moved dependency error with %s verification', async (verify) => {
  const fx = makeFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', jsx: 'preserve', noEmit: true },
      include: ['src/**/*.ts', 'src/**/*.tsx'],
    }),
    'src/features/package.json': JSON.stringify({ name: 'feature', imports: { '#dependency': './dependency.ts' } }),
    'src/features/dependency.ts': 'export const count = 1\n',
    'src/features/Counter.tsx': 'import { count } from \'#dependency\'\nexport function Counter() { return count }\n',
    'src/App.tsx': 'import { Counter } from \'./features/Counter\'\nexport const result = Counter()\n',
  })
  try {
    expect(spawnSync(resolveNativeTsc(), ['--noEmit', '-p', join(fx.dir, 'tsconfig.json')], { encoding: 'utf8' }).status).toBe(0)
    const result = await runMove('Counter', 'src/features/Counter.tsx', 'src/components/Counter.tsx', { cwd: fx.dir, vue: false, verify })
    expect(result.regressions.map(({ file, code, message }) => ({ file, code, message }))).toEqual([{
      file: join(fx.dir, 'src/components/Counter.tsx'),
      code: 2307,
      message: 'Cannot find module \'#dependency\' or its corresponding type declarations.',
    }])
    expect(existsSync(join(fx.dir, 'src/components'))).toBe(false)
  }
  finally {
    fx.cleanup()
  }
})

it.each(['touched', 'project'] as const)('verifies extensionless TSX consumers in a new directory with %s scope', async (verify) => {
  const fx = makeFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', jsx: 'preserve', paths: { '@/*': ['./src/*'] }, noEmit: true },
      include: ['src/**/*.ts', 'src/**/*.tsx'],
    }),
    'src/dependency.ts': 'export const count = 1\n',
    'src/Counter.tsx': 'import { count } from \'@/dependency\'\nexport interface CounterProps { start: number }\nexport function Counter(props: CounterProps) { return count + props.start }\n',
    'src/App.tsx': 'import { Counter } from \'./Counter\'\nexport const result = Counter({ start: 2 })\n',
  })
  try {
    expect(spawnSync(resolveNativeTsc(), ['--noEmit', '-p', join(fx.dir, 'tsconfig.json')], { encoding: 'utf8' }).status).toBe(0)
    const result = await runMove('Counter', 'src/Counter.tsx', 'src/components/Counter.tsx', { cwd: fx.dir, vue: false, verify })
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
