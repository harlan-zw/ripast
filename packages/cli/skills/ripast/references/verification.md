# Verification and scope

Rename, replace, move, delete, and rename-file compare type diagnostics by default.
New diagnostics block `--apply`. Results report checks that ran against proposed content.
Agent JSON uses `verification: [[checker, scope, files, newErrors, ignoredErrors?]]`.
`typescript` pulls error diagnostics from the native TypeScript language server.
`vue` collects error diagnostics through the Vue adapter.
Both compare before and proposed content. Existing errors match their mapped source locations.
The optional final count reports excluded errors, such as unresolved imports to a planned destination.
Skipped checks return `disabled`, `no-changes`, or `not-applicable`.
Full JSON uses tagged `Checked` or `Skipped` receipts with named fields.
Zero new errors applies only to the reported scope. It does not prove a clean build or passing tests.
Use `--verify-mode touched|project|none` to select scope. Keep verification enabled.
Replacement checks the project by default. Other symbol refactors default to touched files.
Project verification includes unchanged Vue consumers. It requires the Vue adapter when Vue files exist.
Refactor globs limit edits without narrowing project verification. File discovery ignores still apply.
CSS and Vue template transforms have no type verification. Run their relevant project checks.

If the receipt covers your required scope, do not repeat that diagnostic check without another edit.
Run builds or tests when the task requires checks outside that receipt.
Batch known commands. Inspect more files only when results expose uncertainty.
Repeat a successful check only after another edit or new failure.

## Nuxt and adapters

For Nuxt auto-imports, use the prepared generated configuration.
If it is missing or stale, run the project's installed `nuxi prepare` command once.
Use the same package manager for Nuxt preparation and project checks.
Pass `--tsconfig .nuxt/tsconfig.json` to rename, move, or rename-file.

Missing `rg` uses slower Node file search. Programmatic regex searches still require `rg`.

CLI flags and output contracts: [CLI source](https://github.com/harlan-zw/ripide/blob/c6ad115e765aea02f6a774e6939bee24a4e65405/packages/cli/src/cli.ts).
Adapter selection: [launcher](https://github.com/harlan-zw/ripide/blob/c6ad115e765aea02f6a774e6939bee24a4e65405/packages/cli/bin/ripast.mjs).
