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
