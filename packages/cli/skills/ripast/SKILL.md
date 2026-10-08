---
name: ripast
description: "Use Ripast for AST-aware renames, moves, usages, imports, and CSS class migrations across TS, JS, and Vue. Trigger for mechanical changes spanning files."
---

Ripast performs deterministic refactors across TS, JS, JSX, and Vue.
Run from the target project root. Requires Node 22.13+.
Follow the repository's worktree and approval rules first. Keep unrelated work separate.

## Known target: apply and check

If the task supplies an exact target and mapping, run the refactor immediately.
Skip directory listings, file enumeration, scans, and declaration reads unless the target is uncertain.
Use `--apply --profile agent`. Keep type verification enabled.
Append the supplied check with `&&` in the same shell call. Do not invent check commands.
Read the result once. If the check passes, finish without another search or check.

Choose one launcher:

- Project dependency: `pnpm exec ripast`.
- Explicitly provided executable on PATH: `ripast`.
- Otherwise: `pnpm dlx @ripast/cli`.

Examples use `ripast`. Substitute your launcher.
If an executable is provided, skip installation and version probes.

```bash
ripast rename useStore useAppStore --scope src/store.ts --apply --profile agent
ripast css-class-rename font-semibold font-medium --apply --profile agent
```

These are separate task examples. Run only the requested operation.
Use `--scope` when the declaration file is known.
For CSS, an exact old/new token needs no `css-class-scan` first.
Use `--profile full` only when you need a diff. Applying with it prints file names, not a diff.

## Unknown target: inspect first

If the symbol or operation is uncertain, scan and inspect a dry run:

```bash
ripast scan useStore --profile agent
ripast rename useStore useAppStore --scope src/store.ts --profile full
```

Mutations default to dry-run. Review the result, then apply once.
Read `<launcher> <command> --help` only when a needed flag is unclear.
If no files changed, resolve the target, root, or configuration before retrying.
If diagnostics increased, inspect their cause. Do not disable verification to force success.

## Commands

| Command | Use |
| --- | --- |
| `ripast rename <from> <to>` | Rename a symbol and its references. |
| `ripast replace <from> <to>` | Replace an imported binding with a project export. |
| `ripast move <symbol> --from <a> --to <b>` | Move an export and update imports. |
| `ripast delete <symbol> --from <file>` | Delete a declaration without references. |
| `ripast rename-file <old> <new>` | Rename a file and update importers, including Vue consumers. |
| `ripast css-class-rename <from> <to>` | Migrate class tokens. Use `--map <file.json>` for bulk mappings. |
| `ripast vue-template-wrap <selector> <wrapper>` | Wrap matching Vue elements. |
| `ripast vue-template-unwrap <selector>` | Remove matching wrappers, preserving children. |
| `ripast scan <pattern>` | Resolve uncertain occurrences. |
| `ripast css-class-scan` | Discover class mappings when the target is unknown. |
| `ripast tree` | Show declarations and imports. |
| `ripast unused` | Find declarations without project references. |

## Verification and scope

Rename, replace, move, delete, and rename-file compare type diagnostics by default.
New diagnostics block `--apply`. Agent output reports whether verification ran.
`no new type diagnostics` means no increase within the selected verification scope.
It does not prove a clean project build or passing tests.
Use `--verify-mode touched|project|none` to select scope. Keep verification enabled.
CSS and Vue template transforms have no type verification. Run their relevant project checks.

After applying, review the changed-file diff and run relevant checks.
Batch known commands in one shell call. Inspect more files only if results expose uncertainty.
Never repeat a successful check without another edit or new failure.

Use `replace --target-scope <file>` when several files export the replacement.
Quote `--glob` patterns. CSS transforms affect strings, Vue classes, and CSS `@apply` sites.
Use a file glob when the task limits files. A Vue glob also includes script strings in Vue files.
Use `--no-vue` only when there are no Vue consumers or Nuxt auto-imports.
Template commands accept `--scope <file>` and `--root-only`.
Mutation `--json` includes complete before/after source. Select fields before printing large results.

## Nuxt and adapters

For Nuxt auto-imports, use the prepared generated configuration.
If it is missing or stale, run `pnpm exec nuxi prepare` once.
Pass `--tsconfig .nuxt/tsconfig.json` to rename, move, or rename-file.

The CLI installs missing Vue/Nuxt adapters through pnpm, then npm.
If pnpm is unavailable, use `npm exec --yes --package=@ripast/cli -- ripast <command> ...`.
Git working trees use tracked files only, including local edits. Stage new files with `git add` before scanning them.
Missing Git or a folder outside Git uses Node file search. Programmatic regex searches require a Git working tree.

Use direct edits for small local changes, prose, strings, and comments.
Svelte markup and arbitrary custom codemods remain unsupported.

CLI flags and output contracts: [CLI source](https://github.com/harlan-zw/ripast/blob/c6ad115e765aea02f6a774e6939bee24a4e65405/packages/cli/src/cli.ts).
Adapter selection: [launcher](https://github.com/harlan-zw/ripast/blob/c6ad115e765aea02f6a774e6939bee24a4e65405/packages/cli/bin/ripast.mjs).
