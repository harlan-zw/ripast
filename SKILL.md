---
name: ripast
description: AST-aware rename, move, extract, find-usages, and tailwind/CSS class migration across TS/JS/Vue SFCs (incl. `<template>`). Use for any multi-file rename, move, import update, or refactor mechanical step. Prefer over Edit/grep whenever a change spans more than one file.
user_invocable: true
---

Surgical Edits are slow and miss things (shadowed identifiers, type-only imports, JSX refs). `ripast` parses only the files ripgrep says contain the token, then uses the AST to decide what to change. Core primitives are gated by tests, and mutating primitives include a post-transform typecheck safety net (except `css-class-rename`, which targets CSS tokens and has no typecheck signal). Vue SFCs supported via Volar: rename + move propagate into `<script>` blocks; scan covers `<template>` interpolations and directive expressions; verify catches new diagnostics in `.vue` consumers.

## When to reach for this vs Edit

| Situation | Tool |
| --- | --- |
| Single site, or <5 matches in one file | Edit |
| "Where is X used?" | `ripast scan` |
| Rename a symbol across the repo | `ripast rename` |
| Replace one imported API with another project export | `ripast replace` |
| Move a declaration to another file (update all imports) | `ripast move` |
| Delete an unused top-level declaration | `ripast delete` |
| Rename a file and update every import site | `ripast rename-file` |
| Rename a tailwind/CSS utility class across the repo | `ripast css-class-rename` |
| List every class token in the repo (seeds a rename map) | `ripast css-class-scan` |
| Pattern is only meaningful inside strings/comments | plain `rg` + Edit |

When in doubt, start with `scan` — it's cheap, and its output tells you which of rename/move/Edit fits. Gate: if `rg -c 'PATTERN' | awk '{s+=$1}END{print s}'` is <10 and single-file, just Edit.

## Invocation

`ripast` ships as `@ripast/cli` on npm. Run via `npx`:

```bash
npx -y @ripast/cli <command> ...
```

Or install once and call directly:

```bash
npm i -g @ripast/cli
ripast <command> ...
```

The CLI auto-installs the matching framework adapter (e.g. `@ripast/vue` for Vue/Nuxt projects) on first run. To pre-bundle and skip the re-exec, pass adapters with `-p`:

```bash
npx -y -p @ripast/cli -p @ripast/vue ripast rename useStore useAppStore --apply
```

Requires `rg` (ripgrep) on PATH and Node 20.11+.

All mutating commands default to **dry-run** (print a unified diff with a `N files, +A -R lines` header). Pass `--apply` to write. `--verify` (on by default for rename/replace/move/delete) runs a ts-morph post-transform typecheck and refuses `--apply` if new diagnostics appear; pass `--no-verify` to skip. Use `--verify-mode touched|project|none` to choose scoped, full-project, or no diagnostics. Pass `--json` on rename/replace/move/delete for machine-readable output (`{ applied, dryRun, blockedByRegression, scanned, summary, changes[], regressions[] }`).

All commands accept `--profile auto|agent|full`. `auto` uses `std-env`'s `isAgent`; detected agents get compact, low-token summaries by default. Use `--profile full` when you need full scan rows or dry-run diffs, and `--json` when another tool will parse the result.

## Commands

Core commands, each shipping with clear failure modes.

### `ripast scan <pattern> [--glob g1,g2] [--kind k1,k2] [--graph mermaid|dot] [--profile auto|agent|full] [--json]`

Classify every occurrence (including Vue SFC `<template>` interpolations and directive expressions like `v-if`, `v-for`, `:prop`). Kinds: `identifier-reference`, `identifier-binding`, `import-specifier`, `member-access`, `property`, `jsx`, `string-literal`.

Use this first to decide which tool is next:
- all `identifier-*` / `import-specifier` → safe to `rename`
- mixed with `string-literal` or `property` on unrelated objects → narrow with `--kind` or use `--scope` on rename
- single file with a handful of hits → just Edit

```bash
ripast scan useStore
ripast scan useStore --kind identifier-reference,import-specifier
ripast scan useStore --graph mermaid
ripast scan useStore --profile full
```

Pass `--graph mermaid` or `--graph dot` to draw relative import/export edges between the files that contain hits. This is a quick triage view before a larger rename; it intentionally uses scan's rg-prefiltered file set instead of loading the full TS project.

### `ripast tree [--glob g1,g2] [--exports all|exported|local] [--profile auto|agent|full] [--json]`

Print a project declaration tree from top-level AST declarations, grouped by file. Use this to skim architecture before a refactor: `--exports exported` shows public API surface, `--exports local` shows internals, and `--exports all` shows both. Each file also lists import and re-export specifiers for context.

`--profile auto` uses `std-env`'s `isAgent` detection. In agent environments, the default output is a compact architecture summary and the default export filter is `exported`; in normal terminals, the default is the full tree with `all` declarations.

```bash
ripast tree --exports exported
ripast tree --exports local --glob '*.ts'
ripast tree --profile agent --glob '*.ts,!test/**'
```

### `ripast unused [--glob g1,g2] [--exports all|exported|local] [--tsconfig path] [--json]`

Report top-level declarations with no semantic project references. The default is `--exports local`; use `--exports exported` or `--exports all` when you explicitly want to inspect public API symbols too. Treat this as "unreferenced top-level declarations", not a complete dead-code or entrypoint reachability model.

```bash
ripast unused
ripast unused --exports local
ripast unused --exports all --json
```

### `ripast rename <from> <to> [--scope file] [--all] [--tsconfig path] [--apply] [--no-verify] [--verify-mode touched|project|none] [--profile auto|agent|full] [--json]`

Scope-aware rename via ts-morph. Finds the declaration, TypeScript propagates to every reference (imports, JSX, type positions, aliased imports). Object property keys with the same spelling are NOT touched unless they genuinely reference the same symbol.

```bash
ripast rename useStore useAppStore --apply
```

**Ambiguity handling.** If the name is declared in more than one file, ripast refuses and asks for:
- `--scope <file>` to target one declaration, or
- `--all` to rename every declaration (plus all references) across files.

### `ripast replace <from> <to> [--target-scope file] [--tsconfig path] [--glob g1,g2] [--apply] [--no-verify] [--verify-mode touched|project|none] [--profile auto|agent|full] [--json]`

Replace references to an imported binding with another project export. Resolves `<to>` from exported declarations in the project, rewrites the consumer import, prunes the old import, and preserves the call/body shape. Use this for API migrations like `eventHandler(...)` → `defineAdminApiHandler(...)`; it does not remove semantic body statements such as `await requireAdminAuth(event)`.

```bash
ripast replace eventHandler defineAdminApiHandler
ripast replace eventHandler defineAdminApiHandler --apply
ripast replace eventHandler defineAdminApiHandler --target-scope layers/admin/server/utils/admin-api.ts --apply
```

**Ambiguity handling.** If `<to>` is exported from multiple files, ripast refuses and asks for `--target-scope <file>`.

### `ripast move <symbol> --from <source> --to <target> [--tsconfig path] [--apply] [--no-verify] [--verify-mode touched|project|none] [--profile auto|agent|full] [--json]`

Move a top-level exported declaration and rewrite every import site. Supported: `function`, `class`, `interface`, `type`, `enum`, `const` (single declarator; multi-declarator is auto-split before moving). Default exports are rejected with a clear error.

Behaviour:
- Splits multi-named imports: `import { helper, other } from './a'` becomes `import { other } from './a'` + `import { helper } from './b'`
- Auto-splits `export const a = 1, b = 2` before moving `a`, leaving `export const b = 2` intact in the source
- Refuses to move a declaration that depends on a local non-exported helper (would silently break). Export the helper first, or move both.
- Merges into an existing import from the target when one exists
- Copies transitive imports used by the moved declaration
- Prunes now-unused imports in the source
- If siblings in the source still reference the moved symbol, adds an import pointing to the new location (source stays valid)
- Preserves import aliases

```bash
ripast move helper --from src/utils/a.ts --to src/utils/helpers.ts --apply
```

Target file is created if missing.

### `ripast delete <symbol> --from <source> [--tsconfig path] [--apply] [--no-verify] [--verify-mode touched|project|none] [--profile auto|agent|full] [--json]`

Delete one unused top-level declaration and prune imports that were only used by that declaration. Supported: `function`, `class`, `interface`, `type`, `enum`, `const`/`let`/`var` with a single declarator. Refuses if semantic reference lookup finds remaining usages and prints their locations.

```bash
ripast delete helper --from src/utils.ts
ripast delete helper --from src/utils.ts --apply
```

### `ripast rename-file <old> <new> [--tsconfig path] [--apply] [--profile auto|agent|full] [--json]`

Rename a file and rewrite every import site (including `.vue` consumers and component-name refs). Volar-driven, so cross-`.vue` imports get correct relative paths and PascalCase↔kebab-case mapping for component renames.

```bash
ripast rename-file src/utils.ts src/lib/helpers.ts --apply
```

Refuses if the source doesn't exist or the target already exists. Requires a `tsconfig.json`.

Vue/Nuxt-aware behaviours layered on top of the Volar rewrite:
- **`resolveComponent('Name')` sites.** When a renamed `.vue` is referenced by string via `resolveComponent`, ripast rewrites the literal to the new name and emits a warning. The component still needs to stay globally registered (plugin `app.component(...)` or Nuxt `components/`) for those sites to resolve.
- **Out-of-auto-import-scope component moves.** Moving a `.vue` from a Nuxt auto-import dir (e.g. `components/`) into a folder outside auto-import scope (e.g. `lib/`) adds an explicit `import Name from '<specifier>'` to every consumer `<script setup>` that uses the tag. Refuses with a clear error if a consumer is template-only (no `<script>` block).
- **Layer-alias preference.** Explicit imports added by ripast prefer a tsconfig path alias when one cleanly resolves the target file (`.nuxt/tsconfig.json` is consulted first, then the project tsconfig). Within the same alias root (same layer) the import stays relative. The same rule applies to explicit imports added by `move` when a util/composable leaves Nuxt auto-import scope.

### `ripast css-class-rename <from> <to> | --map <file.json> [--glob g1,g2] [--apply] [--profile auto|agent|full] [--json]`

Rename CSS utility class token(s) (tailwind, UnoCSS, etc.) across the repo. Tokenizes every string literal, Vue template `class` / `:class` attribute, and `@apply` directive body, then rewrites tokens whose non-variant tail matches a map key. Variant prefixes (`hover:`, `dark:md:`), `!` important markers, and arbitrary values (`bg-[url(a:b)]`) are preserved. Colons inside `[...]` are not treated as variant separators.

Single-pair form:

```bash
ripast css-class-rename bg-gray-500 bg-neutral-500 --apply
```

Bulk form (design-token migrations):

```bash
ripast css-class-rename --map tokens.json --apply
```

`tokens.json` is a flat object mapping old → new:

```json
{
  "bg-gray-500": "bg-neutral-500",
  "text-gray-900": "text-fg",
  "border-gray-200": "border-muted"
}
```

Pass **either** the `from`/`to` positionals **or** `--map`, not both.

Covers `.ts`/`.tsx`/`.js`/`.jsx`/`.vue` (script + template) and `.css`/`.scss`/`.sass`/`.less`/`.postcss`/`.pcss` (via `@apply`). Substring matches are ignored (`bg-gray-5000` is not touched when renaming `bg-gray-500`).

Semantics:
- **No chaining.** If the map has `A → B` and `B → C`, a token `A` becomes `B` (one hop); a token `B` becomes `C`. Rewritten tokens are not re-looked-up in the same pass.
- **No typecheck verify** — classes aren't typed. Primary safety nets are the dry-run diff and your project's existing Tailwind/UnoCSS lint.
- **No variant-group expansion in v0** (e.g., `hover:(bg-gray-500 text-white)` — the inner tokens aren't rewritten under the outer group).

### `ripast css-class-scan [--pattern globs] [--glob g1,g2] [--by token|file] [--sort ...] [--profile auto|agent|full] [--json]`

Tokenize every class site (string literals, Vue `class`/`:class` attrs, `@apply` bodies) and emit sortable frequency lists. Variants and `!` important are stripped for counting, so `hover:bg-gray-500` contributes to the `bg-gray-500` count. Designed to seed `--map` files for `css-class-rename` — what token scan reports is exactly what rename will match. Use `--sort count-asc` to surface barely used classes for cleanup, or `--by file` to find files introducing the most unique class tokens.

```bash
ripast css-class-scan
ripast css-class-scan --sort count-asc
ripast css-class-scan --by file
ripast css-class-scan --pattern 'bg-*,text-*,border-*'
ripast css-class-scan --json > tokens.raw.json
```

Token output format (text): `<token>  <count>  (N files)`. Default token sort is `count-desc`; other token modes are `count-asc` for rare tokens first and `token` for alphabetical output.

File output format (`--by file`): `<file>  <unique> unique  <total> total`. Default file sort is `unique-desc`; other file modes are `unique-asc`, `count-desc`, `count-asc`, and `file`.

Pattern filter is a trivial comma-separated glob (`*` wildcards only) matched against the bare token. Useful for narrowing to a palette (`bg-gray-*`) or a family of utilities. No pattern = all tokens.

Heuristic token filter rejects obvious non-classes: pure numbers, tokens with unusual shapes, anything not matching `word-chars (optional [...]) (optional /opacity)`. False positives are OK (user edits the output into a map); false negatives would silently drop real tokens, so the shape regex is generous.

Not a replacement for `rg` when you want exact positions — this is an aggregation tool. For positions, use `ripast scan <token>` after identifying candidates.

## Workflow

1. **Scan first.** Get a count + kind breakdown. `scan` is cheap; run it freely.
2. **Dry-run.** Read the summary (`N files, +A -R lines`) and the diff. Sanity-check at least two files.
3. **Apply with verify on.** Re-run with `--apply`. If `--verify` reports new type errors, ripast refuses the write and shows the diagnostics — investigate rather than `--no-verify`.
4. **Final check.** `pnpm typecheck && pnpm test` catches anything ripast's verify missed.

## Tests

175 tests in `test/` (scan, tree, rename, replace, rename-file, move, delete, verify, roundtrip, idempotence, patterns, strict, smoke, atomic, vue). Run from the package repo with `pnpm test`.

Coverage spans: kind classification, scan dependency graph output, Vue SFC script-block extraction, import dedupe, cross-file rename, imported-symbol replacement, property-vs-reference disambiguation, shadowing, aliased-import preservation, JSX components, type-only imports (both forms), re-exports, namespace imports, multi-named import splitting, transitive import copy, unused import pruning, safe declaration delete, decorator preservation, ambiguity detection with `--scope` / `--all`, idempotence (second run throws, no silent drift), roundtrip identity (rename A→B→A, move x a→b→a), typecheck regression detection, and a realistic multi-file smoke test.

## Gotchas

- **Vue SFC** — `scan` covers script + template (interpolations, `v-if`/`v-for`/`:prop` expressions). `rename` and `move` propagate into `<script>` blocks via Volar, then a template-AST post-pass sweeps remaining template references: component tag usage (`<MyButton>` and `<my-button>`, casing preserved) and pure-template-only identifier refs (used in `` or `:prop` but never in script). The post-pass respects `v-for` shadowing and skips string literals, member-access keys, and object-property keys. `<style>` references are out of scope. Pass `--no-vue` to force pure ts-morph behavior if Volar misbehaves.
- **Svelte** — not supported.
- **`move` auto-splits multi-declarators** — `export const a = 1, b = 2` with `move a` splits the statement first. The leftover `b` stays put.
- **`move` refuses on local non-exported deps** — if the moved symbol depends on a non-exported helper in the same file, `move` aborts with an actionable error. Export the helper first, or move both.
- **ts-morph on large monorepos** — loads the full TS project; expect 2-3 s startup for `rename`/`move`. `--no-verify` halves the time.
- **Always commit before `--apply`** — rollback is `git checkout .`.

## What this skill is NOT for

- One-shot fixes in a file you're already reading — Edit is faster.
- Pattern matches that are conceptually text, not code (e.g., copy strings). Use `rg` + Edit.
- Renames across Svelte markup. (Vue `<template>` IS supported via Volar + a template-AST post-pass.)
- Arbitrary codemods. Custom AST transforms are out of scope for the stable surface.
