# Installation and launchers

If the task supplies an executable, use it. Prefer an existing project installation over a global CLI.
If only a global CLI is available on PATH, use `ripast` directly.
Otherwise, use the project's package manager from its instructions, metadata, or lockfile.
Do not switch package managers or probe versions solely to choose a launcher.

For repeated use, prefer installing globally once over a temporary launcher on every command.
If no CLI is installed, use the matching global command, then run `ripast` directly:

| Package manager | One-time global installation |
| --- | --- |
| npm | `npm install -g @ripast/cli @ripast/vue` |
| pnpm | `pnpm add -g @ripast/cli @ripast/vue` |
| Bun | `bun add -g @ripast/cli @ripast/vue` |
| Yarn Classic | `yarn global add @ripast/cli @ripast/vue` |

Yarn 2+ has no global install command. Use npm for global tooling, or the Yarn launcher below.
Include `@ripast/vue` to avoid temporary adapter installation in Vue/Nuxt projects.
Respect environment rules that prohibit global installs. Use temporary launchers for one-off or restricted environments.
If the global binary is unavailable, add the manager's global bin directory to PATH or use a temporary launcher.
Do not reinstall before each command or silently upgrade an existing CLI.

| Package manager | Installed CLI | Temporary CLI |
| --- | --- | --- |
| npm | `npm exec -- ripast` | `npm exec --yes --package=@ripast/cli -- ripast` |
| pnpm | `pnpm exec ripast` | `pnpm dlx @ripast/cli` |
| Yarn 2+ | `yarn exec ripast` | `yarn dlx --package @ripast/cli ripast` |
| Bun | `bunx --no-install --package @ripast/cli ripast` | `bunx --package @ripast/cli ripast` |

Yarn Classic uses `yarn exec -- ripast` for an installed CLI, or the npm temporary command.
The Classic `--` separator ensures flags such as `--apply` reach Ripast.
If the package manager is unknown, use npm for global installation, or its temporary command for one-off use.

Examples use `ripast`. Substitute your launcher.
If an executable is provided, skip installation and version probes.

Launcher flags: [npm](https://docs.npmjs.com/cli/npm-exec/), [Yarn](https://yarnpkg.com/cli/dlx), [Bun](https://bun.sh/docs/pm/bunx).
Global installation: [npm](https://docs.npmjs.com/cli/v11/commands/npm-install/), [pnpm](https://pnpm.io/cli/add), [Bun](https://bun.sh/docs/pm/cli/add), [Yarn Classic](https://classic.yarnpkg.com/lang/en/docs/cli/global/).

## Adapters and runtime

The CLI installs missing Vue/Nuxt adapters through pnpm, then npm. pnpm is optional.
If neither is available, install the CLI and adapter together with the project's package manager.
Yarn 2+ can include both temporarily: `yarn dlx -p @ripast/cli -p @ripast/vue ripast <command> ...`.
Keep Node available for Bun launchers. Do not force Bun's runtime with `--bun`.
