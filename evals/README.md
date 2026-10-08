# OpenCode comparison

Compare an agent using Ripast with an agent using normal editing tools.
Each run gets a fresh TypeScript project and the same task.

## Run

Use Linux or macOS, Node 22.13 or newer, pnpm, ripgrep, and an authenticated OpenCode installation.
Run these commands from the repository root:

```sh
pnpm build
pnpm eval --preflight
pnpm eval
```

The preflight runs the CLI and correctness checks without model calls.
It does not require OpenCode.
The full comparison defaults to GLM 5.3 Flash, three tasks, and two repeats per arm.

```sh
pnpm eval --model zai-coding-plan/glm-5.3-flash --runs 3 --consumers 50
pnpm eval --case rename --arm both --timeout 180
pnpm eval --case rename --arm ripast --skill current
pnpm eval --case rename --arm ripast --skill /path/to/previous/SKILL.md
```

Options: `--model`, `--runs`, `--consumers`, `--case`, `--arm`, `--timeout`, `--out`, `--skill`, and `--preflight`.
`--skill` includes the complete Skill in the Ripast prompt, replacing the supplied exact CLI command.
The runner records the Skill's SHA-256 hash. Without this option, the comparison does not exercise a Skill.
Cases: `rename`, `rename-file`, and `move`.
Arms: `ripast`, `agent`, and `both`.
Counts and timeout seconds must be positive integers.

Results default to a new directory under `~/scratch/`.
Use a fresh output directory for each comparison.
Each run retains its prompt, project, JSON events, stderr, typecheck output, and measurements.
`summary.json` updates after each run. `report.md` summarizes the completed comparison.
Provider credentials pass through environment variables. The harness does not write them to result files.
OpenCode may write its own local state inside the isolated run home. Treat raw transcripts as private evidence.

## What the numbers mean

| Measurement | Includes |
| --- | --- |
| Seconds | OpenCode startup, inspection, refactor, and the agent's typecheck |
| Tokens | Input, output, reasoning, cache reads, and cache writes across every step |
| Correctness | Expected AST, file set, unchanged configuration, independent typecheck, and arm adherence |
| Cost | Provider-reported cost, retained separately from tokens |

The report uses medians of correct runs per task.
Failed runs remain visible and cause a nonzero exit.
Missing usage or malformed events also fail the run.
The independent grading time is excluded from the speed measurement.

Tasks preserve aliased imports, unrelated symbols, and literal strings.
The AST comparison ignores whitespace, quote style, comments, and an empty module marker.
These fixtures cover TypeScript. They do not measure Vue, CSS, Nuxt, or real repository complexity.

Runs execute sequentially. The first arm alternates between tasks and repetitions.
Both arms use isolated home and configuration directories.
Global Skills, plugins, MCP servers, and project instructions are excluded.
Provider configuration and authentication come from the current OpenCode profile.

The Ripast arm receives the exact command and a prebuilt local launcher.
The baseline may use editing tools or scripts, but cannot use a refactor CLI.
This measures assisted refactoring. It excludes CLI discovery, package installation, and Skill loading.
Shared provider caches and network variation can affect the result.
Use more repeats and larger fixtures before making performance claims.

The setup follows Skilld's isolated OpenCode runner in `scripts/eval-opencode.ts`.
See the [OpenCode CLI documentation](https://opencode.ai/docs/cli/) for provider and model setup.

## Real project source comparisons

Run these commands on a machine with the local projects named in `project-cases.ts`:

```sh
pnpm build
pnpm eval:projects --preflight
pnpm eval:projects --timeout 100
pnpm eval:projects --case unhead --timeout 150
```

The harness reads tracked source from each project's recorded local `HEAD`.
It copies source into fresh scratch directories. It never edits the original project.
Sources cover Unimport, Unhead, Mdream, Skilld, Request Indexing, and Forgd.
Four cases rename TypeScript symbols. Two rename static Vue class tokens.
Each Vue case includes ten affected files and up to ten unrelated files.

The Ripast arm receives the current Skill. The baseline receives normal editing tools.
Each case runs once per arm. Three projects run concurrently to bound elapsed time.
Each project alternates its two arms. Timing remains sensitive to concurrent work and provider load.

`check-snapshot` independently checks expected code and compares TypeScript diagnostics against the initial snapshot.
Command launchers record actual Ripast invocation and successful snapshot checks.
The harness checks these records after each run.

Dependencies, credentials, repository instructions, and generated Nuxt files are excluded from snapshots.
Missing dependencies can produce baseline diagnostics. Only increases fail the diagnostic check.
TypeScript source uses AST comparison. Vue source must match the exact expected class-only diff.
These source slices do not establish full project build, Nuxt auto-import, or browser correctness.
CLI-only preflight needs the local source projects. It does not run in portable CI.
