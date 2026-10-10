# Commands

Mutations default to dry-run. If the target is uncertain, review the result, then apply once.

| Command | Use |
| --- | --- |
| `ripide rename <from> <to>` | Rename a symbol and its references. |
| `ripide replace <from> <to>` | Replace a local imported binding, or select its provider with `--source-scope`. |
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
| `ripide page --input <file.json>` | Inspect saved evidence without repeating its operation. |
| `ripide check [symbol]` | Run transient Vitest tests from stdin or list changed behaviour to check. |

For transient tests and execution evidence, read [transient checks](check.md).

## Scope and output

Without `--source-scope`, `replace <from> <to>` selects an imported binding by its local name, `<from>`.
Matching references use `<to>`, unless that name is already occupied.
For `import { old as current }`, use `replace current next`; matching calls become `next(...)`.
To select a provider, use `replace old next --source-scope src/old.ts --target-scope src/next.ts`.
Here, `old` names the provider's export. Imported local aliases and public barrel names stay unchanged.
Named and star barrel chains follow the selected export. Same-name exports from other providers stay unchanged.
Use `default` as the source name for a named default declaration or exported default identifier.
Provider selection supports native TypeScript and JavaScript projects.
Namespaces, cyclic barrels, ambiguous providers, and anonymous defaults cause an error before writes.
Edits inside replacement dependencies also fail. Dynamic imports and `require` calls in those dependencies fail.
Unresolved dependencies and declaration-only package entries also fail, because their runtime dependencies cannot be proved.
Framework consumers cause an error. A file glob limits changed files, without adding unsupported source shapes.
If provider selection refuses a shape, inspect the reason before choosing direct edits.
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
Use `--artifact <new-file.json>` to preserve the complete plan before apply.
Display limits never narrow writes or the complete artifact.
If more evidence is needed, use `page --input <artifact.json>` and select paths from its root menu.
Read [saved evidence](paging.md) for session requests, budgets, and continuation.
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
