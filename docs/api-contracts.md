# API contract migration

JSON output uses one envelope in every environment:

```json
{ "_tag": "Applied", "command": "rename", "base": "/project", "data": { "changes": [["src/store.ts", "12"]], "verification": [["typescript", "touched", 1, 0]] } }
```

Read `_tag` for the outcome, then read command fields from `data`.
Replace checks against `mode`, `status`, `applied`, or `dryRun` with tag checks.
Mutation tags are `Preview`, `Applied`, `Refused`, and `Empty`.
Discovery, help, and version responses use `Result`. Command errors use `Error`.
Refused mutations and command errors still exit with a non-zero status.
JSON defaults to compact output. Pass `--profile full` for named receipts and full source content.
Agent detection still selects default text verbosity. It does not change JSON output.
Artifacts retain full plans and receipts before writes. Stdout reports the final apply outcome.

## Output limits and saved evidence

Compact pages target 4096 UTF-8 bytes. Compact stdout has a 32768-byte ceiling.
Use `--page-bytes` and `--max-bytes` to set explicit budgets.
Full output has no default budget. Explicit budgets still apply.
Page targets retain at least one result. The stdout ceiling handles oversized results.

Pages include `total`, `matched`, `shown`, `omitted`, `offset`, and `results`.
If another page exists, use `nextOffset`. Do not advance by an assumed result count.
Byte fitting can reduce the displayed count below `--limit`.

If the response exceeds the ceiling, `data` contains an omission response:

```json
{ "_tag": "Applied", "command": "rename", "base": "/project", "data": { "output": { "_tag": "Omitted", "bytes": 60000, "maxBytes": 32768, "artifact": "/tmp/plan.json" }, "next": "..." } }
```

Check `data.output._tag` before reading command-specific fields.
The outer outcome remains authoritative. `Omitted` does not mean the operation failed.
The artifact path appears only when the operation saved an artifact.
Save complete evidence with `--json --artifact <new-file.json>` on the original operation.
Never reapply a mutation to retrieve missing evidence.

Use `ripide page --input <artifact.json>` to inspect saved evidence.
Read its menu at `data.view`, then select a JSON Pointer with `--path`.
Read continuation at `data.view.nextOffset`. `--fields` selects fields in object rows.
Long strings return collections with `unit: "text"` and `line`, `part`, and `text` rows.
Text offsets count parts. Joining text from all pages reconstructs the saved string.

Use `--input -` for one JSON document on stdin.
Use file input with `--session` for NDJSON navigation on stdin and one response per request.
Requests are `Next`, `Previous`, `Select`, and `Close`. Sessions load evidence once.
Separate page calls reread saved evidence without repeating the original operation.
`data.source.sha256` identifies the snapshot. Page responses do not prove current source verification.

## Verification options

Replace CLI `--no-verify` with `--verify-mode none`.
Remove CLI `--verify` to use the operation default, or pass an explicit verification mode.
Only `none`, `touched`, and `project` are accepted.

Replace SDK `verify: false` with `verifyMode: 'none'`.
Replace SDK `verify: true` with an explicit mode, or omit the option to use the operation default.
Rename the SDK string option from `verify` to `verifyMode`.
Legacy SDK options and invalid modes fail before discovery or writes.

| Operation | CLI default | SDK default |
| --- | --- | --- |
| Replace | Project | Project |
| Rename file | Touched | Touched |
| Rename, move, delete | Touched | Touched |

## Formatting imports

Core exports structured analysis, changes, diagnostics, and verification receipts.
Import display helpers from `ripide/presentation` instead of `ripide-api`:

```ts
import { scan } from 'ripide-api'
import { formatHits } from 'ripide/presentation'

const hits = scan('useStore', { cwd: process.cwd() })
console.log(formatHits(hits, false))
```

This includes scan, tree, component, doctor, diff, output selection, and verification display helpers.
Install `ripide` when using presentation helpers. SDK consumers can keep importing analysis from `ripide-api`.
