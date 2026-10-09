import type { Engine } from '@ripast/core'
import process from 'node:process'
import { projectEngine } from './composition.ts'

export * from '@ripast/core'
export async function scan(...args: Parameters<Engine['scan']>) {
  const options = args.at(-1)
  const cwd = typeof options === 'object' && options && 'cwd' in options ? options.cwd : process.cwd()
  const enabled = typeof options === 'object' && options && 'vue' in options ? options.vue !== false : true
  const engine = await projectEngine(cwd, enabled)
  return (engine.scan as (...params: Parameters<Engine['scan']>) => ReturnType<Engine['scan']>)(...args)
}
export async function buildScanGraph(...args: Parameters<Engine['buildScanGraph']>) {
  const options = args.at(-1)
  const cwd = typeof options === 'object' && options && 'cwd' in options ? options.cwd : process.cwd()
  const enabled = typeof options === 'object' && options && 'vue' in options ? options.vue !== false : true
  const engine = await projectEngine(cwd, enabled)
  return (engine.buildScanGraph as (...params: Parameters<Engine['buildScanGraph']>) => ReturnType<Engine['buildScanGraph']>)(...args)
}
export async function buildDeclarationTree(...args: Parameters<Engine['buildDeclarationTree']>) {
  const options = args.at(-1)
  const cwd = typeof options === 'object' && options && 'cwd' in options ? options.cwd : process.cwd()
  const enabled = typeof options === 'object' && options && 'vue' in options ? options.vue !== false : true
  const engine = await projectEngine(cwd, enabled)
  return (engine.buildDeclarationTree as (...params: Parameters<Engine['buildDeclarationTree']>) => ReturnType<Engine['buildDeclarationTree']>)(...args)
}
export async function buildUnusedDeclarations(...args: Parameters<Engine['buildUnusedDeclarations']>) {
  const options = args.at(-1)
  const cwd = typeof options === 'object' && options && 'cwd' in options ? options.cwd : process.cwd()
  const enabled = typeof options === 'object' && options && 'vue' in options ? options.vue !== false : true
  const engine = await projectEngine(cwd, enabled)
  return (engine.buildUnusedDeclarations as (...params: Parameters<Engine['buildUnusedDeclarations']>) => ReturnType<Engine['buildUnusedDeclarations']>)(...args)
}
export async function runRename(...args: [
    arg0: string,
    arg1: string,
    options?: Parameters<Engine['runRename']>[2] & {
      vue?: boolean
    },
]) {
  const options = args.at(-1)
  const cwd = typeof options === 'object' && options && 'cwd' in options ? options.cwd : process.cwd()
  const enabled = typeof options === 'object' && options && 'vue' in options ? options.vue !== false : true
  const engine = await projectEngine(cwd, enabled)
  return (engine.runRename as (...params: Parameters<Engine['runRename']>) => ReturnType<Engine['runRename']>)(...args)
}
export async function runMove(...args: [
    arg0: string,
    arg1: string,
    arg2: string,
    options?: Parameters<Engine['runMove']>[3] & {
      vue?: boolean
    },
]) {
  const options = args.at(-1)
  const cwd = typeof options === 'object' && options && 'cwd' in options ? options.cwd : process.cwd()
  const enabled = typeof options === 'object' && options && 'vue' in options ? options.vue !== false : true
  const engine = await projectEngine(cwd, enabled)
  return (engine.runMove as (...params: Parameters<Engine['runMove']>) => ReturnType<Engine['runMove']>)(...args)
}
export async function runDelete(...args: Parameters<Engine['runDelete']>) {
  const options = args.at(-1)
  const cwd = typeof options === 'object' && options && 'cwd' in options ? options.cwd : process.cwd()
  const enabled = typeof options === 'object' && options && 'vue' in options ? options.vue !== false : true
  const engine = await projectEngine(cwd, enabled)
  return (engine.runDelete as (...params: Parameters<Engine['runDelete']>) => ReturnType<Engine['runDelete']>)(...args)
}
export async function runRenameFile(...args: [
    arg0: string,
    arg1: string,
    options?: Parameters<Engine['runRenameFile']>[2] & {
      vue?: boolean
    },
]) {
  const options = args.at(-1)
  const cwd = typeof options === 'object' && options && 'cwd' in options ? options.cwd : process.cwd()
  const enabled = typeof options === 'object' && options && 'vue' in options ? options.vue !== false : true
  const engine = await projectEngine(cwd, enabled)
  return (engine.runRenameFile as (...params: Parameters<Engine['runRenameFile']>) => ReturnType<Engine['runRenameFile']>)(...args)
}
export async function runReplace(...args: Parameters<Engine['runReplace']>) {
  const options = args.at(-1)
  const cwd = typeof options === 'object' && options && 'cwd' in options ? options.cwd : process.cwd()
  const enabled = typeof options === 'object' && options && 'vue' in options ? options.vue !== false : true
  const engine = await projectEngine(cwd, enabled)
  return (engine.runReplace as (...params: Parameters<Engine['runReplace']>) => ReturnType<Engine['runReplace']>)(...args)
}
export async function runCssClassScan(...args: Parameters<Engine['runCssClassScan']>) {
  const options = args.at(-1)
  const cwd = typeof options === 'object' && options && 'cwd' in options ? options.cwd : process.cwd()
  const enabled = typeof options === 'object' && options && 'vue' in options ? options.vue !== false : true
  const engine = await projectEngine(cwd, enabled)
  return (engine.runCssClassScan as (...params: Parameters<Engine['runCssClassScan']>) => ReturnType<Engine['runCssClassScan']>)(...args)
}
export async function runCssClassFileScan(...args: Parameters<Engine['runCssClassFileScan']>) {
  const options = args.at(-1)
  const cwd = typeof options === 'object' && options && 'cwd' in options ? options.cwd : process.cwd()
  const enabled = typeof options === 'object' && options && 'vue' in options ? options.vue !== false : true
  const engine = await projectEngine(cwd, enabled)
  return (engine.runCssClassFileScan as (...params: Parameters<Engine['runCssClassFileScan']>) => ReturnType<Engine['runCssClassFileScan']>)(...args)
}
export async function runCssClassRename(...args: Parameters<Engine['runCssClassRename']>) {
  const options = args.at(-1)
  const cwd = typeof options === 'object' && options && 'cwd' in options ? options.cwd : process.cwd()
  const enabled = typeof options === 'object' && options && 'vue' in options ? options.vue !== false : true
  const engine = await projectEngine(cwd, enabled)
  return (engine.runCssClassRename as (...params: Parameters<Engine['runCssClassRename']>) => ReturnType<Engine['runCssClassRename']>)(...args)
}
export async function runDoctor(...args: Parameters<Engine['runDoctor']>) {
  const options = args.at(-1)
  const cwd = typeof options === 'object' && options && 'cwd' in options ? options.cwd : process.cwd()
  const enabled = typeof options === 'object' && options && 'vue' in options ? options.vue !== false : true
  const engine = await projectEngine(cwd, enabled)
  return (engine.runDoctor as (...params: Parameters<Engine['runDoctor']>) => ReturnType<Engine['runDoctor']>)(...args)
}
export async function buildComponentInventory(...args: Parameters<Engine['buildComponentInventory']>) {
  const options = args.at(-1)
  const cwd = typeof options === 'object' && options && 'cwd' in options ? options.cwd : process.cwd()
  const enabled = typeof options === 'object' && options && 'vue' in options ? options.vue !== false : true
  const engine = await projectEngine(cwd, enabled)
  return (engine.buildComponentInventory as (...params: Parameters<Engine['buildComponentInventory']>) => ReturnType<Engine['buildComponentInventory']>)(...args)
}
export async function buildComponentDetail(...args: Parameters<Engine['buildComponentDetail']>) {
  const options = args.at(-1)
  const cwd = typeof options === 'object' && options && 'cwd' in options ? options.cwd : process.cwd()
  const enabled = typeof options === 'object' && options && 'vue' in options ? options.vue !== false : true
  const engine = await projectEngine(cwd, enabled)
  return (engine.buildComponentDetail as (...params: Parameters<Engine['buildComponentDetail']>) => ReturnType<Engine['buildComponentDetail']>)(...args)
}
export async function runVueTemplateWrap(...args: Parameters<typeof import('@ripast/vue').runVueTemplateWrap>) {
  const module = await import('@ripast/vue')
  return module.runVueTemplateWrap(...args)
}
export async function runVueTemplateUnwrap(...args: Parameters<typeof import('@ripast/vue').runVueTemplateUnwrap>) {
  const module = await import('@ripast/vue')
  return module.runVueTemplateUnwrap(...args)
}
export async function applyOperation(result: Parameters<Engine['apply']>[0]) {
  const engine = await projectEngine()
  engine.apply(result)
}
