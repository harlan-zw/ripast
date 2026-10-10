---
name: ripast
description: "AST refactors: renames, moves, imports, and CSS classes in TS/JS/Vue."
---

Use RipIDE for mechanical refactors across TS, JS, JSX, and Vue files.
Run from the project root with Node 22.13+. Follow repository worktree and approval rules; keep unrelated work separate.
Use direct edits for small local changes, prose, strings, and comments.
During architecture work, design contracts with direct edits. Use RipIDE for the supported mechanical steps.
Svelte markup and arbitrary custom codemods are unsupported.

## Launcher

Use a supplied executable first, then an existing project CLI, then a global `ripide`.
For repeated use, prefer installing `ripide` and `ripide-vue` globally once with the project manager.
Do not reinstall or silently upgrade before commands. Skip installation and version probes when a CLI is supplied.
If setup is needed, read [installation and launchers](references/setup.md), including one-off and restricted environments.

## Workflow

1. If a move crosses packages, first check destination dependencies and exports. Otherwise, run a known mutation without redundant discovery.
2. If uncertain, resolve the target and review a dry run first. Read [command syntax and examples](references/commands.md) when needed.
3. Use `--apply --profile agent`; keep type verification enabled. Use `--scope` for a known declaration file.
4. If a check is supplied, append it with `&&` in the mutation's shell call. Do not run it separately or invent checks.
5. Read the result. Inspect changed ranges only when the result or task leaves uncertainty. Stop after required checks pass.

Before manual edits, read the current source required by the editing tool.

Common commands, run only the requested operation and append its supplied check:

```bash
ripide rename useStore useAppStore --scope src/store.ts --apply --profile agent
ripide rename-file src/store.ts src/app-store.ts --apply --profile agent
ripide css-class-rename font-semibold font-medium --apply --profile agent
```

`--artifact`, `--fields`, and `--minify` require `--json`. `--fields` is for discovery commands only.
For a complete plan, add `--json --artifact <new-file.json>`.
For JSON, read `_tag` for the outcome and `data` for command fields.
Keep complete artifacts outside model context. Read selected fields only when the compact result leaves uncertainty.

Batch known commands. An exact CSS mapping needs no `css-class-scan`.
CSS and template transforms have no type verification; run their project checks.
If no files changed, resolve the target, root, or configuration before retrying.
If diagnostics increased, inspect the cause. Never disable verification to force success.
Inspect more files only when results expose uncertainty. Repeat a successful check only after another edit or new failure.
Search for one uncertainty that can change the next step. Keep full output in artifacts; read relevant evidence only.
Read `<launcher> <command> --help` only when a needed flag is unclear.

For Nuxt auto-imports or verification scope and output limits, read [verification and Nuxt](references/verification.md).

For transient behaviour checks, use `ripide check <export> --base <ref>` with Vitest code on stdin.
The CLI imports the function, `test`, `expect`, and `vi`. Add `--from` only for an ambiguous export.
Read [transient checks](references/commands.md#transient-checks) for mocks, integration obligations, and stale execution evidence.
