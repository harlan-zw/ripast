<h1>ripast</h1>

[![npm version](https://img.shields.io/npm/v/ripast?color=yellow)](https://npmjs.com/package/ripast)
[![npm downloads](https://img.shields.io/npm/dm/ripast?color=yellow)](https://npm.chart.dev/ripast)
[![license](https://img.shields.io/github/license/harlan-zw/ripast?color=yellow)](https://github.com/harlan-zw/ripast/blob/main/LICENSE.md)

> 🤖 The AST refactor toolkit for AI coding agents. Deterministic renames for TypeScript and frontend frameworks (Vue, Nuxt, React, Solid). Type-checked, framework-aware, dry-run by default.

<p align="center">
<table>
<tbody>
<td align="center">
<sub>Made possible by my <a href="https://github.com/sponsors/harlan-zw">Sponsor Program 💖</a><br> Follow me <a href="https://twitter.com/harlan_zw">@harlan_zw</a> 🐦 • Join <a href="https://discord.gg/275MBUBvgP">Discord</a> for help</sub><br>
</td>
</tbody>
</table>
</p>

## Features

- 🤖 **Built for agents**: Compact summaries, `--json` output, `--profile agent` auto-detect via `std-env`. Stop burning tokens reading 50 files to rename one symbol.
- 🧠 **Semantic, not textual**: the native TypeScript 7 language server drives renames so shadowed identifiers, type-only imports, JSX/TSX refs, re-exports, and aliased imports all resolve correctly. No more partial renames.
- 🎯 **JS Frameworks**: First-class TypeScript / JavaScript, React + Solid (JSX/TSX), and Vue + Nuxt SFCs. Volar bridge propagates renames into `<script>` blocks; template-AST post-pass rewrites `<MyButton>` / `<my-button>` tags and `v-if` / `:prop` expressions. Svelte on the roadmap.
- 🛡️ **Dry-run by default**: Every mutating command prints a unified diff with a `N files, +A -R lines` header. Pass `--apply` to write.
- ✅ **--verify catches regressions**: Post-transform typecheck refuses `--apply` if new diagnostics appear. Scoped to touched files for speed.
- ⚡ **ripgrep-prefiltered**: Only files containing the token are parsed. On a 500-file fixture, median `rename` with verify runs in ~95ms and `move` in ~37ms.

## What is ripast?

A CLI of AST refactor primitives purpose-built for TypeScript and modern frontend frameworks: **React** and **Solid** (JSX/TSX), **Vue** and **Nuxt** (SFCs including `<template>`), plus plain TS/JS. `ripast` parses only the files ripgrep says contain the token, then uses the AST to decide what to change.

Surgical text edits are slow and miss things: shadowed identifiers, type-only imports, JSX component refs, kebab-case Vue tags, re-exported types. AI coding agents (Claude Code, Cursor, Aider) hit this constantly: a rename that should be one CLI call becomes a 50-file read + multi-edit dance, eating tokens and risking partial renames.

`ripast` operates on the AST, so renames respect scope, imported symbols can be replaced with project exports, moves rewrite all import sites, unused declarations can be deleted with reference checks, file renames update every importer (including `.vue` consumers), and verification fails closed when a transform introduces new type errors.

### Supported targets

| Stack | Status | Notes |
| --- | --- | --- |
| TypeScript / JavaScript | ✅ Full | Native TypeScript 7 language server for semantics, oxc for edits. Type-only imports, namespace imports, re-exports, decorators. |
| React (JSX / TSX) | ✅ Full | JSX component refs, hooks, type props all rename together. |
| Solid (JSX / TSX) | ✅ Full | Same JSX engine path as React. |
| Vue 3 SFC | ✅ Full | `<script setup>` + `<template>` (interpolations, `v-if`, `v-for`, `:prop`) + component tag PascalCase ↔ kebab-case. |
| Nuxt | ✅ Full | Vue SFCs plus auto-imported `composables/`, `utils/`, and `components/`. Moving a symbol out of Nuxt auto-import scope inserts explicit imports in consumers, or refuses when a Vue file has no script block to receive one. |
| Svelte | 🚧 Roadmap | Script-block rename works via the TypeScript server; markup rewrites need `svelte/compiler` integration. |

### Why not just...

| Tool | Gap `ripast` fills |
| --- | --- |
| `grep` + `sed` | No type awareness; touches strings in comments, partial matches, wrong scopes. No Vue template / kebab-case handling. |
| `ast-grep` | Syntactic, not semantic; no symbol resolution, no type-only import tracking, shallow Vue SFC support. |
| `jscodeshift` | Requires writing a transform script per task; no out-of-box "rename symbol X to Y"; no Vue parser. |
| `ts-morph` (library) | The engine, not the cockpit. You'd have to write the script, the diff, the dry-run gate, the Vue bridge, the typecheck verify. |
| LSP `rename` | Requires editor + language server protocol; no headless CLI; no JSON output mode. |

### What can ripast do?

<details>
<summary><b>🔍 Find every usage of a symbol</b></summary>

Classify every occurrence (identifier vs string vs property vs JSX) before deciding the next move. Covers Vue SFC `<template>` interpolations and directive expressions.

```bash
ripast scan useStore
ripast scan useStore --kind identifier-reference,import-specifier
ripast scan useStore --graph mermaid
```

`--graph mermaid|dot` draws relative import/export edges between hit files for quick triage.
</details>

<details>
<summary><b>✏️ Rename a symbol across the repo</b></summary>

Scope-aware rename via the native TypeScript 7 language server. TypeScript propagates to every reference (imports, JSX, type positions, aliased imports). Object property keys with the same spelling are NOT touched unless they reference the same symbol.

```bash
# Dry-run (default) — prints diff + summary
ripast rename useStore useAppStore

# Apply with typecheck verify (default)
ripast rename useStore useAppStore --apply

# Ambiguous declarations? Pick one or rename all
ripast rename useStore useAppStore --scope src/store.ts --apply
ripast rename useStore useAppStore --all --apply
```
</details>

<details>
<summary><b>🔁 Replace an imported symbol with another export</b></summary>

Replace references to an imported binding with a project export. `ripast` resolves the target export, rewrites the consumer import, prunes the old import, and preserves the call/body shape. This is for API migrations like swapping `eventHandler(...)` for `defineAdminApiHandler(...)`; it does not remove semantic body statements.

New imports preserve the replaced relative import's extension policy.
For package imports, they follow relative imports in the consumer, then nearby project files.
Without a local policy, they use extensionless paths.
JavaScript paths keep emitted `.js`, `.mjs`, or `.cjs` endings for TypeScript targets.
Review mixed import policies in the dry run before applying.

```bash
ripast replace eventHandler defineAdminApiHandler
ripast replace eventHandler defineAdminApiHandler --apply

# Ambiguous target exports? Pick the declaring file
ripast replace eventHandler defineAdminApiHandler --target-scope layers/admin/server/utils/admin-api.ts --apply
```
</details>

<details>
<summary><b>🏔️ Refactor Nuxt auto-imports</b></summary>

Nuxt-generated `.nuxt/*.d.ts` files let `ripast` treat auto-imported composables, utils, components, and pages like normal TypeScript symbols.

```bash
# A composable used in pages with no explicit import
ripast rename useCounter useTally --tsconfig .nuxt/tsconfig.json --apply

# Moving out of utils/composables/components adds explicit imports to consumers
ripast move format --from utils/format.ts --to lib/format.ts --apply
```
</details>

<details>
<summary><b>📦 Move an exported declaration</b></summary>

Move a top-level export and rewrite every import site. Splits multi-named imports, auto-splits `export const a = 1, b = 2`, copies transitive imports, prunes unused imports, preserves aliases. Refuses if the symbol depends on a local non-exported helper (would silently break).

```bash
ripast move helper --from src/utils/a.ts --to src/utils/helpers.ts --apply
```
</details>

<details>
<summary><b>📁 Rename a file and update every import</b></summary>

Volar-driven, so `.vue` consumers get correct relative paths and PascalCase ↔ kebab-case component-name mapping.

```bash
ripast rename-file src/utils.ts src/lib/helpers.ts --apply
```
</details>

<details>
<summary><b>🧹 Delete an unused declaration</b></summary>

Delete one top-level declaration from a file only when semantic reference lookup finds no remaining usages. Prunes imports that were only used by the deleted declaration, then runs verify before applying. Omit `--apply` to inspect the diff first; if references remain, ripast prints their locations and refuses the delete.

```bash
ripast delete helper --from src/utils.ts
ripast delete helper --from src/utils.ts --apply
```
</details>

<details>
<summary><b>🎨 Migrate Tailwind / CSS class tokens</b></summary>

Tokenizes every string literal, Vue template `class` / `:class` attribute, and `@apply` directive body. Preserves variant prefixes (`hover:`, `dark:md:`), `!` important markers, and arbitrary values.

```bash
# Single pair
ripast css-class-rename bg-gray-500 bg-neutral-500 --apply

# Bulk design-token migration
ripast css-class-rename --map tokens.json --apply

# Seed the map by listing every class in the repo
ripast css-class-scan --json > tokens.raw.json

# Find barely used classes to clean up
ripast css-class-scan --sort count-asc

# Find files introducing the most unique class tokens
ripast css-class-scan --by file
```
</details>

<details>
<summary><b>🌳 Print a project declaration tree</b></summary>

Skim the architecture before a refactor. `--exports exported` shows public surface, `--exports local` shows internals.

```bash
ripast tree --exports exported
ripast tree --exports local --glob '*.ts'
```

In agent environments (`std-env`'s `isAgent`), defaults to a compact architecture summary.
</details>

<details>
<summary><b>🔎 Find unreferenced top-level declarations</b></summary>

Report top-level declarations with no semantic project references. This is intentionally narrower than "all dead code"; exported APIs, framework conventions, side-effect modules, dynamic registries, and entrypoints can still be live.

```bash
ripast unused
ripast unused --exports local
ripast unused --exports all --json
```
</details>

<details>
<summary><b>🤖 Drive from an AI agent</b></summary>

`--json` emits machine-readable output. `--profile agent` (auto-detected) returns compact summaries instead of full diffs. Atomic apply: blocked-by-regression exits non-zero with diagnostics.

```bash
ripast rename useStore useAppStore --apply --json
# {
#   "applied": true, "dryRun": false, "blockedByRegression": false,
#   "scanned": 47, "summary": "12 files, +23 -23 lines",
#   "changes": [...], "regressions": []
# }
```
</details>

## Installation

```bash
npm i -g @ripast/cli
# or one-shot
npx -y @ripast/cli scan useStore
```

The CLI auto-installs framework adapters when it detects them in your project (`@ripast/vue` for Vue/Nuxt). To pre-bundle them and skip the re-exec:

```bash
npx -y -p @ripast/cli -p @ripast/vue ripast rename useStore useAppStore --apply
```

Programmatic users install `@ripast/core` (and any adapters they need) directly:

```bash
npm i @ripast/core @ripast/vue
```

> [!TIP]
> The CLI includes an [Agent Skill](./packages/cli/skills/ripast/SKILL.md). Install it with [skilld](https://github.com/harlan-zw/skilld):
> ```bash
> pnpm dlx skilld add @ripast/cli
> ```

Requires `rg` ([ripgrep](https://github.com/BurntSushi/ripgrep)) on `PATH` and Node 22.13+.

## Usage

All mutating commands default to **dry-run** and print a unified diff. Pass `--apply` to write.

```bash
# Where is it used and how?
ripast scan useStore --kind identifier-reference,import-specifier

# Rename across the repo
ripast rename useStore useAppStore --apply

# Move an exported helper
ripast move helper --from src/utils/a.ts --to src/utils/helpers.ts --apply

# Rename a file and update every importer
ripast rename-file src/utils.ts src/lib/helpers.ts --apply

# Delete an unused top-level declaration
ripast delete helper --from src/utils.ts --apply

# Migrate a tailwind palette
ripast css-class-rename --map tokens.json --apply
```

### Verify

`--verify` (on by default for `rename`, `replace`, `move`, and `delete`) runs a post-transform typecheck and refuses `--apply` if new diagnostics appear. Pass `--no-verify` to skip, or `--verify-mode touched|project|none` to choose scoped, full-project, or no diagnostics.

### Profiles

`--profile auto|agent|full` controls output verbosity. `auto` uses `std-env`'s `isAgent` detection: agents get compact summaries, terminals get full diffs and trees.

## Commands

| Command | Purpose |
| --- | --- |
| `ripast scan <pattern>` | Classify every occurrence (identifier vs string vs property vs JSX). Optional `--graph mermaid\|dot`. |
| `ripast tree` | Print a project declaration tree, grouped by file. |
| `ripast unused` | Find unreferenced top-level declarations. |
| `ripast rename <from> <to>` | Scope-aware symbol rename via the native TypeScript server. |
| `ripast replace <from> <to>` | Replace an imported symbol with another project export; rewrites imports and references. |
| `ripast move <symbol> --from <a> --to <b>` | Move a top-level export and rewrite every import site. |
| `ripast delete <symbol> --from <file>` | Delete an unused top-level declaration; refuses if references remain. |
| `ripast rename-file <old> <new>` | Rename a file and rewrite every import site (including `.vue` consumers). |
| `ripast css-class-rename <from> <to> \| --map <file.json>` | Rename tailwind/CSS utility class tokens repo-wide. |
| `ripast css-class-scan` | List class tokens; use `--sort count-asc` for rare tokens or `--by file` for files with the most unique classes. |

## Programmatic API

```ts
import { runRename, runReplace, scan } from '@ripast/core'

const hits = scan('useStore', { cwd: process.cwd() })

const result = await runRename('useStore', 'useAppStore', { cwd: process.cwd() })
// result.changes, result.regressions, result.scanned

const migration = await runReplace('eventHandler', 'defineAdminApiHandler', { cwd: process.cwd() })
```

Exports cover `runRename`, `runReplace`, `runMove`, `runDelete`, `runRenameFile`, `runCssClassRename`, `runCssClassScan`, `scan`, `buildScanGraph`, `buildDeclarationTree`, `buildUnusedDeclarations`, plus formatters and the `writeChanges` helper.

Each call starts the native TypeScript server. Startup takes a few milliseconds, so there is no batching API.

## Recipes & limitations

**Scoping with `--glob`.** Comma-separated globs are forwarded to ripgrep verbatim, including `!`-prefixed exclusions. Useful for keeping the default extension set while cutting generated noise:

```bash
ripast tree --exports exported --glob '*.ts,*.vue,!.nuxt/**,!**/*.d.ts,!**/dist/**'
```

**Nuxt projects.** Point `--tsconfig` at the generated config so path aliases and layer references resolve correctly:

```bash
# After `nuxi prepare`
ripast rename useFoo useBar --tsconfig .nuxt/tsconfig.json --apply
ripast tree --exports exported --tsconfig .nuxt/tsconfig.json --glob '*.ts,*.vue,!.nuxt/**'
```

`components` (and friends) auto-detect `.nuxt/components.d.ts` for accurate manifest-sourced resolution; fall back to filesystem glob only when no manifest is present (run `nuxi prepare` first for best results).

**Pre-commit guard.** Drop the snippet below into a `pre-commit` hook to catch incomplete manual renames before they land. It scans staged identifiers and refuses the commit if `ripast scan` reports references that look stale:

```bash
#!/usr/bin/env bash
set -e
# Tokens that look like old/new pairs in the staged diff (heuristic).
candidates=$(git diff --cached -U0 | rg -No '\b[A-Za-z_][A-Za-z0-9_]{4,}\b' | sort -u)
for name in $candidates; do
  hits=$(ripast scan "$name" --profile agent 2>/dev/null | rg -c "^  " || true)
  [ "$hits" -gt 0 ] || continue
done
```

(Project-specific; treat as a template rather than a turnkey hook.)

**Encoding.** ripast assumes UTF-8 + LF. CRLF and BOM files are untested; convert with `dos2unix` / strip BOM before running mutating commands.

## When to reach for this vs Edit

| Situation | Tool |
| --- | --- |
| Single site, or <5 matches in one file | Plain edit |
| "Where is X used?" | `ripast scan` |
| "Which top-level declarations have no project references?" | `ripast unused` |
| Rename a symbol across the repo | `ripast rename` |
| Replace one imported API with another project export | `ripast replace` |
| Move a declaration to another file (update all imports) | `ripast move` |
| Delete an unused top-level declaration | `ripast delete` |
| Rename a file and update every import site | `ripast rename-file` |
| Rename a tailwind/CSS utility class across the repo | `ripast css-class-rename` |
| Pattern is only meaningful inside strings/comments | plain `rg` + edit |

## Credits

- [TypeScript 7](https://github.com/microsoft/TypeScript): native language server behind rename, references, file renames, and `--verify`.
- [Volar](https://github.com/volarjs/volar.js) + [@vue/language-tools](https://github.com/vuejs/language-tools): cross-`.vue` rename and diagnostics.
- [oxc](https://github.com/oxc-project/oxc): fast parser for template-expression classification.
- [ripgrep](https://github.com/BurntSushi/ripgrep): the candidate-file oracle.

## License

Licensed under the [MIT license](https://github.com/harlan-zw/ripast/blob/main/LICENSE.md).
