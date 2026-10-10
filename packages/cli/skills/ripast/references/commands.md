# Commands

Mutations default to dry-run. If the target is uncertain, review the result, then apply once.

| Command | Use |
| --- | --- |
| `ripide rename <from> <to>` | Rename a symbol and its references. |
| `ripide replace <from> <to>` | Replace a local imported binding with a project export. |
| `ripide move <symbol> --from <a> --to <b>` | Move an export and update imports. |
| `ripide delete <symbol> --from <file>` | Delete a declaration without references. |
| `ripide rename-file <old> <new>` | Rename a file and update importers, including Vue consumers. |
| `ripide css-class-rename <from> <to>` | Migrate class tokens. Use `--map <file.json>` for bulk mappings. |
| `ripide vue-template-wrap <selector> <wrapper>` | Wrap matching Vue elements. |
| `ripide vue-template-unwrap <selector>` | Remove matching wrappers, preserving children. |
| `ripide scan <pattern>` | Resolve uncertain occurrences. |
| `ripide css-class-scan` | Discover class mappings when the target is unknown. |
| `ripide tree` | Show declarations and imports. |
| `ripide unused` | Find declarations without project references. |
| `ripide check [symbol]` | Run transient Vitest tests from stdin or list changed behaviour to check. |

## Transient checks

The command is experimental. Verify its results against project checks.
Use `check --base <ref>` at the repository root to list changed functions and direct callers.
The checklist covers TS and JS functions, relative imports, named aliases, and namespace calls.
Review framework calls, dynamic imports, barrel exports, and configured import aliases separately.

```bash
ripide check --base HEAD --profile agent
ripide check parseLimit --base HEAD --json <<'TS'
test('rejects zero', () => expect(parseLimit('0')._tag).toBe('Err'))
TS
```

The CLI imports a unique exported function, `test`, `expect`, and `vi`.
Explicit imports remain valid. The CLI adds only missing module bindings.
If several exports match, pass `--from src/limit.ts`.
Without a symbol, pass `--from` and supply a complete Vitest module with imports.
Relative imports and mocks resolve beside that source file.
Place `vi.mock` at module top level. Use native `vi.hoisted` when a mock needs shared variables.
Use `--config` and `--project` to select project context.
Select a Node project. Browser projects and computed project lists require a separate project configuration.
The command loads aliases, plugins, environments, and setup files, then runs only the supplied module.

Each run uses a fresh Vitest process with a default 30-second deadline.
Use `--timeout <milliseconds>` to change that deadline.
Every running test needs an assertion. Empty and skipped-only modules fail.
Failures, collection errors, and timeouts return exit code 1.
Agent JSON omits error stacks. Use `--artifact <path>` to save full failure evidence.
Tests execute with project permissions. The worker provides process isolation.
Snapshot creation remains a project write. Use assertions when transient checks must leave source files unchanged.

With `--base`, passing checks record V8 function and branch execution outside the repository.
Repeat the same baseline when running checks and reading the checklist.
Receipts live in `~/scratch/ripide-check/`. They contain coverage and content hashes, without test source.
Source, configuration, or lockfile edits invalidate execution evidence.
`executed` means the function ran during passing assertions. Review assertion meaning separately.
Integration, API, and manual obligations remain pending for review.
For integration, call the caller and assert combined behaviour with the real callee.
A mock replacement cannot supply execution evidence for the replaced function.
Agent output hides passed test details. Use `--profile full --json --artifact <new-path>` for complete evidence.

## Scope and output

`replace <from> <to>` selects an imported binding by its local name, `<from>`.
Matching references use `<to>`, unless that name is already occupied.
For `import { old as current }`, use `replace current next`; matching calls become `next(...)`.
If local aliases must stay unchanged, edit those imports directly.
Source re-export barrels also require direct edits. Preserve their public aliases.
`--target-scope` selects the replacement export's file.
Use `replace --target-scope <file>` when several files export the replacement.
Quote `--glob` patterns. CSS transforms affect strings, Vue classes, and CSS `@apply` sites.
Use a file glob when the task limits files. A Vue glob also includes script strings in Vue files.
Use `--no-vue` only when there are no Vue consumers or Nuxt auto-imports.
Template commands accept `--scope <file>` and `--root-only`.
Every JSON response contains `_tag`, `command`, `base`, and `data`.
Mutation tags are `Preview`, `Applied`, `Refused`, or `Empty`. Failures use `Error`.
Compact mutation JSON returns `data.verification` and `data.changes: [[path, lines]]`.
Verification entries use `[checker, scope, files, newErrors, ignoredErrors?]`.
Built-in checkers are `typescript` and `vue`. SDK extensions can use other checker names.
Counts describe checks that ran against proposed content.
Skipped checks return `disabled`, `no-changes`, or `not-applicable`.
When ranges shift, entries use `[path, beforeLines, afterLines]`. Moves use `data.moves: [[from, to]]`.
Lines are one-based and inclusive. Commas separate ranges; `3+` marks a gap after line 3.
After apply, earlier file reads are outdated. Read changed ranges only when current code is needed.
Follow any editing tool requirement for a fresh read. Do not reread every changed file just to confirm success.
Use `--profile full --json` when you need complete before/after source.
Use `--artifact <new-file.json>` to preserve the complete plan before apply.
Display limits never narrow writes or the complete artifact.
Save large results outside model context. Read the required fields or changed ranges on demand.
Put actionable errors before optional previews. Preserve omitted details in a complete artifact.
Batch independent searches. Keep dependent mutations and verification sequential.


## Examples

```bash
ripide scan useStore --profile agent
ripide rename useStore useAppStore --scope src/store.ts --profile full
```

These are separate task examples. Run only the requested operation.
Use `--scope` when the declaration file is known.
Use `--profile full` only when you need a diff. Applying with it prints file names, not a diff.
