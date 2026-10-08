<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./branding/logo-dark.svg">
    <img src="./branding/logo-light.svg" alt="ripast" width="432" height="112">
  </picture>
</h1>

[![npm version](https://img.shields.io/npm/v/@ripast/cli?style=flat-square&labelColor=334155&color=334155)](https://npmjs.com/package/@ripast/cli)
[![npm downloads](https://img.shields.io/npm/dm/@ripast/cli?style=flat-square&labelColor=334155&color=334155)](https://npm.chart.dev/@ripast/cli)
[![license](https://img.shields.io/github/license/harlan-zw/ripast?style=flat-square&labelColor=334155&color=334155)](https://github.com/harlan-zw/ripast/blob/main/LICENSE.md)
[![Agent skill on skilld.dev](https://img.shields.io/badge/Skill_repo-skilld.dev-334155?style=flat-square&labelColor=334155)](https://skilld.dev/gh/harlan-zw/ripast)

> IDE-like refactoring for agents: rename, move, find-usages, css-class-rename, etc. Works with TS, Vue, React & more

<p><sub>Made possible by my <a href="https://github.com/sponsors/harlan-zw">Sponsor Program 💖</a><br>
Follow me <a href="https://twitter.com/harlan_zw">@harlan_zw</a> 🐦 • Join <a href="https://discord.gg/275MBUBvgP">Discord</a> for help</sub></p>

</div>

## Features

- 🤖 **Agent output:** JSON results and compact summaries let agents inspect changes without reading full diffs.
- 🧠 **Symbol renames:** TypeScript resolves references, including shadowed names, type-only imports, and aliases.
- 🎯 **Vue and Nuxt support:** Update script references, template expressions, component tags, and Nuxt auto-imports.
- 🛡️ **Dry runs:** Preview changes before writing them with `--apply`.
- ✅ **Type checking:** Refuse supported refactors when verification finds new type errors. See [Verify](#verify) for scope.

## Why ripast?

Renaming a symbol can affect imports, type references, JSX components, and Vue templates across a project.
Text search finds the spelling, but a rename needs to distinguish references from unrelated names.

Ripast gives coding agents CLI commands for these refactors, with a preview before writing changes.
Use a plain edit for a small, local change, or `rg` for text inside strings and comments.

### Supported targets

| Stack | Status | Notes |
| --- | --- | --- |
| TypeScript / JavaScript | ✅ Full | Native TypeScript 7 language server for semantics, oxc for edits. Type-only imports, namespace imports, re-exports, decorators. |
| React (JSX / TSX) | ✅ Full | JSX component refs, hooks, type props all rename together. |
| Solid (JSX / TSX) | ✅ Full | Same JSX engine path as React. |
| Vue 3 SFC | ✅ Full | `<script setup>` + `<template>` (interpolations, `v-if`, `v-for`, `:prop`) + component tag PascalCase ↔ kebab-case. |
| Nuxt | ✅ Full | Vue SFCs plus auto-imported `composables/`, `utils/`, and `components/`. Moving a symbol out of Nuxt auto-import scope inserts explicit imports in consumers, or refuses when a Vue file has no script block to receive one. |
| Svelte | Planned | Svelte markup refactoring is not supported. |

## Installation

Requires Node 22.13+. These examples use [pnpm](https://pnpm.io/installation).

From your project root, run a scan without installing globally:

```bash
pnpm dlx @ripast/cli scan useStore
```

This lists matching occurrences and their syntax, such as an identifier, string, or property.
To use the `ripast` command in the examples below, install the CLI globally:

```bash
pnpm add -g @ripast/cli
```

The CLI installs `@ripast/vue` automatically when it detects Vue or Nuxt in your project.
To provide the adapter yourself:

```bash
pnpm --package @ripast/cli --package @ripast/vue dlx ripast rename useStore useAppStore
```

Programmatic users install `@ripast/core` (and any adapters they need) directly:

```bash
pnpm add @ripast/core @ripast/vue
```

> [!TIP]
> The CLI includes an [Agent Skill](./packages/cli/skills/ripast/SKILL.md). Install it with [skilld](https://github.com/harlan-zw/skilld):
> ```bash
> pnpm dlx skilld add @ripast/cli
> ```

Ripast uses `rg` ([ripgrep](https://github.com/BurntSushi/ripgrep)) when it is available on `PATH`.
If it is missing, Ripast searches files in Node instead. This can be slower.
Both paths support fixed-string searches, file listing, globs, and standard ignore files.
Programmatic regex searches still require `rg`.

If `rg` is missing, install ripgrep for your system:

| System | Command |
| --- | --- |
| macOS with Homebrew | `brew install ripgrep` |
| Ubuntu or Debian | `sudo apt-get install ripgrep` |
| Windows with Winget | `winget install BurntSushi.ripgrep.MSVC` |

Then run `rg --version` and retry. See the [ripgrep installation guide](https://github.com/BurntSushi/ripgrep#installation) for other systems.

Automatic adapter installation prefers `pnpm` and falls back to `npm` if `pnpm` is missing.
The npm fallback uses a separate temporary prefix and preserves your project directory.
The launcher needs a package manager only when a detected framework lacks an adapter.
If both are missing, follow the [pnpm installation guide](https://pnpm.io/installation), then retry.
You can install the CLI and adapters together to avoid this step:

```bash
pnpm add -g @ripast/cli @ripast/vue
```

For script-only `rename`, `move`, or `rename-file` commands, pass `--no-vue` to skip the adapter.

## Usage

Run commands from your project root. Commands preview changes by default; pass `--apply` to write.
Use `--profile full` to see the full diff in an agent environment.

### What can ripast do?

<details>
<summary><b>🔍 Find every usage of a symbol</b></summary>

Find matching identifiers, strings, properties, and JSX references.
The scan includes Vue template interpolations and directive expressions.

```bash
ripast scan useStore
ripast scan useStore --kind identifier-reference,import-specifier
ripast scan useStore --graph mermaid
```

`--graph mermaid|dot` draws relative import/export edges between hit files for quick triage.

</details>

<details>
<summary><b>✏️ Rename a symbol across the repo</b></summary>

Rename references using the native TypeScript 7 language server, including imports, JSX, types, and aliases.
Property keys change only when they refer to the same symbol.

```bash
# Preview the changes
ripast rename useStore useAppStore

# Write changes after type checking
ripast rename useStore useAppStore --apply

# Ambiguous declarations? Pick one or rename all
ripast rename useStore useAppStore --scope src/store.ts --apply
ripast rename useStore useAppStore --all --apply
```

</details>

<details>
<summary><b>🔁 Replace an imported symbol with another export</b></summary>

Replace an imported binding with a project export, such as replacing `eventHandler(...)` with `defineAdminApiHandler(...)`.
Ripast updates references and imports, then removes the old import.
It preserves the call arguments and function body.

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

# Route an existing binding through a named barrel and a framework alias
ripast replace getSiteConfig getSiteConfig --target-scope ../nuxt-site-config/src/runtime/server/index.ts --target-import '#site-config/server' --apply
```

`--target-scope` can select a named re-export barrel outside the consumer project.
`--target-import` sets its import path explicitly, including Nuxt aliases.
Value and type exports retain their import kind. Existing imports from that path merge safely.
Default discovery still selects direct declarations and keeps the relative import policy.

</details>

<details>
<summary><b>🏔️ Refactor Nuxt auto-imports</b></summary>

Run `nuxi prepare` first to generate Nuxt's type declarations.
Ripast uses these files to resolve auto-imported composables, utilities, and components used in pages and other consumers.
If a move requires an explicit import in a Vue file without a script block, Ripast refuses it.

```bash
# A composable used in pages with no explicit import
ripast rename useCounter useTally --tsconfig .nuxt/tsconfig.json --apply

# Moving out of utils/composables/components adds explicit imports to consumers
ripast move format --from utils/format.ts --to lib/format.ts --apply
```

</details>

<details>
<summary><b>📦 Move an exported declaration</b></summary>

Move a top-level export and update its imports.
Ripast splits declarations such as `export const a = 1, b = 2` and preserves aliases.
It copies required imports and removes unused ones. If the symbol depends on a local, unexported helper, it refuses the move.

```bash
ripast move helper --from src/utils/a.ts --to src/utils/helpers.ts --apply
```

</details>

<details>
<summary><b>📁 Rename a file and update every import</b></summary>

Update import paths when moving or renaming a file.
The Vue adapter also updates component tags in PascalCase and kebab-case.

```bash
ripast rename-file src/utils.ts src/lib/helpers.ts --apply
```

</details>

<details>
<summary><b>🧹 Delete an unused declaration</b></summary>

Delete a top-level declaration after checking for references, then remove imports used only by that declaration.
If references remain, Ripast prints their locations and refuses the deletion.
Omit `--apply` to preview the changes.

```bash
ripast delete helper --from src/utils.ts
ripast delete helper --from src/utils.ts --apply
```

</details>

<details>
<summary><b>🎨 Migrate Tailwind / CSS class tokens</b></summary>

Rename class tokens in string literals, Vue `class` and `:class` attributes, and CSS `@apply` directives.
Ripast preserves variant prefixes (`hover:`, `dark:md:`), `!` important markers, and arbitrary values.

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

List declarations by file. Use `--exports exported` for exports or `--exports local` for declarations without exports.

```bash
ripast tree --exports exported
ripast tree --exports local --glob '*.ts'
```

In agent environments (`std-env`'s `isAgent`), defaults to a compact architecture summary.

</details>

<details>
<summary><b>🔎 Find unreferenced top-level declarations</b></summary>

Report top-level declarations with no semantic project references.
Review each result before deleting it. External callers, frameworks, dynamic registries, and entrypoints may still use these declarations.

```bash
ripast unused
ripast unused --exports local
ripast unused --exports all --json
```

</details>

<details>
<summary><b>🤖 Drive from an AI agent</b></summary>

`--json` emits machine-readable output. `--profile agent` returns compact summaries and is selected automatically in detected agent environments.
If verification finds new type errors, the command refuses `--apply` and exits with a non-zero status.

```bash
ripast rename useStore useAppStore --apply --json
# {
#   "applied": true, "dryRun": false, "blockedByRegression": false,
#   "scanned": 47, "summary": "12 files, +23 -23 lines",
#   "changes": [...], "regressions": []
# }
```

</details>

### Verify

`rename`, `replace`, `move`, `delete`, and `rename-file` enable verification by default.
They compare type errors before and after the change, then refuse `--apply` if new errors appear.
The default checks touched files. Use `--verify-mode project` to check the full project.
Use `--no-verify` or `--verify-mode none` to skip verification. CSS class renames do not run a typecheck.

### Profiles

`--profile auto|agent|full` controls output verbosity.
The default, `auto`, uses `std-env`'s `isAgent` detection.
Agents get compact summaries; terminals get full diffs and trees.

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

Run `ripast --help` for all commands, or `ripast <command> --help` for its options.

## Programmatic API

```ts
import { runRename, runReplace, scan } from '@ripast/core'

const hits = scan('useStore', { cwd: process.cwd() })

const result = await runRename('useStore', 'useAppStore', { cwd: process.cwd() })
// result.changes, result.regressions, result.scanned

const migration = await runReplace('eventHandler', 'defineAdminApiHandler', { cwd: process.cwd() })
```

The [core exports](./packages/core/src/index.ts) include refactors, scans, declaration trees, formatters, and the `writeChanges` helper.

## Recipes & limitations

**Scoping with `--glob`.** Pass comma-separated patterns. Prefix a pattern with `!` to exclude matching files:

```bash
ripast tree --exports exported --glob '*.ts,*.vue,!.nuxt/**,!**/*.d.ts,!**/dist/**'
```

**Nuxt projects.** Point `--tsconfig` at the generated config so path aliases and layer references resolve correctly:

```bash
# After `nuxi prepare`
ripast rename useFoo useBar --tsconfig .nuxt/tsconfig.json --apply
ripast tree --exports exported --glob '*.ts,*.vue,!.nuxt/**'
```

`ripast components` reads `.nuxt/components.d.ts` when available. Without it, the command discovers components from file paths.

**Encoding.** ripast assumes UTF-8 + LF. CRLF and BOM files are untested; convert with `dos2unix` / strip BOM before running mutating commands.

## Credits

- [TypeScript 7](https://github.com/microsoft/TypeScript): native language server behind rename, references, file renames, and `--verify`.
- [Volar](https://github.com/volarjs/volar.js) + [@vue/language-tools](https://github.com/vuejs/language-tools): cross-`.vue` rename and diagnostics.
- [oxc](https://github.com/oxc-project/oxc): fast parser for template-expression classification.
- [ripgrep](https://github.com/BurntSushi/ripgrep): finds candidate files before parsing.

## License

Licensed under the [MIT license](https://github.com/harlan-zw/ripast/blob/main/LICENSE.md).
