import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { it } from 'vitest'
import { createEngine } from '../packages/core/src/index.ts'
import { createVueExtension } from '../packages/vue/src/index.ts'

function bindings(source: string) {
  const { descriptor } = parse(source)
  const script = ts.createSourceFile('consumer.ts', descriptor.scriptSetup?.content ?? '', ts.ScriptTarget.Latest, true)
  const imports = script.statements.flatMap(statement =>
    ts.isImportDeclaration(statement) && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings)
      ? statement.importClause.namedBindings.elements.map(binding => ({ imported: (binding.propertyName ?? binding.name).text, local: binding.name.text }))
      : [],
  )
  const calls: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression))
      calls.push(node.expression.text)
    ts.forEachChild(node, visit)
  }
  for (const expression of descriptor.template?.content.matchAll(/\{\{([^}]+)\}\}/g) ?? [])
    visit(ts.createSourceFile('template.ts', expression[1]!, ts.ScriptTarget.Latest, true))
  return { imports, calls }
}

it.each(['index', 'second'])('renames Vue imports through the %s barrel with their bound template calls', async (barrel) => {
  const cwd = mkdtempSync(join(tmpdir(), 'ripide-vue-barrel-'))
  const files = {
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, allowImportingTsExtensions: true }, include: ['src/**/*.ts', 'src/**/*.vue'] }),
    'src/money.ts': 'export function formatInvoice(n: number) { return String(n) }\n',
    'src/index.ts': 'export { formatInvoice } from "./money.ts"\n',
    'src/second.ts': 'export { formatInvoice } from "./index.ts"\n',
    'src/Public.vue': '<script setup lang="ts">\nimport { price } from "./public.ts"\n</script>\n<template>{{ price(100) }}</template>\n',
    'src/public.ts': 'export { formatInvoice as price } from "./money.ts"\n',
    'src/App.vue': `<script setup lang="ts">\nimport { formatInvoice } from "./${barrel}.ts"\nimport { formatInvoice as directPrice } from "./money.ts"\n</script>\n<template>{{ formatInvoice(100) }} {{ directPrice(100) }}</template>\n`,
    'src/Alias.vue': `<script setup lang="ts">\nimport { formatInvoice as price } from "./${barrel}.ts"\n</script>\n<template>{{ price(100) }}</template>\n`,
    'src/other.ts': 'export function formatInvoice(n: number) { return "other:" + n }\n',
    'src/Other.vue': '<script setup lang="ts">\nimport { formatInvoice } from "./other.ts"\n</script>\n<template>{{ formatInvoice(100) }}</template>\n',
  }
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true })
    writeFileSync(join(cwd, path), source)
  }
  try {
    const engine = createEngine({ extensions: [createVueExtension()] })
    const result = await engine.rename('formatInvoice', 'formatInvoiceAmount', { cwd, scope: 'src/money.ts', verifyMode: 'none' })
    const after = new Map(result.changes.map(change => [change.rel, change.after]))
    assert.deepEqual(bindings(after.get('src/App.vue')!), { imports: [{ imported: 'formatInvoiceAmount', local: 'formatInvoiceAmount' }, { imported: 'formatInvoiceAmount', local: 'directPrice' }], calls: ['formatInvoiceAmount', 'directPrice'] })
    assert.deepEqual(bindings(after.get('src/Alias.vue')!), { imports: [{ imported: 'formatInvoiceAmount', local: 'price' }], calls: ['price'] })
    assert.equal(after.get('src/Other.vue'), undefined)
    assert.equal(after.get('src/Public.vue'), undefined)
  }
  finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
