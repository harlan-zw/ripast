import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveNativeTsc, runRenameFile, writeChanges } from '@ripast/core'
import { expect, it } from 'vitest'
import { vueServices } from './engine-fixture.ts'
import { makeFixture } from './helpers.ts'

it.each(['touched', 'project'] as const)('verifies an aliased rename into a new directory with %s scope', async (verify) => {
  const fx = makeFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'ESNext',
        moduleResolution: 'bundler',
        paths: { '@/*': ['./src/*'] },
        strict: true,
        noEmit: true,
      },
      include: ['src/**/*.ts'],
    }),
    'src/Counter.ts': 'export const count = 1\n',
    'src/main.ts': 'import { count } from \'@/Counter\'\nexport const result: number = count\n',
  })
  try {
    expect(spawnSync(resolveNativeTsc(), ['--noEmit', '-p', join(fx.dir, 'tsconfig.json')], { encoding: 'utf8' }).status).toBe(0)
    const result = await runRenameFile('src/Counter.ts', 'src/components/Count.ts', { ...{ cwd: fx.dir, verify }, engine: vueServices() })
    expect(result.regressions).toEqual([])
    expect(result.changes.map(change => change.after)).toEqual([
      'import { count } from \'@/components/Count\'\nexport const result: number = count\n',
    ])
    expect(existsSync(join(fx.dir, 'src/components'))).toBe(false)
    expect(fx.read('src/main.ts')).toBe('import { count } from \'@/Counter\'\nexport const result: number = count\n')
    writeChanges(result.changes)
    mkdirSync(join(fx.dir, 'src/components'))
    renameSync(result.fileMove.from, result.fileMove.to)
    if (result.selfChange)
      writeFileSync(result.fileMove.to, result.selfChange.after)
    const checked = spawnSync(resolveNativeTsc(), ['--noEmit', '-p', join(fx.dir, 'tsconfig.json')], { encoding: 'utf8' })
    expect(checked.stdout + checked.stderr).toBe('')
    expect(checked.status).toBe(0)
  }
  finally {
    fx.cleanup()
  }
})

it.each(['touched', 'project'] as const)('keeps unresolved dependencies in the moved file with %s scope', async (verify) => {
  const fx = makeFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', paths: { '@/*': ['./src/*'] }, noEmit: true },
      include: ['src/**/*.ts'],
    }),
    'src/Counter.ts': 'export { missing } from \'@/components/Count\'\nexport const count = 1\n',
    'src/main.ts': 'import { count } from \'@/Counter\'\nexport const result = count\n',
  })
  try {
    const result = await runRenameFile('src/Counter.ts', 'src/components/Count.ts', { ...{ cwd: fx.dir, verify }, engine: vueServices() })
    expect(result.regressions.map(({ file, code, message }) => ({ file, code, message }))).toEqual([{
      file: join(fx.dir, 'src/components/Count.ts'),
      code: 2307,
      message: 'Cannot find module \'@/components/Count\' or its corresponding type declarations.',
    }])
    expect(existsSync(join(fx.dir, 'src/components'))).toBe(false)
  }
  finally {
    fx.cleanup()
  }
})

it.each(['touched', 'project'] as const)('reports a package import that loses its scope after the move with %s verification', async (verify) => {
  const fx = makeFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', paths: { '@/*': ['./src/*'] }, noEmit: true },
      include: ['src/**/*.ts'],
    }),
    'src/features/package.json': JSON.stringify({ name: 'feature', imports: { '#dependency': './dependency.ts' } }),
    'src/features/dependency.ts': 'export const count = 1\n',
    'src/features/Counter.ts': 'export { count } from \'#dependency\'\n',
    'src/main.ts': 'import { count } from \'@/features/Counter\'\nexport const result = count\n',
  })
  try {
    expect(spawnSync(resolveNativeTsc(), ['--noEmit', '-p', join(fx.dir, 'tsconfig.json')], { encoding: 'utf8' }).status).toBe(0)
    const result = await runRenameFile('src/features/Counter.ts', 'src/components/Count.ts', { ...{ cwd: fx.dir, verify }, engine: vueServices() })
    expect(result.regressions.map(({ file, code, message }) => ({ file, code, message }))).toEqual([{
      file: join(fx.dir, 'src/components/Count.ts'),
      code: 2307,
      message: 'Cannot find module \'#dependency\' or its corresponding type declarations.',
    }])
    expect(existsSync(join(fx.dir, 'src/components'))).toBe(false)
  }
  finally {
    fx.cleanup()
  }
})

it.each(['touched', 'project'] as const)('verifies an aliased rename into an existing directory with %s scope', async (verify) => {
  const fx = makeFixture({
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'bundler', paths: { '@/*': ['./src/*'] }, noEmit: true },
      include: ['src/**/*.ts'],
    }),
    'src/Counter.ts': 'export const count = 1\n',
    'src/main.ts': 'export { count } from \'@/Counter\'\n',
  })
  try {
    mkdirSync(join(fx.dir, 'src/components'))
    const result = await runRenameFile('src/Counter.ts', 'src/components/Count.ts', { ...{ cwd: fx.dir, verify }, engine: vueServices() })
    expect(result.regressions).toEqual([])
    expect(result.changes.map(change => change.after)).toEqual(['export { count } from \'@/components/Count\'\n'])
    expect(existsSync(join(fx.dir, 'src/components/Count.ts'))).toBe(false)
  }
  finally {
    fx.cleanup()
  }
})
