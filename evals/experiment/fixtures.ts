import { readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveNativeTsc } from 'ripide-api'
import { parseManifest, sha256 } from './manifest.ts'

export function createFixtureManifest(root: string, repeats = 1, installed = false, nuxt = false) {
  const worker = fileURLToPath(new URL('./fixture-worker.ts', import.meta.url))
  const check = fileURLToPath(new URL('./fixture-check.ts', import.meta.url))
  const cli = join(root, 'packages/cli/bin/ripide.mjs')
  const files = (directory: string): string[] => readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    return statSync(path).isDirectory() ? files(path) : [path]
  })
  const native = resolveNativeTsc()
  const pinned = [process.execPath, native, createRequire(import.meta.url).resolve('typescript'), ...files(join(root, 'packages/core/dist')), ...files(join(root, 'packages/cli/dist')), ...files(join(root, 'packages/vue/dist')), ...files(join(root, 'evals/experiment'))]
  const prompts: Record<string, string> = {
    'rename': 'Rename the exported old symbol in api.ts to next. Update its references. Preserve unrelated local old bindings.',
    'move': 'Move the exported old declaration from api.ts to target.ts. Update its imports. Preserve its name and unrelated bindings.',
    'rename-file': 'Rename api.ts to renamed.ts. Update imports and remove the original file. Preserve exported names and unrelated bindings.',
    'replace': 'Replace imported old references with replacement from target.ts. Preserve api.ts and unrelated local old bindings.',
    'architecture': 'Add policy.ts exporting permitted(value: number): boolean, returning value > 0. Use permitted(1) for consumer.ts result. Preserve unrelated comments and bindings.',
    'mixed': 'Rename the exported old symbol in api.ts to next. Update its references. Add policy.ts exporting permitted(value: number): boolean, returning value > 0. Preserve unrelated bindings and comments.',
  }
  const manifest = {
    id: 'scripted-transport-pilot',
    study: 'pilot',
    pilotHash: null,
    seed: 20261009,
    repeats,
    cache: 'uncontrolled',
    timeoutMs: nuxt ? 180000 : 30000,
    repairs: 0,
    tracing: 'strace',
    commonInstructions: 'Follow the fixed task. Preserve unrelated bindings, comments, and assets.',
    artifacts: [...new Set([worker, check, cli, join(root, 'pnpm-lock.yaml'), ...pinned])].map(path => ({ path, sha256: sha256(readFileSync(path)) })),
    versions: [[process.execPath, '--version'], [native, '--version'], ['pnpm', '--version'], ['/usr/bin/strace', '--version']],
    runners: Object.fromEntries(['direct', 'forced', 'hybrid'].map(mode => [mode, { model: 'scripted', reasoning: 'none', command: [process.execPath, worker, '{mode}', '{task}', '{project}', cli] }])),
    tasks: ['rename', 'move', 'rename-file', 'replace', 'architecture', 'mixed', ...(installed ? ['installed-rename'] : [])].map((id) => {
      const operation = id.replace('installed-', '')
      const consumer = 'import { old } from \'./api\'\nexport const result = old\n// old stays in this comment\nexport function unrelated(){const old = 2;return old}\n'
      const source: Record<string, string> = {
        'api.ts': 'export const old = 1\n',
        'consumer.ts': consumer,
        'target.ts': operation === 'replace' ? 'export const replacement = 2\n' : '',
        'notes.txt': 'Preserve old in non-source files.\n',
        'package.json': '{"name":"experiment-fixture","private":true,"type":"module"}\n',
        'tsconfig.json': '{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"Bundler","strict":true,"noEmit":true},"include":["*.ts"]}\n',
      }
      if (id.startsWith('installed-')) {
        Object.assign(source, {
          'dependency/package.json': '{"name":"fixture-dependency","version":"1.0.0","type":"module","exports":"./index.js"}\n',
          'dependency/index.js': 'export const base = 1\n',
          'dependency/index.d.ts': 'export declare const base: number\n',
          'package.json': '{"name":"experiment-fixture","private":true,"type":"module","dependencies":{"fixture-dependency":"file:./dependency"}}\n',
        })
      }
      const expected: Record<string, string | null> = {}
      if (operation === 'rename' || operation === 'mixed') {
        expected['api.ts'] = 'export const next = 1\n'
        expected['consumer.ts'] = consumer.replace('{ old }', '{ next }').replace('result = old', 'result = next')
      }
      if (operation === 'move') {
        expected['api.ts'] = ''
        expected['target.ts'] = source['api.ts']
        expected['consumer.ts'] = consumer.replace('\'./api\'', '\'./target\'')
      }
      if (operation === 'rename-file') {
        expected['api.ts'] = null
        expected['renamed.ts'] = source['api.ts']
        expected['consumer.ts'] = consumer.replace('\'./api\'', '\'./renamed\'')
      }
      if (operation === 'replace')
        expected['consumer.ts'] = consumer.replace('{ old }', '{ replacement }').replace('\'./api\'', '\'./target\'').replace('result = old', 'result = replacement')
      if (operation === 'architecture') {
        expected['policy.ts'] = 'export function permitted(value: number): boolean { return value > 0 }\n'
        expected['consumer.ts'] = consumer.replace('import { old } from \'./api\'', 'import { permitted } from \'./policy\'').replace('result = old', 'result = permitted(1)')
      }
      if (operation === 'mixed')
        expected['policy.ts'] = 'export function permitted(value: number): boolean { return value > 0 }\n'
      const name = operation === 'rename' || operation === 'mixed' ? 'next' : operation === 'replace' ? 'replacement' : 'old'
      const declaration = operation === 'move' || operation === 'replace' ? 'target.ts' : operation === 'rename-file' ? 'renamed.ts' : 'api.ts'
      return { id, cohort: operation === 'architecture' ? 'architecture' : operation === 'mixed' ? 'mixed' : 'mechanical', operation, prompt: prompts[operation], source: { files: source }, expected, generatedDirectories: ['.build'], setup: id.startsWith('installed-') ? [{ command: ['pnpm', 'install', '--offline', '--ignore-scripts'], phase: 'setup', role: 'controller' }] : [], checks: [{ command: [process.execPath, check, '{project}'], phase: 'verification', role: 'controller' }], symbols: operation === 'architecture' ? [] : [{ declaration: { file: declaration, name }, references: [{ file: 'consumer.ts', name, occurrence: 0 }, { file: 'consumer.ts', name, occurrence: 1 }] }], qualityGates: [{ id: 'protected-plan-capability', command: [process.execPath, join(root, 'evals/experiment/capability-gate.ts')], required: false }] }
    }),
  }
  if (nuxt) {
    const vue = '<script setup lang="ts">\nconst value = old()\n// old comment remains\nfunction unrelated(){const old=2;return old}\n</script>\n<template><div>{{ value }}</div></template>\n'
    manifest.tasks.push({ id: 'nuxt-rename', cohort: 'mechanical', operation: 'nuxt-rename', prompt: 'Rename the exported old composable to next. Preserve unrelated bindings, comments, and assets.', source: { files: {
      'package.json': '{"name":"nuxt-experiment-fixture","private":true,"type":"module","dependencies":{"nuxt":"4.5.2","vue":"3.5.42"},"devDependencies":{"typescript":"6.0.2","vue-tsc":"3.3.11"}}\n',
      'nuxt.config.ts': 'export default defineNuxtConfig({devtools:{enabled:false}, compatibilityDate:"2026-10-09"})\n',
      'tsconfig.json': '{"extends":"./.nuxt/tsconfig.json"}\n',
      'pnpm-lock.yaml': readFileSync(new URL('./fixtures/nuxt-lock.yaml', import.meta.url), 'utf8'),
      'app/composables/count.ts': 'export const old = () => 1\n',
      'app/app.vue': vue,
      'public/notes.txt': 'Preserve old in non-source files.\n',
    } } as typeof manifest.tasks[number]['source'], expected: { 'app/composables/count.ts': 'export const next = () => 1\n', 'app/app.vue': vue.replace('old()', 'next()') }, generatedDirectories: ['.nuxt', '.output'], setup: [{ command: ['pnpm', 'install', '--offline', '--ignore-scripts', '--frozen-lockfile'], phase: 'setup', role: 'controller' }, { command: ['pnpm', 'exec', 'nuxt', 'prepare'], phase: 'setup', role: 'controller' }], checks: [{ command: ['pnpm', 'exec', 'nuxt', 'prepare'], phase: 'verification', role: 'controller' }, { command: ['pnpm', 'exec', 'nuxt', 'typecheck'], phase: 'verification', role: 'controller' }, { command: ['pnpm', 'exec', 'nuxt', 'build'], phase: 'verification', role: 'controller' }], symbols: [], qualityGates: [{ id: 'protected-plan-capability', command: [process.execPath, join(root, 'evals/experiment/capability-gate.ts')], required: false }] })
  }
  const parsed = parseManifest(manifest)
  if (parsed._tag === 'Err')
    throw new Error(parsed.message)
  return parsed.value
}
