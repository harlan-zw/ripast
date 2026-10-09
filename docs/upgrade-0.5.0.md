# Upgrade to Ripast 0.5.0

Use Node 22.13 or later.
Update the Ripast packages together.

```sh
npm install @ripast/core@0.5.0 @ripast/vue@0.5.0
```

## Refactor options

The SDK no longer accepts a ts-morph `Project` or a `lazy` option.
Pass the working directory and configuration path instead.

Before:

```ts
import { runRename } from '@ripast/core'
import { Project } from 'ts-morph'

const project = new Project({ tsConfigFilePath: 'tsconfig.json' })
await runRename('oldName', 'newName', { project, lazy: true })
```

After:

```ts
import { runRename } from '@ripast/core'

await runRename('oldName', 'newName', {
  cwd: process.cwd(),
  tsconfig: 'tsconfig.json',
})
```

For Nuxt, prepare its generated configuration first. Then pass `.nuxt/tsconfig.json`.

## Verification API

`snapshotDiagnostics` and `DiagnosticSnapshot` were removed.
`findRegressions` now accepts a native server, proposed changes, and file paths.
It returns a promise.

```ts
import type { FileChange } from '@ripast/core'
import { findRegressions, startTsServer } from '@ripast/core'

const changes: FileChange[] = [
  { path: '/absolute/project/source.ts', before: 'export const value = 1', after: 'export const value = "one"' },
]
const files = changes.map(change => change.path)
const server = await startTsServer('/absolute/project', { tsconfig: '/absolute/project/tsconfig.json' })
try {
  const regressions = await findRegressions(server, changes, files)
  console.log(regressions)
}
finally {
  server.dispose()
}
```

## CLI arguments

Remove unknown options and extra positional paths.
Use `scan --glob <pattern>` to select files. The scan command does not accept `--scope`.
Use `tree --glob <pattern>` instead of positional file paths.

## Agent upgrade prompt

Paste this section into your coding agent:

> Upgrade this project from Ripast 0.4.0 to 0.5.0.
> Require Node 22.13 or later and update all installed Ripast packages together.
> Find Ripast imports with `rg -n '@ripast/(core|vue|cli)'`.
> Remove `project` and `lazy` from SDK refactor options. Pass `cwd` and `tsconfig` instead.
> Replace `snapshotDiagnostics` and `DiagnosticSnapshot` with `startTsServer` and asynchronous `findRegressions(server, changes, files)`.
> Dispose each server in a `finally` block.
> Preserve verification and review each proposed refactor before applying it.
> Replace unsupported scan `--scope` flags and tree positional paths with `--glob`.
> Run the project typecheck and tests after migration.

> 🤖 Harlan Agent Kit wrote this upgrade guide.
