<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./branding/logo-dark.svg?v=ripide">
    <img src="./branding/logo-light.svg?v=ripide" alt="RipIDE" width="432" height="112">
  </picture>
</h1>

[![npm version](https://img.shields.io/npm/v/ripide?style=flat-square&labelColor=334155&color=334155)](https://npmjs.com/package/ripide)
[![npm downloads](https://img.shields.io/npm/dm/ripide?style=flat-square&labelColor=334155&color=334155)](https://npm.chart.dev/ripide)
[![license](https://img.shields.io/github/license/harlan-zw/ripide?style=flat-square&labelColor=334155&color=334155)](https://github.com/harlan-zw/ripide/blob/main/LICENSE.md)
[![Agent skill on skilld.dev](https://img.shields.io/badge/Skill_repo-skilld.dev-334155?style=flat-square&labelColor=334155)](https://skilld.dev/gh/harlan-zw/ripide)

> Typesafe IDE-like refactoring for agents.

<p><sub>Made possible by my <a href="https://github.com/sponsors/harlan-zw">Sponsor Program 💖</a><br>
Follow me <a href="https://twitter.com/harlan_zw">@harlan_zw</a> 🐦 • Join <a href="https://discord.gg/275MBUBvgP">Discord</a> for help</sub></p>

</div>

## Features

- ✂️ **IDE refactoring for your coding agent.** Rename functions, move files, and automatically update references across your project.
- 📉 **Less time, fewer tokens.** In [local tests](./bench/README.md), typical refactors took about half the time and used less than half the tokens.
- 🪨 Built on [TypeScript 7.1 (dev)](https://github.com/microsoft/TypeScript), [Oxc](https://oxc.rs), [ripgrep](https://github.com/BurntSushi/ripgrep), and [Volar](https://volarjs.dev).
- 🦎 Works with **Vue, Nuxt, React, and Solid**, plus plain TypeScript and JavaScript.
- 🏎️ Rename in **209 ms**, move in **169 ms**, including type checking ([500-file benchmark](./bench/bench.ts)).[^benchmark]
- 🪂 **Preview first.** Dry runs show the diff; [type checking](#verify) blocks supported refactors that introduce errors.

[^benchmark]: Local medians across five runs, with 160 importers per symbol.

## Why RipIDE?

Agents can refactor code well, but finding references and editing files takes time and tokens.
RipIDE handles that work in one command, so your agent spends less time reading and editing files.

In local benchmarks, median reductions by model were **59% to 71% fewer tokens** and **48% to 56% less time**.
See the [benchmark setup and results](#agent-benchmarks).

Rename functions, move files, and update imports and references together. Preview the diff before writing changes.
Use a plain edit for a small, local change, or `rg` for text inside strings and comments.

## Installation

Requires Node 22.13+.

1. Install RipIDE:

   ```bash
   npm install -g ripide
   ```

2. Install the [RipIDE Agent Skill](./packages/cli/skills/ripast/SKILL.md) in your project with your preferred installer:

   With [skilld](https://skilld.dev/gh/harlan-zw/ripide):

   ```bash
   npx skilld add ripide
   ```

   Or with [skills.sh](https://skills.sh):

   ```bash
   npx skills add harlan-zw/ripide --skill ripast
   ```

3. Optionally install [ripgrep](https://github.com/BurntSushi/ripgrep#installation) for faster searches.

4. Ask your coding agent:

   ```text
   Find better names for functions.
   ```

## Usage

Run commands from your project root. Commands preview changes by default; pass `--apply` to write.
Use `--profile full` to see the full diff in an agent environment.

### What can RipIDE do?

<details>
<summary><b>🔍 Find every usage of a symbol</b></summary>

Find matching identifiers, strings, properties, and JSX references.
The scan includes Vue template interpolations and directive expressions.

```bash
ripide scan useStore
ripide scan useStore --kind identifier-reference,import-specifier
ripide scan useStore --graph mermaid
```

`--graph mermaid|dot` draws relative import/export edges between hit files for quick triage.

</details>

<details>
<summary><b>✏️ Rename a symbol across the repo</b></summary>

Rename references using the native TypeScript 7 language server, including imports, JSX, types, and aliases.
Property keys change only when they refer to the same symbol.

```bash
# Preview the changes
ripide rename useStore useAppStore

# Write changes after type checking
ripide rename useStore useAppStore --apply

# Ambiguous declarations? Pick one or rename all
ripide rename useStore useAppStore --scope src/store.ts --apply
ripide rename useStore useAppStore --all --apply
```

Imports and references change together. The unrelated string keeps its spelling:

```diff
# src/store.ts
-export function useStore() { return 1 }
+export function useAppStore() { return 1 }
# src/consumer.ts
-import { useStore } from './store.js'
-export const value = useStore()
+import { useAppStore } from './store.js'
+export const value = useAppStore()
 export const label = 'useStore'
```

</details>

<details>
<summary><b>🔁 Replace an imported symbol with another export</b></summary>

Replace an imported binding with a project export, such as replacing `eventHandler(...)` with `defineAdminApiHandler(...)`.
RipIDE updates references and imports, then removes the old import.
It preserves the call arguments and function body.

New imports preserve the replaced relative import's extension policy.
For package imports, they follow relative imports in the consumer, then nearby project files.
Without a local policy, they use extensionless paths.
JavaScript paths keep emitted `.js`, `.mjs`, or `.cjs` endings for TypeScript targets.
Review mixed import policies in the dry run before applying.

```bash
ripide replace eventHandler defineAdminApiHandler
ripide replace eventHandler defineAdminApiHandler --apply

# Ambiguous target exports? Pick the declaring file
ripide replace eventHandler defineAdminApiHandler --target-scope layers/admin/server/utils/admin-api.ts --apply

# Route an existing binding through a named barrel and a framework alias
ripide replace getSiteConfig getSiteConfig --target-scope ../nuxt-site-config/src/runtime/server/index.ts --target-import '#site-config/server' --apply
```

`--target-scope` can select a named re-export barrel outside the consumer project.
`--target-import` sets its import path explicitly, including Nuxt aliases.
Value and type exports retain their import kind. Existing imports from that path merge safely.
Default discovery still selects direct declarations and keeps the relative import policy.

</details>

<details>
<summary><b>🏔️ Refactor Nuxt auto-imports</b></summary>

Run `nuxi prepare` first to generate Nuxt's type declarations.
RipIDE uses these files to resolve auto-imported composables, utilities, and components used in pages and other consumers.
If a move requires an explicit import in a Vue file without a script block, RipIDE refuses it.

```bash
# A composable used in pages with no explicit import
ripide rename useCounter useTally --tsconfig .nuxt/tsconfig.json --apply

# Moving out of utils/composables/components adds explicit imports to consumers
ripide move format --from utils/format.ts --to lib/format.ts --apply
```

</details>

<details>
<summary><b>📦 Move an exported declaration</b></summary>

Move a top-level export and update its imports.
RipIDE splits declarations such as `export const a = 1, b = 2` and preserves aliases.
It copies required imports and removes unused ones. If the symbol depends on a local, unexported helper, it refuses the move.

```bash
ripide move helper --from src/utils/a.ts --to src/utils/helpers.ts --apply
```

</details>

<details>
<summary><b>📁 Rename a file and update every import</b></summary>

Update import paths when moving or renaming a file.
The Vue adapter also updates component tags in PascalCase and kebab-case.

```bash
ripide rename-file src/utils.ts src/lib/helpers.ts --apply
```

</details>

<details>
<summary><b>🧹 Delete an unused declaration</b></summary>

Delete a top-level declaration after checking for references, then remove imports used only by that declaration.
If references remain, RipIDE prints their locations and refuses the deletion.
Omit `--apply` to preview the changes.

```bash
ripide delete helper --from src/utils.ts
ripide delete helper --from src/utils.ts --apply
```

</details>

<details>
<summary><b>🎨 Migrate Tailwind / CSS class tokens</b></summary>

Rename class tokens in string literals, Vue `class` and `:class` attributes, and CSS `@apply` directives.
RipIDE preserves variant prefixes (`hover:`, `dark:md:`), `!` important markers, and arbitrary values.

```bash
# Single pair
ripide css-class-rename bg-gray-500 bg-neutral-500 --apply

# Bulk design-token migration
ripide css-class-rename --map tokens.json --apply

# Seed the map by listing every class in the repo
ripide css-class-scan --json > tokens.raw.json

# Find barely used classes to clean up
ripide css-class-scan --sort count-asc

# Find files introducing the most unique class tokens
ripide css-class-scan --by file
```

</details>

<details>
<summary><b>🌳 Print a project declaration tree</b></summary>

List declarations by file. Use `--exports exported` for exports or `--exports local` for declarations without exports.

```bash
ripide tree --exports exported
ripide tree --exports local --glob '*.ts'
```

In agent environments (`std-env`'s `isAgent`), defaults to a compact architecture summary.

</details>

<details>
<summary><b>🔎 Find unreferenced top-level declarations</b></summary>

Report top-level declarations with no semantic project references.
Review each result before deleting it. External callers, frameworks, dynamic registries, and entrypoints may still use these declarations.

```bash
ripide unused
ripide unused --exports local
ripide unused --exports all --json
```

</details>

<details>
<summary><b>🤖 Drive from an AI agent</b></summary>

`--json` emits machine-readable output. `--profile agent` returns compact summaries and is selected automatically in detected agent environments.
If verification finds new type errors, the command refuses `--apply` and exits with a non-zero status.

```bash
ripide rename useStore useAppStore --apply --json
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
`replace` checks the project by default, including unchanged consumers of modified exports.
Other refactors check touched files by default. Use `--verify-mode project` for broader checks, including unchanged Vue consumers.
Project verification respects file discovery ignores. Refactor globs limit edits without narrowing project verification.
Use `--no-verify` or `--verify-mode none` to skip verification. CSS class renames do not run a typecheck.

### Profiles

`--profile auto|agent|full` controls output verbosity.
The default, `auto`, uses `std-env`'s `isAgent` detection.
Agents get compact summaries; terminals get full diffs and trees.

## Commands

| Command | Purpose |
| --- | --- |
| `ripide scan <pattern>` | Classify every occurrence (identifier vs string vs property vs JSX). Optional `--graph mermaid\|dot`. |
| `ripide tree` | Print a project declaration tree, grouped by file. |
| `ripide unused` | Find unreferenced top-level declarations. |
| `ripide rename <from> <to>` | Scope-aware symbol rename via the native TypeScript server. |
| `ripide replace <from> <to>` | Replace an imported symbol with another project export; rewrites imports and references. |
| `ripide move <symbol> --from <a> --to <b>` | Move a top-level export and rewrite every import site. |
| `ripide delete <symbol> --from <file>` | Delete an unused top-level declaration; refuses if references remain. |
| `ripide rename-file <old> <new>` | Rename a file and rewrite every import site (including `.vue` consumers). |
| `ripide css-class-rename <from> <to> \| --map <file.json>` | Rename tailwind/CSS utility class tokens repo-wide. |
| `ripide css-class-scan` | List class tokens; use `--sort count-asc` for rare tokens or `--by file` for files with the most unique classes. |

Run `ripide --help` for all commands, or `ripide <command> --help` for its options.

## Programmatic API

```ts
import { runRename, runReplace, scan } from 'ripide-api'

const hits = scan('useStore', { cwd: process.cwd() })

const result = await runRename('useStore', 'useAppStore', { cwd: process.cwd() })
// result.changes, result.regressions, result.scanned

const migration = await runReplace('eventHandler', 'defineAdminApiHandler', { cwd: process.cwd() })
```

The [core exports](./packages/core/src/index.ts) include refactors, scans, declaration trees, formatters, and the `writeChanges` helper.

## Limitations

**Scoping with `--glob`.** Pass comma-separated patterns. Prefix a pattern with `!` to exclude matching files:

```bash
ripide tree --exports exported --glob '*.ts,*.vue,!.nuxt/**,!**/*.d.ts,!**/dist/**'
```

**Nuxt projects.** Point `--tsconfig` at the generated config so path aliases and layer references resolve correctly:

```bash
# After `nuxi prepare`
ripide rename useFoo useBar --tsconfig .nuxt/tsconfig.json --apply
ripide tree --exports exported --glob '*.ts,*.vue,!.nuxt/**'
```

`ripide components` reads `.nuxt/components.d.ts` when available. Without it, the command discovers components from file paths.

**Encoding.** RipIDE assumes UTF-8 + LF. CRLF and BOM files are untested; convert with `dos2unix` / strip BOM before running mutating commands.

## Credits

- [TypeScript 7](https://github.com/microsoft/TypeScript): native language server behind rename, references, file renames, and `--verify`.
- [Volar](https://github.com/volarjs/volar.js) + [@vue/language-tools](https://github.com/vuejs/language-tools): cross-`.vue` rename and diagnostics.
- [oxc](https://github.com/oxc-project/oxc): fast parser for template-expression classification.
- [ripgrep](https://github.com/BurntSushi/ripgrep): finds candidate files before parsing.

## License

Licensed under the [MIT license](https://github.com/harlan-zw/ripide/blob/main/LICENSE.md).

## Agent benchmarks

Forty runs compared RipIDE with ordinary editing on ten matched project tasks using both models.
RipIDE passed **20/20** runs. Ordinary editing passed **19/20**.

| Model | Completed pairs | Fewer total tokens | Less total time |
| --- | --- | --- | --- |
| GPT-6 Luna, medium | 9 | 60.4% | 15.4% |
| GLM 5.3 Flash | 10 | 73.9% | 55.4% |

Percentages compare completed pairs within each model. One run per combination used source slices, with fixed method order per model.
See [full results, methods, and limits](./bench/README.md).
