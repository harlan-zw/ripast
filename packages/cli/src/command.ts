import type { ArgsDef, CommandDef } from 'citty'
import { defineCommand, parseArgs } from 'citty'

export function defineStrictCommand<const T extends ArgsDef>(definition: CommandDef<T>, optionalValues: (keyof T & string)[] = []): CommandDef<T> {
  return defineCommand({
    ...definition,
    async setup(context) {
      if (definition.subCommands) {
        await definition.setup?.(context)
        return
      }
      if (!definition.subCommands) {
        const args: ArgsDef = (typeof definition.args === 'function' ? await definition.args() : await definition.args) ?? {}
        if (optionalValues.length) {
          let positionalOnly = false
          const normalized = context.rawArgs.map((token, index, tokens) => {
            if (token === '--')
              positionalOnly = true
            const next = tokens[index + 1]
            return !positionalOnly && optionalValues.some(name => token === `--${name}`) && (next === undefined || next.startsWith('-'))
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
      const choices: Record<string, string[]> = {
        profile: ['auto', 'agent', 'full'],
        verifyMode: ['none', 'touched', 'project'],
        exports: ['all', 'exported', 'local'],
        graph: ['mermaid', 'dot'],
        source: ['auto', 'manifest', 'filesystem'],
      }
      for (const [name, values] of Object.entries(choices)) {
        const value = context.args[name]
        if (value !== undefined && !values.includes(String(value)))
          throw new Error(`Option --${name} must be one of: ${values.join(', ')}.`)
      }
      for (const name of ['limit', 'offset', 'code']) {
        const value = context.args[name]
        if (value !== undefined && (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))))
          throw new Error(`Option --${name} requires a non-negative integer.`)
      }
      const meta = typeof definition.meta === 'function' ? await definition.meta() : await definition.meta
      const json = meta?.name === 'page' || context.args.json
      if (context.args.graph && json)
        throw new Error('Options --graph and --json cannot be combined. Use scan --json for structured hits.')
      if ((context.args.fields || context.args.minify || context.args.artifact) && !json)
        throw new Error('Options --fields, --minify, and --artifact require --json.')
      if (context.args.apply && context.args.fix === false)
        throw new Error('Option --apply requires --fix for doctor.')
      if (context.args.fields && (context.args.fix || !['scan', 'tree', 'unused', 'components', 'doctor', 'css-class-scan', 'page'].includes(meta?.name ?? '')))
        throw new Error('Option --fields is available for discovery and page commands only.')
      if (context.args.code && !['rename', 'replace', 'move', 'delete', 'rename-file'].includes(meta?.name ?? ''))
        throw new Error('Option --code is available for mutation diagnostics only. Use doctor --checks to select checks.')
      if (context.args.kind) {
        const kinds = ['identifier-reference', 'identifier-binding', 'import-specifier', 'member-access', 'property', 'jsx', 'string-literal', 'label']
        for (const kind of String(context.args.kind).split(',')) {
          if (!kinds.includes(kind))
            throw new Error(`Unknown scan kind: ${kind}. Choose: ${kinds.join(', ')}.`)
        }
      }
      await definition.setup?.(context)
    },
  })
}
