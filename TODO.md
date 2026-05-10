# Next steps

Tracked work beyond the stable three primitives. Ordered by priority, not commitment. Tiers are rough impact/effort buckets; within a tier, top = do first.

## Tier 1 — Correctness & safety

All shipped. Kept in the log as a pointer to where these live.

- ~~**Transitive non-exported deps**~~ — `move` now refuses with `ripast move: "X" depends on local non-exported symbol(s) [...]`. Implementation: `findTransitiveLocalDeps` in `move.ts`. Tests in `patterns.test.ts`.
- ~~**Multi-declarator `const` move**~~ — auto-splits `export const a = 1, b = 2` before moving. Implementation: `splitMultiDeclaratorIfNeeded` in `move.ts`. Test in `patterns.test.ts`.
- ~~**Atomic `--apply`**~~ — `writeChanges` now writes `.tmp` files then renames; unlinks tmp on failure. Tests in `atomic.test.ts`.
- ~~**Re-exports via `export *`**~~ — verified rename + move propagate through wildcard barrels. Tests in `patterns.test.ts`.
- ~~**Moved decl → exported sibling**~~ — `move` now auto-imports exported siblings referenced by the moved decl, pointing back to the source file. Implementation: second return array from `findLocalSiblingDeps` in `move.ts`. Test in `patterns.test.ts`.

## Tier 2 — Highest-value user gap

- ~~**Vue SFC rename/move**~~ — Volar bridge in `vue.ts` + `vue-bridge.ts`. `rename` and `move` propagate into `<script>` blocks via `@volar/language-service` + `volar-service-typescript` + `@vue/language-core`. Template-AST post-pass in `vue-template.ts` (`rewriteTemplateReferences`) sweeps what Volar misses: pure-template-only identifier refs and component tag usage (PascalCase + kebab-case, casing preserved). Respects `v-for` shadowing; skips string literals, member-access keys, object-property keys.
- ~~**Vue SFC scan (template)**~~ — `scan` now extracts template AST via `@vue/compiler-sfc` and parses each interpolation/directive expression with oxc, classifying like script.
- ~~**`ripast rename-file`**~~ — new primitive. Calls Volar's `getFileRenameEdits` for cross-file import rewriting (handles `.vue` consumers + component-name mapping). Lazy-inits Volar only when needed.
- ~~**Vue-aware `--verify`**~~ — `vueRegressions` in `vue-bridge.ts` snapshots Volar diagnostics on `.vue` files before, applies pending changes via `setSnapshot` (in-memory), re-checks. Pre-existing errors aren't flagged as new.

## Tier 3 — Dogfood & validate

Nothing else matters if the primitives drift on real repos.

- ~~**Plugin-level dogfood**~~ — used `ripast rename scanGraph buildScanGraph --scope scan.ts` inside ripast itself. Worked example captured in `README.md`.
- **Self-host on skilld** — run each primitive against the skilld repo in CI. Start read-only (scan), then a rename in a throwaway worktree.
- ~~**Monorepo fixture**~~ — covered by `monorepo.test.ts`. Note: ts-morph only auto-loads referenced projects when the tsconfig being opened declares the `references:` itself (app → core works; root-with-references + files:[] does not).
- ~~**Non-TS JS projects**~~ — covered by `js.test.ts` via `makeJsFixture` helper (allowJs tsconfig, no .ts files).

## Tier 4 — Ergonomics

- ~~**`--json` for rename/move**~~ — emits `{ applied, dryRun, blockedByRegression, scanned, summary, changes[], regressions[] }`. Applies atomically when `--apply --json` is passed without regressions; exits 1 on blocked regression.
- ~~**`ripast scan --graph`**~~ — mermaid/DOT dependency graph for a symbol. Uses scan's rg-prefiltered files and draws relative import/export edges between hit files. Tests in `scan.test.ts`.
- **Formatting preservation** — ts-morph's printer forces double quotes and semicolons. Post-write ESLint `--fix` or Prettier pass keeps diffs minimal. Gate behind a flag.
- **Encoding / line endings** — assume UTF-8 + LF. CRLF / BOM files untested.

## Tier 5 — Performance

No evidence it's slow on real repos yet, so measure before optimising.

- ~~**Benchmarks first**~~ — added `bench/bench.ts` plus reusable `bench/fixture.ts` measuring scan/tree/rename/move on a ~500-file fixture. Run with `pnpm bench`; tune via `RIPAST_BENCH_FILES`, `RIPAST_BENCH_IMPORTERS`, and `RIPAST_BENCH_RUNS`.
- ~~**Phase budget**~~ — `rename` / `move` accept an internal `profile` sink, and `pnpm bench` prints median phase timings. Current main blockers after lazy loading: TypeScript rename transform (~125ms in no-verify mode), scoped diagnostics (~125ms combined when verify is on), and rg itself (~7-8ms).
- ~~**Use rg as candidate oracle**~~ — `rename` uses `rg(from)` to narrow declaration search, change collection, and verify scope. `move` uses `rg(symbol)` to narrow import-site rewrites. Keep ts-morph for semantic mutation inside the candidate set.
- ~~**Scope verify to touched files**~~ — `verify.ts` accepts a source-file scope. `rename` verifies files containing the renamed symbol; `move` verifies source/target plus direct importers. On the 500-file bench, median `rename --verify` dropped ~694ms -> ~231ms.
- ~~**Fast relative import checks for move**~~ — `move` now resolves simple relative import specifiers without asking ts-morph's module resolver for every import. Later passes also removed checker-backed local-dep analysis and fast-path sole named imports by changing only the module specifier. On the 500-file bench, median `move --no-verify` dropped ~904ms -> ~37ms; `move --verify` dropped ~1357ms -> ~162ms.
- ~~**Lazy source-file loading**~~ — `rename` / `move` default to `skipAddingFilesFromTsConfig: true` when Vue and full-project verify are disabled, then load only rg candidates plus required source/target files. Project load dropped from ~75-100ms to ~2-3ms on the 500-file bench.
- ~~**Verification modes**~~ — `verify` accepts `none`, `touched`, or `project`; CLI exposes `--verify-mode touched|project|none` while keeping `--no-verify`.
- ~~**Batch/reuse API hook**~~ — `runRename` and `runMove` accept an existing ts-morph `project` for callers that want to batch several operations and pay project setup once.
- **Text-first import specifier rewrite for move** — raw text mutation through ts-morph's tree proved brittle. Revisit only with a separate text patch layer that updates `FileChange.after` directly, not live `SourceFile` nodes.
- **Parallel rg prefilter** — for `scan` over many patterns, batch via `rg --regexp ... --regexp ...`. Free win.

## Tier 6 — Speculative primitives

Defer until the shipped primitives cover <90% of real refactors. Keep this tier to named, structurally safe refactor operations with clear verification. Arbitrary codemods are out of scope.

- **`ripast extract`** — pull a block/region into a new file. Overlaps with `move` but for unnamed code. Decide if it's distinct enough to warrant its own command.
- **`ripast inline`** — inverse of `move`: pull a single-use imported symbol back into its caller's file. Useful for undoing premature extraction.
- **Default export move** — currently rejected. Convert `export default` → `export function X` on move and update `import X from './a'` sites to `import { X } from './b'`. Tricky: import-name must match the exported name, which a default doesn't constrain.
- **Template-aware markup (Svelte)** — symbol refs inside Svelte markup are invisible to the AST. Needs `svelte/compiler`. (Vue `<template>` is now handled by the Volar bridge + `rewriteTemplateReferences` post-pass.)

## Tier 7 — Meta / housekeeping

- **Pre-commit hook integration** — optional git hook that runs `ripast scan` over renamed-looking identifiers in changed files to catch incomplete manual renames.
- **`user-invocable` frontmatter** — hyphenated in Anthropic's official docs, underscored in every sibling skill here. If plugin validation ever tightens, rename across all skills in one pass.
