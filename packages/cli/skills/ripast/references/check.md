# Transient checks

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

