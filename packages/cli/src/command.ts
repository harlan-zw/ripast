import type { ArgsDef, CommandDef } from 'citty'
import { defineCommand } from 'citty'

export function defineStrictCommand<const T extends ArgsDef>(definition: CommandDef<T>): CommandDef<T> {
  return defineCommand({
    ...definition,
    async setup(context) {
      if (!definition.subCommands) {
        const args: ArgsDef = (typeof definition.args === 'function' ? await definition.args() : await definition.args) ?? {}
        const allowed = new Set(['_'])
        let positionalCount = 0
        for (const [name, arg] of Object.entries(args)) {
          const alias = 'alias' in arg ? arg.alias : undefined
          const aliases = typeof alias === 'string' ? [alias] : alias ?? []
          for (const key of [name, ...aliases]) {
            allowed.add(key)
            allowed.add(key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`))
            allowed.add(key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()))
          }
          if (arg.type === 'positional')
            positionalCount++
        }
        for (const name of Object.keys(context.args)) {
          if (!allowed.has(name))
            throw new Error(`Unknown option: --${name}. Run the command with --help.`)
        }
        const extra = context.args._[positionalCount]
        if (extra !== undefined)
          throw new Error(`Unexpected positional argument: ${extra}. Run the command with --help.`)
      }
      await definition.setup?.(context)
    },
  })
}
