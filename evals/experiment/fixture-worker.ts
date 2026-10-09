import { spawnSync } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
// Scripted transport/grade pilot. These scripts do not model agent decisions or usage.
const [mode, task, project, cli] = process.argv.slice(2)
const operation = task.replace('installed-', '')
const read = (file: string) => readFileSync(join(project, file), 'utf8')
const write = (file: string, text: string) => writeFileSync(join(project, file), text)
if (operation === 'nuxt-rename') {
  if (mode === 'direct') {
    write('app/composables/count.ts', read('app/composables/count.ts').replace('const old', 'const next'))
    write('app/app.vue', read('app/app.vue').replace('old()', 'next()'))
  }
  else {
    const result = spawnSync(process.execPath, [cli, 'rename', 'old', 'next', '--scope', 'app/composables/count.ts', '--apply', '--profile', 'agent'], { cwd: project, stdio: 'inherit' })
    if (result.error)
      throw result.error
    if (result.status)
      process.exitCode = result.status
  }
}
else
  if (operation === 'architecture') {
    write('policy.ts', 'export function permitted(value: number): boolean { return value > 0 }\n')
    write('consumer.ts', read('consumer.ts').replace('import { old } from \'./api\'', 'import { permitted } from \'./policy\'').replace('result = old', 'result = permitted(1)'))
  }
  else
    if (mode !== 'direct') {
      const command = operation === 'rename' || operation === 'mixed'
        ? ['rename', 'old', 'next', '--scope', 'api.ts', '--apply', '--no-vue', '--profile', 'agent']
        : operation === 'move'
          ? ['move', 'old', '--from', 'api.ts', '--to', 'target.ts', '--apply', '--no-vue', '--profile', 'agent']
          : operation === 'replace'
            ? ['replace', 'old', 'replacement', '--target-scope', 'target.ts', '--apply', '--profile', 'agent']
            : ['rename-file', 'api.ts', 'renamed.ts', '--apply', '--no-vue', '--profile', 'agent']
      const result = spawnSync(process.execPath, [cli, ...command], { cwd: project, stdio: 'inherit' })
      if (result.error)
        throw result.error
      if (result.status)
        process.exitCode = result.status
    }
    else
      if (operation === 'rename' || operation === 'mixed') {
        write('api.ts', read('api.ts').replace('const old', 'const next'))
        write('consumer.ts', read('consumer.ts').replace('{ old }', '{ next }').replace('result = old', 'result = next'))
      }
      else
        if (operation === 'move') {
          write('api.ts', '')
          write('target.ts', 'export const old = 1\n')
          write('consumer.ts', read('consumer.ts').replace('\'./api\'', '\'./target\''))
        }
        else
          if (operation === 'replace') {
            write('consumer.ts', read('consumer.ts').replace('{ old }', '{ replacement }').replace('\'./api\'', '\'./target\'').replace('result = old', 'result = replacement'))
          }
          else {
            renameSync(join(project, 'api.ts'), join(project, 'renamed.ts'))
            write('consumer.ts', read('consumer.ts').replace('\'./api\'', '\'./renamed\''))
          }
if (operation === 'mixed' && !process.exitCode)
  write('policy.ts', 'export function permitted(value: number): boolean { return value > 0 }\n')
