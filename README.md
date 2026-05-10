# ripast

AST-aware refactor primitives for TypeScript, JavaScript, and Vue SFCs (including `<template>`).

`ripast` parses only the files ripgrep says contain the token, then uses the AST to decide what to change. Vue SFCs are supported via a Volar bridge: `rename` and `move` propagate into `<script>` blocks; `scan` covers `<template>` interpolations and directive expressions; `--verify` catches new diagnostics in `.vue` consumers.

## Why

Surgical text edits are slow and miss things: shadowed identifiers, type-only imports, JSX refs, kebab-case component tags. `ripast` operates on the AST, so renames respect scope, moves rewrite all import sites, and verification fails closed when a transform introduces new type errors.

## Install

```bash
npm i -g ripast
# or one-shot:
npx ripast scan useStore
```

Requires `rg` (ripgrep) on `PATH` and Node 20.11+.

## Commands

| Command | Purpose |
| --- | --- |
| `ripast scan <pattern>` | Classify every occurrence (identifier vs string vs property vs JSX). Optional `--graph mermaid\|dot`. |
| `ripast tree` | Print a project declaration tree, grouped by file. |
| `ripast rename <from> <to>` | Scope-aware symbol rename via ts-morph. Object property keys are not touched unless they reference the same symbol. |
| `ripast move <symbol> --from <a> --to <b>` | Move a top-level export and rewrite every import site. |
| `ripast rename-file <old> <new>` | Rename a file and rewrite every import site (including `.vue` consumers). |
| `ripast css-class-rename <from> <to> \| --map <file.json>` | Rename tailwind/CSS utility class tokens repo-wide; preserves variant prefixes, `!` markers, and arbitrary values. |
| `ripast css-class-scan` | List every class token in the repo (seeds a rename map). |

All mutating commands default to **dry-run** and print a unified diff. Pass `--apply` to write. `--verify` (on by default for `rename` and `move`) runs a post-transform typecheck and refuses `--apply` if new diagnostics appear; pass `--no-verify` to skip. Use `--verify-mode touched|project|none` to choose scoped, full-project, or no diagnostics. Pass `--json` for machine-readable output.

## Quick examples

```bash
# Where is it used and how?
ripast scan useStore --kind identifier-reference,import-specifier

# Rename across the repo
ripast rename useStore useAppStore --apply

# Move an exported helper
ripast move helper --from src/utils/a.ts --to src/utils/helpers.ts --apply

# Rename a file and update every importer
ripast rename-file src/utils.ts src/lib/helpers.ts --apply

# Migrate a tailwind palette
ripast css-class-rename --map tokens.json --apply
```

## Programmatic API

```ts
import { runRename, scan } from 'ripast'

const hits = scan('useStore', { cwd: process.cwd() })

const result = await runRename('useStore', 'useAppStore', { cwd: process.cwd() })
// result.changes, result.regressions, result.scanned
```

Exports cover `runRename`, `runMove`, `runRenameFile`, `runCssClassRename`, `runCssClassScan`, `scan`, `buildScanGraph`, `buildDeclarationTree`, plus formatters and the `writeChanges` helper.

## When to reach for this vs Edit

| Situation | Tool |
| --- | --- |
| Single site, or <5 matches in one file | Plain edit |
| "Where is X used?" | `ripast scan` |
| Rename a symbol across the repo | `ripast rename` |
| Move a declaration to another file (update all imports) | `ripast move` |
| Rename a file and update every import site | `ripast rename-file` |
| Rename a tailwind/CSS utility class across the repo | `ripast css-class-rename` |
| Pattern is only meaningful inside strings/comments | plain `rg` + edit |

## License

MIT &copy; [Harlan Wilton](https://harlanzw.com)
