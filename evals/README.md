# OpenCode comparison

Compare an agent using RipIDE with an agent using normal editing tools.
Each run gets a fresh TypeScript project and the same task.

## Run

Use Linux or macOS, Node 22.13 or newer, pnpm, Git, and an authenticated OpenCode installation.
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
pnpm eval --case rename --arm ripide --skill current
pnpm eval --case rename --arm ripide --skill /path/to/previous/SKILL.md
```

Options: `--model`, `--runs`, `--consumers`, `--case`, `--arm`, `--timeout`, `--out`, `--skill`, and `--preflight`.
`--skill` includes the complete Skill in the RipIDE prompt, replacing the supplied exact CLI command.
The runner records the Skill's SHA-256 hash. Without this option, the comparison does not exercise a Skill.
Cases: `rename`, `rename-file`, and `move`.
Arms: `ripide`, `agent`, and `both`.
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

The RipIDE arm receives the exact command and a prebuilt local launcher.
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

The RipIDE arm receives the current Skill. The baseline receives normal editing tools.
Each case runs once per arm. Three projects run concurrently to bound elapsed time.
Each project alternates its two arms. Timing remains sensitive to concurrent work and provider load.

`check-snapshot` independently checks expected code and compares TypeScript diagnostics against the initial snapshot.
Command launchers record actual RipIDE invocation and successful snapshot checks.
The harness checks these records after each run.

Dependencies, credentials, repository instructions, and generated Nuxt files are excluded from snapshots.
Missing dependencies can produce baseline diagnostics. Only increases fail the diagnostic check.
TypeScript source uses AST comparison. Vue source must match the exact expected class-only diff.
These source slices do not establish full project build, Nuxt auto-import, or browser correctness.
CLI-only preflight needs the local source projects. It does not run in portable CI.

### Second batch and Codex

The second batch excludes all six repositories from the first batch.
It covers C12, Unrouting, Nuxt Link Checker, Nuxt SEO Utils, Nuxt Site Config,
Harlanzw.com, Mdream.dev, Massive Monster, NuxtSEO.com, and Unlighthouse.dev.
Mdream.dev is a separate repository from the Mdream package.

```sh
pnpm eval:projects --batch second --preflight
pnpm eval:projects --batch second --runner split --timeout 150
pnpm eval:projects --batch second --runner codex --case c12
```

Options: `--batch first|second` and `--runner opencode|codex|split|both`.

## Transient check evals

Build the CLI, then run the deterministic preflight or OpenCode agent evals:

```bash
pnpm build
pnpm eval:check --preflight
pnpm eval:check --model zai-coding-plan/glm-5.3-flash --timeout 240
```

The cases cover a boundary bug, native dependency mocks, and a real caller with stale evidence after edits.
Each agent must show a failing assertion, fix behaviour, and show passing assertions through stdin.
The grader independently reruns expected behaviour and rejects added test files.
The integration case must show stale evidence between an equivalent edit and the final recheck.
OpenCode uses isolated settings, provider credentials, and a task directory.
Raw transcripts, token counts, artifacts, and results stay under `~/scratch/`.
Use `--out <empty-directory>` to choose the evidence directory.
Defaults retain the first batch with OpenCode.
Split mode assigns the first five cases in the chosen batch to Codex and the rest to OpenCode.
Filtering by `--case` preserves that assignment.
In the second batch, Codex runs C12, Harlanzw.com, Unrouting, Mdream.dev, and Nuxt Link Checker.
Each assigned runner executes both methods on fresh source copies.

Use `--runner both` to run both models on every selected task:

```sh
pnpm eval:projects --batch second --runner both --timeout 150
```

The ten-case second batch produces 40 runs: ten tasks, two methods, two models.
Each task captures its source once and supplies the same expected edits to both models.
The model that starts alternates by task. The second model reverses method order.
Codex always runs RipIDE first. OpenCode always runs ordinary editing first.
Method order is not balanced within each model. Cache effects can bias timing.
Directories include the runner, such as `c12-codex-ripide`, to keep all four copies separate.
The report keeps one row per task and runner. It does not pool the two models.
This mode fixes differing task assignments. It still provides only one run per method and model.
Source slices omit full project dependencies and generated framework state.

Codex uses `gpt-6-luna` with medium reasoning and emits JSONL events.
It uses temporary configuration and a private authentication copy, deleted after the run.
User configuration, user rules, project instructions, and external Skills are excluded.
Both runners execute without an OS sandbox. Prompts restrict agents to their source copy.
Codex's workspace sandbox blocks RipIDE subprocesses on this host, so it cannot measure the CLI correctly.

Codex reports total input tokens with cached input already included.
The parser counts input plus output once and records cached input separately.
Reasoning tokens are separate only when the event exposes them; otherwise they remain within output.
Codex events do not report cost. A zero placeholder is not a price measurement.
Codex steps count completed turns; OpenCode steps count model steps. Do not compare those counts directly.

Report token and time changes within each runner, using completed pairs only.
In split mode, different models and assigned projects prevent a direct Codex versus OpenCode speed comparison.
In both mode, tasks match, but tool stacks, token accounting, and provider load still affect comparison.
Keep failed attempts, timeouts, and harness setup failures visible in the report.
Recorded second-batch measurements live in [the results file](./results/2026-10-09.json).
The matched 40-run batch lives in [its separate results file](./results/2026-10-09-matched.json).

### GPT-6.1 Sol findings

The [GPT-6.1 Sol report](./results/2026-10-09-6.1-sol.md) records ten second-batch projects with medium reasoning.
Both methods passed all ten cases. RipIDE used 60.4% fewer total tokens and 51.2% less total agent time.
These are single-run measurements. The report includes source commits, model selection, and comparison limits.
The [measurement file](./results/2026-10-09-6.1-sol.json) retains all twenty attempts.

## New registered comparisons

Use [registered experiments](./experiment/README.md) for new held-out comparisons.
This historical runner remains available to reproduce historical method and limitations.
New reports retain setup failures, repair costs, complete boundaries, and independent whole-project grades.
