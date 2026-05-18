# Next steps

Tracked work beyond the stable primitives. Ordered by priority, not commitment. Tiers are rough impact/effort buckets; within a tier, top = do first.

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
- ~~**`ripast delete`**~~ — deletes one unused top-level declaration, refuses if semantic references remain, prunes imports used only by that declaration, and runs the normal dry-run/apply/verify path. Tests in `delete.test.ts`.
- ~~**Vue-aware `--verify`**~~ — `vueRegressions` in `vue-bridge.ts` snapshots Volar diagnostics on `.vue` files before, applies pending changes via `setSnapshot` (in-memory), re-checks. Pre-existing errors aren't flagged as new.

## Tier 3 — Dogfood & validate

Nothing else matters if the primitives drift on real repos.

- ~~**Plugin-level dogfood**~~ — used `ripast rename scanGraph buildScanGraph --scope scan.ts` inside ripast itself. Worked example captured in `README.md`.
- **Self-host on skilld** — run each primitive against the skilld repo in CI. Start read-only (scan), then a rename in a throwaway worktree. (Out-of-repo CI work; tracked here as a pointer.)
- ~~**Monorepo fixture**~~ — covered by `monorepo.test.ts`. Note: ts-morph only auto-loads referenced projects when the tsconfig being opened declares the `references:` itself (app → core works; root-with-references + files:[] does not).
- ~~**Non-TS JS projects**~~ — covered by `js.test.ts` via `makeJsFixture` helper (allowJs tsconfig, no .ts files).

## Tier 4 — Ergonomics

- ~~**`--json` for rename/move**~~ — emits `{ applied, dryRun, blockedByRegression, scanned, summary, changes[], regressions[] }`. Applies atomically when `--apply --json` is passed without regressions; exits 1 on blocked regression.
- ~~**`ripast scan --graph`**~~ — mermaid/DOT dependency graph for a symbol. Uses scan's rg-prefiltered files and draws relative import/export edges between hit files. Tests in `scan.test.ts`.
- ~~**Negative `--glob` entries**~~ — already worked at the rg layer; CLI description now documents `!`-prefixed exclusion (`cli.ts` `globArg`). Recipe in `README.md` (`Recipes & limitations`).
- ~~**Nuxt-aware default scope**~~ — chose the documented-recipe path. `README.md` (`Recipes & limitations`) spells out `--tsconfig .nuxt/tsconfig.json` and an exclude glob; auto-detection deliberately stays out of core.
- **Formatting preservation** — Deferred. ts-morph's printer forces double quotes and semicolons. Post-write ESLint `--fix` or Prettier pass would help, but the lint/format toolchain varies enough that an opt-in `--format` flag is best owned by callers (CI hook or pre-commit) rather than baked into the core CLI. Revisit if a concrete diff-noise complaint surfaces.
- **Encoding / line endings** — Documented as a known limitation in `README.md` (UTF-8 + LF assumed; CRLF/BOM untested). Real fix waits for a repro.

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
- **Text-first import specifier rewrite for move** — Deferred. Raw text mutation through ts-morph's tree proved brittle; revisit only with a separate text patch layer that updates `FileChange.after` directly, not live `SourceFile` nodes.
- ~~**Parallel rg prefilter**~~ — `rgFilesMany` in `util.ts` batches fixed-string patterns into a single `rg -e <pat> -e <pat>` call. Adopted by `component-usages.ts` (`candidateFiles`) and `css-class-source.ts` (`readCssClassSourceFilesForMap`), which previously looped one rg per term/key.

## Tier 6 — Speculative primitives

Deferred. Defer trigger: shipped primitives cover <90% of real refactors. Keep this tier to named, structurally safe refactor operations with clear verification. Arbitrary codemods are out of scope.

- **`ripast extract`** — pull a block/region into a new file. Overlaps with `move` but for unnamed code. Decide if it's distinct enough to warrant its own command.
- **`ripast inline`** — inverse of `move`: pull a single-use imported symbol back into its caller's file. Useful for undoing premature extraction.
- **Default export move** — currently rejected. Convert `export default` → `export function X` on move and update `import X from './a'` sites to `import { X } from './b'`. Tricky: import-name must match the exported name, which a default doesn't constrain.
- **Template-aware markup (Svelte)** — symbol refs inside Svelte markup are invisible to the AST. Needs `svelte/compiler`. (Vue `<template>` is now handled by the Volar bridge + `rewriteTemplateReferences` post-pass.)

## Tier 6.5 — Adapter shape

Deferred. Split trigger: ≥2 Nuxt-only primitives exist.

- **Dedicated `@ripast/nuxt` driver.** `loadAdapter('nuxt')` returns `@ripast/vue` tagged `capabilities.nuxt = true`. Nuxt knowledge sits in `core/nuxt.ts` (auto-import scope, generated path filter, tsconfig path-alias loading, layer-aware specifier resolution) and `vue/finalize-rename.ts` (resolveComponent warning, out-of-scope explicit component imports). Candidates that unlock the split: components-dir global-registration scan, server-route rewriting, layer-aware `move --to-layer`, runtime-vs-build classification. The split moves `core/nuxt.ts` into the new package, makes `@ripast/nuxt` depend on `@ripast/vue` for SFC primitives, and composes `finalizeFileRename` (Vue handles SFC concerns, Nuxt wraps with auto-import/layer logic).

## Tier 7 — Meta / housekeeping

- ~~**Pre-commit hook integration**~~ — Template snippet documented in `README.md` (`Recipes & limitations`). Kept as a template, not a turnkey hook, because the "renamed-looking identifier" heuristic is project-specific.
- **`user-invocable` frontmatter** — Deferred. Hyphenated in Anthropic's docs, underscored in every sibling skill. No-op until plugin validation tightens; one-pass rename when/if that happens.

## Bugs found during nuxtseo.com audit (2026-05-18)

All addressed. Implementation lives in `packages/vue/src/components.ts` (manifest parsing now carries `registeredName`, `source: 'manifest'`) and `packages/core/src/components.ts` (`groupDuplicates` keys on `registeredName`; `buildComponentDetail` prefers a manifest match by `registeredName`). Volar noise is filtered in `packages/vue/src/service.ts` via `installFilteredConsoleWarn` + `isNoisyDiagnostic` (covers `[Vue] Resolve plugin path failed`, `[Vue] Load plugin failed`, `languageId not found`, and `.d.{ts,mts,cts}.map` sidecars). `formatInventory` surfaces `registered: <name>` alongside the canonical column. Regression coverage in `test/components.test.ts` (`pathPrefix:true manifest` describe block, layered fixture under `test/fixtures/nuxt-layers/`).

### ~~`components --dups` reports false positives under default Nuxt `pathPrefix: true`~~

Repro: two files share a basename but live in different nested dirs under a Nuxt layer:
```
layers/admin/app/components/AdminFieldBadge.vue
layers/admin/app/components/admin-fields/AdminFieldBadge.vue
```

`components --dups` flags them as duplicates.

Reality: Nuxt's default `pathPrefix: true` registers the nested file as `AdminFieldsAdminFieldBadge`, not `AdminFieldBadge`. They are NOT runtime duplicates. Confirmed via `.nuxt/components.d.ts`:
```
export const AdminFieldBadge: typeof import("…/AdminFieldBadge.vue")['default']
export const AdminFieldsAdminFieldBadge: typeof import("…/admin-fields/AdminFieldBadge.vue")['default']
```

Fix: group by Nuxt's actual registered name (parse the manifest when available), not by file basename. If basenames collide but registered names don't, label it as a same-basename pair, not a duplicate.

### ~~`components <Name> --json` picks the wrong winner for the same case~~

For the pair above, `components AdminFieldBadge --json` returns the nested file as the canonical `component`. But tag callers (`<AdminFieldBadge>`) resolve to the FLAT file via auto-import; the nested file is dead code at the queried name. So ripast's "canonical" pick is the dead one.

Fix: when the manifest exposes both names, match the queried name against the manifest's exported identifiers, not by stripping path prefixes. Surface both with their actual registered names.

### ~~`source: "filesystem"` reported even when `.nuxt/components.d.ts` is present~~

Manifest existed; ripast still returned `source: "filesystem"` for AdminFieldBadge candidates. Either manifest lookup is silently failing or the field documents something other than what the docs imply ("`[m]` came from the Nuxt manifest").

Fix: honor the manifest when present and label `source: "manifest"`, or document what `filesystem` means under a present manifest.

## Bugs found during nuxtseo.com `shared/` → `layers/core` migration (2026-05-18)

### ~~`rename-file` rewrites cross-app imports with `~/` (app-local alias) instead of relative~~

Fixed in `packages/vue/src/index.ts` (`rewriteUnportableAliasSpecifiers`) + `packages/vue/src/nuxt-paths.ts` (`loadConsumerLocalAliases`, `aliasResolvesToTarget`). After Volar emits consumer edits, we walk up from each consumer to its nearest `.nuxt/tsconfig.json`. If an alias-prefixed specifier in the new text doesn't resolve to the rename target through that consumer's local aliases, we rewrite it to a relative specifier. Regression coverage: `rewrites ~/ to relative when consumer lives under an app with its own .nuxt/tsconfig.json (cross-root)` in `test/rename-file.test.ts`.

### `rename-file` misses barrel imports — unable to reproduce (2026-05-18)

Tried a minimal multi-specifier fixture (`./shared/logging`, `./shared/logging/index.ts`, `~~/shared/logging`, `~~/shared/logging/index`) under bundler module resolution; Volar's `getFileRenameEdits` correctly rewrites all four forms. The reported "1/2 consumers" outcome in nuxtseo.com was probably caused by the missed importers not being part of the project the chosen `--tsconfig .nuxt/tsconfig.json` defined (excluded by `include`/`exclude`, or living in an app whose tsconfig wasn't the one opened). Need a minimal repro from the original repo before adding speculative rg-fallback logic.

### ~~`rename-file --verify` crashes on Nuxt 4 repos with vue-router 4.6+~~

Running `rename-file ... --verify` (the default) crashes inside `vueRegressions` with:
```
[Vue] Resolve plugin path failed: vue-router/volar/sfc-route-blocks
Error: Cannot find module 'vue-router/volar/sfc-route-blocks'
  at ... @vue/language-core/lib/compilerOptions.js:122:59
```

ripast bundles `@vue/language-core@3.2.8`. The nuxtseo.com repo uses `vue-router` (Nuxt-managed); the volar SFC route-blocks plugin path it expects isn't there. Until fixed, every `rename-file` invocation here has to pass `--no-verify` and rely on `nuxi prepare` after the batch.

Fix: catch `MODULE_NOT_FOUND` from `addConfig` for vue-router volar plugins specifically and degrade to no-vue-router verify, rather than failing the whole `--verify` pass.

### ~~Noise: hundreds of `languageId not found` lines per invocation~~

Every `rename-file` call dumps ~100 lines like:
```
languageId not found for file:///…/node_modules/.pnpm/@sentry+nuxt@…/build/types/index.types.d.ts.map
```

Source-map sidecars (`.d.ts.map`, `.d.mts.map`) from sentry, reka-ui, evlog, etc. Volar/TS scans them and complains. They're harmless but they bury the actual rename output (the useful "files: ...", "consumers: x/y" lines are at the very bottom).

Fix: filter `.map` sidecars from the Volar/TS source set, OR silence the `languageId not found` warning when the file is `*.map`.

### ~~Suggested addition: `--registered-as` column~~

For Nuxt projects with non-trivial `pathPrefix`/nested-dir setups, the single most useful column is the actual exported name in `.nuxt/components.d.ts`. Surfaces real collisions and dead-code dirs in one pass without manually cross-referencing the manifest.
