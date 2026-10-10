# Verification and scope

Rename, replace, move, delete, and rename-file compare type diagnostics by default.
New diagnostics block `--apply`. Results report checks that ran against proposed content.
JSON defaults to compact output in every environment. Agent detection only changes default text output.
Every JSON response contains `_tag`, `command`, `base`, and `data`.
Compact stdout defaults to 32 KiB. Use `--max-bytes` to change the byte limit; the minimum is 1024.
Full output has no default byte limit. Byte limits do not change discovery, verification, or applied changes.
If `data.output._tag` is `Omitted`, the command outcome still appears in `_tag`.
Narrow output with supported filters or increase `--max-bytes` to retrieve the missing detail.
Use `--json --artifact <new-file.json>` for complete evidence outside model context.
Artifacts remain complete. Stdout limits do not bound stderr logs.
Mutation tags are `Preview`, `Applied`, `Refused`, or `Empty`. Discovery uses `Result`; failures use `Error`.
Compact JSON uses `data.verification: [[checker, scope, files, newErrors, ignoredErrors?]]`.
`typescript` pulls error diagnostics from the native TypeScript language server.
`vue` collects error diagnostics through the Vue adapter.
Both compare before and proposed content. Existing errors match their mapped source locations.
The optional final count reports excluded errors, such as unresolved imports to a planned destination.
Skipped checks return `disabled`, `no-changes`, or `not-applicable`.
Full JSON uses tagged `Checked` or `Skipped` receipts with named fields.
Zero new errors applies only to the reported scope. It does not prove a clean build or passing tests.
Use `--verify-mode touched|project|none` to select scope. Keep verification enabled.
Replacement defaults to project checks. Other refactors default to touched files in both the CLI and SDK.
The SDK accepts `verifyMode: 'none' | 'touched' | 'project'`. Boolean `verify` options and legacy CLI verification flags fail.
Create an SDK engine with `createEngine`, then call its refactor methods.
Commit the returned plan with `engine.commit(plan)`. Changed plans and new diagnostics refuse commit.
Vue SDK callers inject `createVueExtension()` through the engine's `extensions` option.
Project verification includes unchanged Vue consumers. It requires the Vue adapter when Vue files exist.
Refactor globs limit edits without narrowing project verification. File discovery ignores still apply.
CSS and Vue template transforms have no type verification. Run their relevant project checks.

If the receipt covers your required scope, do not repeat that diagnostic check without another edit.
Run builds or tests when the task requires checks outside that receipt.
Batch known commands. Inspect more files only when results expose uncertainty.
Repeat a successful check only after another edit or new failure.
If a check fails, repair its cause and run the focused proving check before broad verification.
Keep meaningful failing-first tests. Run required final checks against the submitted source tree.
If source and inputs are unchanged, do not repeat a failing lint command.

## Package moves and incomplete output

Before moving across packages, inspect the destination manifest, imports, and exported entry points.
Add required dependencies and update the workspace lockfile when the graph changes.
If public types or exports change, rebuild affected declarations before downstream typechecks.
Do not reinstall dependencies when their graph is unchanged.

If output is incomplete or malformed, preserve stdout, stderr, and the actual process exit separately.
Recover complete diagnostics through a preview or focused inspection before deciding what failed.
Never infer a false positive from missing diagnostics. Never disable verification to bypass a refusal.
Preserve all diagnostics in an artifact. Give the model the cause, relevant locations, and artifact path.

## Nuxt and adapters

For Nuxt auto-imports, use the prepared generated configuration.
If it is missing or stale, run the project's installed `nuxi prepare` command once.
Use the same package manager for Nuxt preparation and project checks.
Pass `--tsconfig .nuxt/tsconfig.json` to rename, move, or rename-file.

Missing `rg` uses Git discovery, then Node file search if Git is missing or has no working tree.
Programmatic regex searches require `rg`, or Git and a Git working tree.

CLI flags and output contracts: [CLI source](https://github.com/harlan-zw/ripide/blob/9bc8d6abb60d8968fb4cffd458c87003fc634989/packages/cli/src/cli.ts).
Adapter selection: [launcher](https://github.com/harlan-zw/ripide/blob/9bc8d6abb60d8968fb4cffd458c87003fc634989/packages/cli/bin/ripide.mjs).
SDK plans and commits: [engine guide](https://github.com/harlan-zw/ripide/blob/9bc8d6abb60d8968fb4cffd458c87003fc634989/docs/engine.md).
