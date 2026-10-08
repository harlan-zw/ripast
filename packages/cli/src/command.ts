import type { ArgsDef, CommandDef } from 'citty'
import { defineCommand, parseArgs } from 'citty'

export function defineStrictCommand<const T extends ArgsDef>(definition: CommandDef<T>, optionalValues: (keyof T & string)[] = []): CommandDef<T> {
  return defineCommand({
    ...definition,
    async setup(context) {
      if (!definition.subCommands) {
        const args: ArgsDef = (typeof definition.args === 'function' ? await definition.args() : await definition.args) ?? {}
        if (optionalValues.length) {
          let positionalOnly = false
          const normalized = context.rawArgs.map((token, index, tokens) => {
            if (token === '--')
              positionalOnly = true
            const next = tokens[index + 1]
            return !positionalOnly && optionalValues.some(name => token === `--${name}`) && (!next || next.startsWith('-'))
              ? `${token}=`
              : token
          })
          context.args = parseArgs<T>(normalized, args)
        }
        const allowed = new Set(['_'])
        const options = new Set<string>()
        let positionalCount = 0
        for (const [name, arg] of Object.entries(args)) {
          const alias = 'alias' in arg ? arg.alias : undefined
          const aliases = typeof alias === 'string' ? [alias] : alias ?? []
          for (const key of [name, ...aliases]) {
            const variants = [key, key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`), key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())]
            for (const variant of variants) {
              allowed.add(variant)
              if (arg.type !== 'positional')
                options.add(variant)
              const value = context.args[variant]
              if (arg.type === 'string' && value !== undefined && (typeof value !== 'string' || (value.length === 0 && !optionalValues.includes(name))))
                throw new Error(`Option --${name} requires a non-empty string. Run the command with --help.`)
            }
          }
          if (arg.type === 'positional')
            positionalCount++
        }
        for (const name of Object.keys(context.args)) {
          if (!allowed.has(name))
            throw new Error(`Unknown option: --${name}. Run the command with --help.`)
        }
        for (const token of context.rawArgs) {
          if (token === '--')
            break
          if (!token.startsWith('--'))
            continue
          const name = token.slice(2).split('=')[0].replace(/^no-/, '')
          if (!options.has(name))
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
