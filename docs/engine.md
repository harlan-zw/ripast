# Framework engine

Create one engine per extension configuration. Core supports native TypeScript and JavaScript.
Core has no framework compiler dependency. Optional package loading belongs to the CLI.

## SDK migration

Replace implicit adapter loading with explicit extension injection:

```ts
import { createEngine } from '@ripast/core'
import { createVueExtension, runVueTemplateWrap } from '@ripast/vue'

const engine = createEngine({
  extensions: [createVueExtension()],
  requiredSuffixes: ['.vue'],
})

const result = await engine.rename('useCounter', 'useTally', {
  cwd: process.cwd(),
  tsconfig: '.nuxt/tsconfig.json',
})
engine.commit(result)
```

Vue template wrap and unwrap operations now come from `@ripast/vue`.
The default Vue export is an extension factory. Prefer the named `createVueExtension` export.
The SDK `vue` option and global adapter loader were removed.
A native engine needs no extension. If authored framework source exists, supply its extension before mutation.
The CLI `--no-vue` flag refuses mutation when authored Vue consumers would be omitted.

## Parsing contract

An extension owns one or more suffixes. Names, suffixes, and semantic service names have unique owners.
Core rejects duplicate ownership during engine creation.
The `parse` callback is synchronous. Scans and declaration trees remain synchronous.

Return either:

- `{ _tag: 'Script', source, start, filename }`: a contiguous authored script region.
- `{ _tag: 'Authored', program }`: a normalized ESTree program with authored source offsets.

Script regions must match the original source at `start`. Core rejects generated or shifted source regions.
Authored AST positions must refer to the original document. Core does not remap generated AST positions.
A custom grammar can supply its own normalized AST. It does not need a TypeScript-compatible source substring.

`expressions` supplies embedded expressions with authored offsets.
`inspect` supplies offset-preserving semantic inspection text for namespace and dynamic import checks.
A parser alone does not enable mutation. Semantic services and operation capabilities are separate.

## Operation capabilities

The engine exposes `scan`, `graph`, `declarations`, `unused`, `rename`, `move`, `delete`, `renameFile`, and `replace`.
An extension declares supported mutations through `operations`.
The optional `supports` callback can refuse a specific typed operation request.
Parser-only extensions refuse mutation when their files exist.
Vue replacement refuses direct Vue consumers that the native replacement operation cannot rewrite.
It can verify unchanged Vue consumers after a native replacement changes their provider's type.

`semantic` supplies rename, import rewrite, file rename, and verification services.
It also supplies generated-source and implicit-binding policy.
An extension can instead supply `planRename` and `verify` for authored-position rename planning.
A custom planner must include all consumers of declarations it owns, including native interop consumers.
Core combines native declaration edits with relevant extension plans.
Identical changes are deduplicated. Conflicting replacements for one path refuse the operation.
Distinct conflicting plans must never silently replace each other.

## Hooks and commit order

`setup` synchronously registers typed `hookable` handlers on the engine instance.
Initialization failures propagate. Hooks run serially in extension registration order.

1. Check source requirements and operation capabilities.
2. Run `operation:before`.
3. Build native and extension plans without writing files.
4. Run `plan:ready`. Handlers can contribute authored `FileChange` plans.
5. Reject conflicting changes.
6. Run `verify:before`, then verify contributed plans and relevant semantic consumers.
7. Return the plan. Dry runs preserve source bytes.
8. If regressions exist, `commit` refuses the plan.
9. Commit the original verified result through one transaction boundary.

`commit` accepts only a result from the same engine.
Changes after verification refuse commit. File rename and consumer edits share the same boundary.
Failed writes restore committed files and the source path. Existing filesystem errors still propagate.
Standalone `writeChanges` remains available for callers who own their verification and commit policy.

## Source requirements and limits

Use `requiredSuffixes` when project configuration declares required language support.
Core also refuses unregistered source files with recognizable import, export, script, or template syntax.
This conservative check can refuse source-like text in an unknown file type.
It cannot identify every custom grammar. Explicit source requirements remain necessary for unfamiliar grammars.

Extensions must normalize their AST to the visitor contract. Arbitrary compiler ASTs need an extension-owned normalization step.
Framework declarations require a semantic planner. Parsing alone cannot resolve cross-language symbols.
There is no production mapped-language package in this change.
Multiple implicit-binding policy owners are rejected. Multiple parser and semantic owners can coexist.
One path with different complete replacement texts is a conflict, even if a human could combine them.
There is no zero-overhead promise. Engine source checks and post-hook verification add work.
