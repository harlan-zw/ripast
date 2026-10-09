# Octane TSRX support

This optional package adds authored-source parsing and a native TypeScript content-mapper bridge for Octane `.tsrx` files. Plain TypeScript and Vue keep RipIDE's existing compiler. TSRX semantic operations use this package's pinned native TypeScript build.

Requires Node 22.22.2 or newer. Install the optional adapter in the consumer project, keeping its existing Octane version:

```sh
bun add --dev ripide ripide-tsrx @tsrx/content-mapper
```

Add the mapper to the consumer's tsconfig, retaining its other compiler options:

```json
{
  "contentMappers": [
    {
      "package": "@tsrx/content-mapper",
      "extensions": [".tsrx"],
      "options": { "compiler": "ripide-tsrx/compiler" }
    }
  ],
  "include": ["src/**/*.ts", "src/**/*.tsx", "src/**/*.tsrx"]
}
```

Scanning requires the adapter and the project-local Octane compiler. Semantic operations additionally require explicit external-code opt-in. The CLI refuses a missing or broken mapper before writing:

```sh
bunx --package ripide ripide scan oldFn --profile full

RIPIDE_RUN_EXTERNAL_CODE=1 bunx --package ripide ripide \
  rename oldFn newFn --scope src/helper.ts --profile full

# Apply after reviewing the preview
RIPIDE_RUN_EXTERNAL_CODE=1 bunx --package ripide ripide \
  rename oldFn newFn --scope src/helper.ts --apply
```

`test/tsrx.test.ts` exercises the built CLI, using Octane 0.10.2 and the official mapper. It covers authored positions, templates, conditional and loop expressions, sibling control flow inside a fragment, import aliases, component tags, type annotations, local bindings, new type errors, file renames, and refusal to apply malformed or unconfigured input.

Known limits:

- This adapter targets Octane. Other TSRX compilers are not qualified.
- A code block renders one output node. Wrap sibling `@if` and `@for` outputs in `<>…</>`. Octane 0.10.2's Volar compiler throws instead of returning a diagnostic for the invalid bare form; RipIDE refuses to write it.
- Moving or deleting a declaration authored in TSRX, CSS class migrations, mixed Vue/TSRX projects, and monorepo-wide project references are not qualified.
- A successful CLI rename is not a full application build. Keep the consumer's existing typecheck and build gates.

Repository development uses its existing pnpm workspace:

```sh
pnpm install
pnpm build
pnpm test test/tsrx.test.ts
pnpm typecheck
pnpm lint
```
