---
name: ripast
description: "AST refactors: renames, moves, imports, and CSS classes in TS/JS/Vue."
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

Use a supplied executable or existing project CLI first. Otherwise, use an existing global `ripast`.
For repeated use, prefer a one-time global installation over temporary launchers.
Install `@ripast/cli` and `@ripast/vue` together, then run `ripast` directly.
Use the project manager. Do not reinstall, silently upgrade, or probe versions before each command.
Read [setup](references/setup.md) only when installation, PATH, or launcher syntax needs resolving.
It covers npm, pnpm, Yarn, Bun, and temporary launchers for one-off or restricted environments.
Examples use `ripast`; substitute your launcher.

```bash
ripast rename useStore useAppStore --scope src/store.ts --apply --profile agent
ripast css-class-rename font-semibold font-medium --apply --profile agent
```

Run only the requested operation. Use `--scope` for a known declaration file.
An exact CSS mapping needs no `css-class-scan`.
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

For command syntax beyond the examples, read [commands](references/commands.md).
It covers replace, move, delete, rename-file, templates, scans, declarations, and unused declarations.

## Verification and scope

Rename, replace, move, delete, and rename-file compare type diagnostics by default.
New diagnostics block `--apply`. Agent output reports whether verification ran.
`no new type diagnostics` means no increase within the selected verification scope.
It does not prove a clean project build or passing tests.
Use `--verify-mode touched|project|none` to select scope. Keep verification enabled.
CSS and Vue template transforms have no type verification. Run their relevant project checks.

After applying, review the changed-file diff and run relevant checks.
Batch known commands. Inspect more files only when results expose uncertainty.
Repeat a successful check only after another edit or new failure.

Read the command reference for target scopes, file globs, template flags, and JSON output.

## Nuxt and adapters

For Nuxt auto-imports, use the prepared generated configuration.
If it is missing or stale, run the project's installed `nuxi prepare` command once.
Use the same package manager for Nuxt preparation and project checks.
Pass `--tsconfig .nuxt/tsconfig.json` to rename, move, or rename-file.

For missing adapters or Bun runtime requirements, read the setup reference.
Missing `rg` uses slower Node file search. Programmatic regex searches still require `rg`.

Use direct edits for small local changes, prose, strings, and comments.
Svelte markup and arbitrary custom codemods remain unsupported.

CLI flags and output contracts: [CLI source](https://github.com/harlan-zw/ripast/blob/c6ad115e765aea02f6a774e6939bee24a4e65405/packages/cli/src/cli.ts).
Adapter selection: [launcher](https://github.com/harlan-zw/ripast/blob/c6ad115e765aea02f6a774e6939bee24a4e65405/packages/cli/bin/ripast.mjs).
