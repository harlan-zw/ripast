# Saved evidence

Save complete evidence once with the original operation's `--json --artifact <new-file.json>` flags.
Keep its `_tag`, verification receipt, stderr, and process exit. Paging does not update that operation's outcome.
Never repeat a mutation or project scan just to read omitted results.
If an applied mutation had no artifact, inspect current source and existing receipts. Do not reapply to create evidence.

Start with the artifact's root menu:

```bash
ripide page --input /tmp/evidence.json
```

Objects expose immediate scalar metadata and paths to nested collections and objects.
Object menus page their children. Large strings expose paths and byte counts through `data.view.omittedValues`.
Arrays page their items. Other values return their selected value.
Long strings return text pages with `data.view.unit` set to `text`.
Text rows contain `line`, `part`, and `text`. Offsets count text parts, not source lines.
Parts preserve UTF-8 characters and newlines. Joining `text` fields from all pages reconstructs the selected string.
Read the selected view at `data.view`. Collection paths appear in `data.view.collections`.
Artifacts differ between commands. Select a path from the menu instead of assuming a root array.
Paths use JSON Pointer syntax. The empty path selects the root.
Escape `/` as `~1` and `~` as `~0` inside property names.
Pages always return JSON. You do not need `--json`.
Use `--input -` to read one JSON document from stdin:

```bash
ripide page --input - < /tmp/evidence.json
```

For a tree artifact, inspect declarations in its first file:

```bash
ripide page --input /tmp/evidence.json --path /files/0/declarations --fields name,line
```

For a mutation's saved source, select its text directly:

```bash
ripide page --input /tmp/mutation.json --path /changes/0/after
```

Select the change path from your artifact's menu. Its shape can differ between operations.

Defaults: `--limit 40`, `--offset 0`, `--page-bytes 4096`, and `--max-bytes 32768`.
Follow `data.view.nextOffset`; page sizes vary with rendered bytes.
The page target retains one item even when it exceeds the target.
If an item exceeds the response ceiling, select its nested paths or increase `--max-bytes`.
Use `--fields` for object rows. Read required details only; keep the full receipt outside model context.

## Session requests

Use `--session` to load the artifact once and keep an immutable evidence snapshot.
The process writes an initial page, then accepts newline-separated JSON requests on stdin.
Each request produces one JSON response line on stdout.
Sessions require a file input. They reject `--input -`, because stdin carries navigation requests.
The session identifies its snapshot with a SHA-256 hash.
Read its identity at `data.source.sha256`. It represents saved evidence, not the current repository state.
If source changed, rerun required verification before relying on old evidence.
The page command's `Result` tag describes navigation. Preserve the original operation's outcome separately.

| Request | Action |
| --- | --- |
| `{"_tag":"Next"}` | Read the next collection or object-menu page. |
| `{"_tag":"Previous"}` | Read the previous visited page. |
| `{"_tag":"Select","path":"/regressions"}` | Select another saved value. |
| `{"_tag":"Select","path":"/regressions","offset":10}` | Select a page starting at offset 10. |
| `{"_tag":"Close"}` | End the session. |

`Select` resets page history and defaults to offset zero.
`Previous` returns the prior visited page for the selected path.
Invalid requests return an `Error` response and preserve navigation state.
If a page includes `nextOffset`, send `Next` to continue.

Batch requests when their paths and desired pages are known:

```bash
ripide page --input /tmp/evidence.json --session <<'NDJSON'
{"_tag":"Select","path":"/files/0/declarations"}
{"_tag":"Select","path":"/files/0/imports"}
{"_tag":"Close"}
NDJSON
```

This example requires a tree artifact with at least one file.
Use live `Next` and `Previous` requests only if your shell tool keeps the process and stdin open.
If it cannot, use batched requests or separate `page --input` calls with `--path` and `--offset`.
Separate calls reread the saved evidence. They do not rerun discovery, verification, or applied changes.

`ripide check` already consumes test code on stdin. Use a separate `ripide page` process for evidence navigation.
