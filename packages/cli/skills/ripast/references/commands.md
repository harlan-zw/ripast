# Commands

Mutations default to dry-run. If the target is uncertain, review the result, then apply once.

| Command | Use |
| --- | --- |
| `ripide rename <from> <to>` | Rename a symbol and its references. |
| `ripide replace <from> <to>` | Replace an imported binding with a project export. |
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

## Scope and output

Use `replace --target-scope <file>` when several files export the replacement.
Quote `--glob` patterns. CSS transforms affect strings, Vue classes, and CSS `@apply` sites.
Use a file glob when the task limits files. A Vue glob also includes script strings in Vue files.
Use `--no-vue` only when there are no Vue consumers or Nuxt auto-imports.
Template commands accept `--scope <file>` and `--root-only`.
Mutation agent JSON returns `mode`, `verification`, and `changes: [[path, lines]]`.
When ranges shift, entries use `[path, beforeLines, afterLines]`. Moves use `moves: [[from, to]]`.
Lines are one-based and inclusive. Commas separate ranges; `3+` marks a gap after line 3.
After apply, earlier file reads are outdated. Read changed ranges only when current code is needed.
Follow any editing tool requirement for a fresh read. Do not reread every changed file just to confirm success.
Use `--profile full --json` when you need complete before/after source.


## Examples

```bash
ripide scan useStore --profile agent
ripide rename useStore useAppStore --scope src/store.ts --profile full
```

These are separate task examples. Run only the requested operation.
Use `--scope` when the declaration file is known.
Use `--profile full` only when you need a diff. Applying with it prints file names, not a diff.
