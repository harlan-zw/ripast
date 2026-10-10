# Unreleased

- Prefer ripgrep when available. If it is missing, Git discovers tracked and untracked files, including local edits.
- Use Node file search when both tools are missing or Git has no working tree. Ripgrep remains optional.
- Rename adapter SDK helpers `rgFiles` and `rgFilesMany` to `findFiles` and `findFilesMany`.
- Programmatic regex searches use ripgrep syntax, or Git extended regular expressions with the Git fallback.

# 0.5.0

## 👀 Highlights

Ripast 0.5.0 gives coding agents semantic refactors across files.

Preview symbol renames, declaration moves, and file renames before writing changes.
Supported refactors compare type diagnostics and block writes when verification finds new errors.
Default verification checks touched files. Use `--verify-mode project` to check the full project.

This release includes the Ripast Agent Skill and fallbacks for missing ripgrep or pnpm.
Requires Node 22.13 or later. See the [SDK upgrade guide](./docs/upgrade-0.5.0.md) for API changes.

### 🧠 Native TypeScript refactors

Rename, move, delete, and file rename use the native TypeScript server.
Verification compares diagnostics before and after the proposed changes.
Nuxt refactors respect the selected generated configuration.

### 🛠️ Tool fallbacks

If ripgrep is missing, Ripast searches files in Node.
If pnpm is missing, adapter installation uses npm.
Windows package-manager shims preserve literal arguments.

### 🎯 Replacement targets and Agent Skill

Replacement can select named barrels and explicit import aliases.
The CLI package includes the Ripast Agent Skill for installation through skilld.

## ⚠️ Breaking changes

- Use Node 22.13 or later. Version 0.4.0 accepted Node 20.11.
- Remove `project` and `lazy` from SDK refactor options. Use `cwd` and `tsconfig` instead.
- Replace `snapshotDiagnostics` and `DiagnosticSnapshot` usage with the native server verification API.
- Await `findRegressions(server, changes, files)`. Its previous signature accepted a snapshot and a ts-morph project.
- Remove unsupported CLI options and extra positional arguments. The CLI now rejects them before changing files.

See the [SDK upgrade guide](./docs/upgrade-0.5.0.md).

## ✅ Upgrading

```sh
npm install @ripast/cli@0.5.0
npm install @ripast/core@0.5.0 @ripast/vue@0.5.0
```

Install the CLI for command use. Install core and Vue for SDK use with Vue projects.
Ripgrep remains optional for CLI commands. Programmatic regex searches still require it.

## 👉 Changelog

[Compare v0.4.0 and v0.5.0](https://github.com/harlan-zw/ripast/compare/v0.4.0...v0.5.0)

### 🚀 Enhancements

- Use the native TypeScript server for refactors ([#4](https://github.com/harlan-zw/ripast/pull/4)).
- Include the Ripast Agent Skill in the CLI package ([#10](https://github.com/harlan-zw/ripast/pull/10)).
- Select named barrels and explicit replacement import aliases ([#15](https://github.com/harlan-zw/ripast/pull/15)).

### 🩹 Fixes

- Load selected configurations before native refactors ([#6](https://github.com/harlan-zw/ripast/pull/6)).
- Preserve replacement wrappers and Vue compiler APIs ([#8](https://github.com/harlan-zw/ripast/pull/8)).
- Preserve replacement import extensions ([#9](https://github.com/harlan-zw/ripast/pull/9)).
- Repair adapter startup and local declaration renames ([#12](https://github.com/harlan-zw/ripast/pull/12)).
- Add ripgrep and pnpm fallbacks ([#13](https://github.com/harlan-zw/ripast/pull/13)).
- Preserve commas inside glob patterns ([#14](https://github.com/harlan-zw/ripast/pull/14)).
- Resolve Windows package-manager shims and correct package declaration paths.

### 🏡 Chore

- Update dependencies and retain the provenance-backed Pug dependency pin ([#5](https://github.com/harlan-zw/ripast/pull/5), [#11](https://github.com/harlan-zw/ripast/pull/11)).
- Validate installed CLI and SDK packages on Linux and Windows.

> 🤖 Harlan Agent Kit wrote these release notes.
