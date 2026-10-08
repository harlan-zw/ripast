---
name: ripast
description: "Use Ripast for AST-aware renames, moves, usages, imports, and CSS class migrations across TS, JS, and Vue. Trigger for mechanical changes spanning files."
---

Ripast performs deterministic refactors across TS, JS, JSX, and Vue.
Run from the target project root. Requires Node 22.13+.
Missing `rg` uses slower Node file search. Programmatic regex searches still require `rg`.

## Invocation

Choose one launcher for the task:

- Project dependency: `pnpm exec ripast`.
- Explicitly provided executable on PATH: `ripast`.
- Otherwise: `pnpm dlx @ripast/cli`.

The examples use `ripast`. Substitute your launcher.
If an executable is provided, use it directly. Do not add installation or version probes before a known command.
The CLI installs missing Vue/Nuxt adapters through pnpm, then npm as fallback.
If pnpm is unavailable:

```bash
npm exec --yes --package=@ripast/cli -- ripast <command> ...
```

## Commands

| Command | Use |
| --- | --- |
| `ripast scan <pattern>` | Classify occurrences before a rename. |
| `ripast tree` | Show top-level declarations and imports. |
| `ripast unused` | Find declarations without project references. |
| `ripast rename <from> <to>` | Rename a symbol through the native TypeScript server. |
| `ripast replace <from> <to>` | Replace an imported symbol with another project export. |
| `ripast move <symbol> --from <a> --to <b>` | Move an export and update imports. |
| `ripast delete <symbol> --from <file>` | Delete a declaration if no references remain. |
| `ripast rename-file <old> <new>` | Rename a file and update importers, including Vue consumers. |
| `ripast css-class-rename <from> <to>` | Rename a CSS class token. Use `--map <file.json>` for bulk changes. |
| `ripast css-class-scan` | List class tokens before a migration. |
| `ripast vue-template-wrap <selector> <wrapper>` | Wrap matching Vue elements. |
| `ripast vue-template-unwrap <selector>` | Remove matching wrappers and keep their children. |

Run `<launcher> <command> --help` only when a needed flag is unclear.

## Apply changes

Follow the repository's worktree and approval rules. Keep unrelated work separate.

If the user supplied an exact target and mapping, apply that operation once with verification enabled.
Read the declaration only if its identity is uncertain. Do not enumerate every consumer before running Ripast.

```bash
ripast rename useStore useAppStore --scope src/store.ts --apply --profile agent
```

If the target or operation is unclear, scan first and inspect a dry run:

```bash
ripast scan useStore --profile agent
ripast rename useStore useAppStore --scope src/store.ts --profile full
ripast rename useStore useAppStore --scope src/store.ts --apply --profile agent
```

Mutating refactor commands default to dry-run. Pass `--apply` to write.
Rename, replace, move, delete, and rename-file verify types by default.
New type diagnostics block `--apply`. Read the reported errors before changing the operation.
Use `--verify-mode touched|project|none` to choose the verification scope.
Keep verification enabled. Do not disable it merely to make a command succeed.
CSS and Vue template transforms have no typecheck verification. Run their relevant checks yourself.

If the declaration file is known, use `rename --scope <file>` to disambiguate the symbol.
If several files export the replacement, use `replace --target-scope <file>`.
Use `--profile agent` for compact summaries. Use `--profile full` only when you need the diff.
Mutation `--json` includes complete before/after file contents. Parse and select fields before printing large results.
Quote `--glob` patterns. Use `--no-vue` only for a task with no Vue consumers or Nuxt auto-imports.
Template commands accept `--scope <file>` and `--root-only` to limit matches.

For Nuxt auto-imports, use the prepared generated configuration.
If it is missing or stale, prepare it once:
Pass `--tsconfig .nuxt/tsconfig.json` to rename, move, or rename-file:

```bash
pnpm exec nuxi prepare
ripast rename useCounter useTally --tsconfig .nuxt/tsconfig.json --apply --profile agent
```

After applying, review the changed-file diff and run the relevant project checks.
Batch the operation, diff review, and checks in one shell call when they form one known sequence.
Inspect additional files only if the result, diff, or checks expose uncertainty.
Do not repeat a full-project search to rediscover references Ripast already changed.
Once a check succeeds, repeat it only after another edit or a new failure.
If no files changed, resolve the declaration, project root, or configuration before retrying.

## When to use vs Edit

Use Ripast for mechanical changes across files.
Use a direct edit for one small change in a file you already understand.
Use `rg` and direct edits for prose or patterns that only occur in strings and comments.
Start with `scan` when the correct operation is unclear.

Vue supports script references and template expressions through its adapter.
Svelte markup and arbitrary custom codemods remain outside this surface.

CLI flags and output contracts: [CLI source](https://github.com/harlan-zw/ripast/blob/cd3b3d9ae75a1b5bbecd032ea5becc01d663fa29/packages/cli/src/cli.ts).
Adapter selection: [launcher](https://github.com/harlan-zw/ripast/blob/cd3b3d9ae75a1b5bbecd032ea5becc01d663fa29/packages/cli/bin/ripast.mjs).
