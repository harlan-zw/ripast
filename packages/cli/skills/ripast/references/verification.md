# Verification and scope

Rename, replace, move, delete, and rename-file compare type diagnostics by default.
New diagnostics block `--apply`. Agent output reports whether verification ran.
`no new type diagnostics` means no increase within the selected verification scope.
It does not prove a clean project build or passing tests.
Use `--verify-mode touched|project|none` to select scope. Keep verification enabled.
CSS and Vue template transforms have no type verification. Run their relevant project checks.

After applying, review the changed-file diff and run relevant checks.
Batch known commands. Inspect more files only when results expose uncertainty.
Repeat a successful check only after another edit or new failure.

## Nuxt and adapters

For Nuxt auto-imports, use the prepared generated configuration.
If it is missing or stale, run the project's installed `nuxi prepare` command once.
Use the same package manager for Nuxt preparation and project checks.
Pass `--tsconfig .nuxt/tsconfig.json` to rename, move, or rename-file.

Missing `rg` uses Git discovery, then Node file search if Git is missing or has no working tree.
Programmatic regex searches require `rg`, or Git and a Git working tree.

CLI flags and output contracts: [CLI source](https://github.com/harlan-zw/ripast/blob/c6ad115e765aea02f6a774e6939bee24a4e65405/packages/cli/src/cli.ts).
Adapter selection: [launcher](https://github.com/harlan-zw/ripast/blob/c6ad115e765aea02f6a774e6939bee24a4e65405/packages/cli/bin/ripast.mjs).
