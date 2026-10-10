---
name: ripast
description: "AST refactors: renames, moves, imports, and CSS classes in TS/JS/Vue."
---

Use Ripast for mechanical refactors across TS, JS, JSX, and Vue files.
Run from the project root with Node 22.13+. Follow repository worktree and approval rules; keep unrelated work separate.
Ripgrep is optional. If it is missing, Git discovers tracked and untracked files, including local edits.
Use direct edits for small local changes, prose, strings, and comments.
Svelte markup and arbitrary custom codemods are unsupported.

## Launcher

Use a supplied executable first, then an existing project CLI, then a global `ripast`.
For repeated use, prefer installing `@ripast/cli` and `@ripast/vue` globally once with the project manager.
Do not reinstall or silently upgrade before commands. Skip installation and version probes when a CLI is supplied.
If setup is needed, read [installation and launchers](references/setup.md), including one-off and restricted environments.

## Workflow

1. If the CLI is ready and the target and command are known, run the mutation first. Skip listings, globs, scans, and declaration reads.
2. If uncertain, resolve the target and review a dry run first. Read [command syntax and examples](references/commands.md) when needed.
3. Use `--apply --profile agent`; keep type verification enabled. Use `--scope` for a known declaration file.
4. If a check is supplied, append it with `&&` in the mutation's shell call. Do not run it separately or invent checks.
5. Read the result and changed-file diff. Run relevant checks once, then stop after success.

Common commands, run only the requested operation and append its supplied check:

```bash
ripast rename useStore useAppStore --scope src/store.ts --apply --profile agent
ripast css-class-rename font-semibold font-medium --apply --profile agent
```

Batch known commands. An exact CSS mapping needs no `css-class-scan`.
CSS and template transforms have no type verification; run their project checks.
If no files changed, resolve the target, root, or configuration before retrying.
If diagnostics increased, inspect the cause. Never disable verification to force success.
Inspect more files only when results expose uncertainty. Repeat a successful check only after another edit or new failure.
Read `<launcher> <command> --help` only when a needed flag is unclear.

For Nuxt auto-imports or verification scope and output limits, read [verification and Nuxt](references/verification.md).
