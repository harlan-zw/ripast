# Registered experiments

Use this harness for new comparisons. Preserve historical batches as separate evidence.
The scripted transport pilot tests recording and grading. It does not measure agent productivity.

```mermaid
flowchart LR
  manifest[Register tasks and budgets] --> freeze[Hash manifest and treatment artifacts]
  freeze --> prepare[Install and prepare fresh projects]
  prepare --> record[Record each serial attempt externally]
  record --> grade[Independent project and symbol checks]
  grade --> report[Quality before all attempt resources]
```

## Local transport pilot

Build package exports before registering their hashes.
Keep output directories under private `~/scratch/`.
Use a fresh output directory for each revision.

```sh
pnpm build
pnpm exec tsx evals/experiment/cli.ts fixture --installed --nuxt --out ~/scratch/ripide-pilot-registration
pnpm exec tsx evals/experiment/cli.ts run --manifest ~/scratch/ripide-pilot-registration/fixture-manifest.json --out ~/scratch/ripide-pilot-results
```

The fixture includes rename, move, file relocation, import replacement, architecture, and mixed tasks.
An installed dependency fixture runs `pnpm install --offline` and builds its complete TypeScript project.
The Nuxt fixture installs pinned direct dependencies, then runs prepare, typecheck, and build.
Its `.nuxt` state exists before the treatment runs. Final checks regenerate it.
If offline packages are missing, setup becomes `Unavailable`. The attempt stays in totals.
A registered online install can prepare a new pilot revision. Preserve its lockfile in subsequent task snapshots.
Direct dependency pins alone cannot freeze transitive dependencies. Held-out projects must include their lockfiles.

Exact touched-file bytes are part of these scripted tasks.
Their source uses the CLI's single quote convention before registration.
For real tasks, preregister independent accepted outputs or an independently reviewed semantic contract.
Never change an oracle after seeing treatment output.
Unchanged files, comments, unrelated bindings, and non-source assets remain byte checked.
TypeScript references must resolve to the expected declaration. Matching text alone cannot pass.
Nuxt's separate whole-project typecheck grades generated auto-import bindings.

## Register a held-out study

Copy the generated JSON and replace the scripted commands with authorized external commands.
Each command is an argument array. The shell does not interpret it.
Available placeholders are `{project}`, `{promptFile}`, `{mode}`, and `{task}`.
The runner also receives `RIPIDE_EXPERIMENT_PROMPT_FILE` and `RIPIDE_EXPERIMENT_RECORD_DIRECTORY`.
Freeze complete Git commits, launcher files, Skill text, built exports, lockfiles, adapters, and runtime artifacts.
The manifest contains model, reasoning, repair budget, timeout, cache condition, and treatment instructions.
Version commands retain their complete output and exits.

Register `direct`, `forced`, and `hybrid` commands with the same model and reasoning.
Direct uses ordinary tools. Forced uses supported refactors. Hybrid chooses supported refactors when appropriate.
Keep mechanical, architecture, and mixed tasks in separate cohorts.
Use representative whole projects. Do not select tasks using observed treatment gains.
Include dependency installation and preparation commands in `setup`.
Include independent typechecks, full builds, behavior checks, and delivery commands in `checks`.
Mark each command's phase and controller or arm role.

Held-out registration requires repeats divisible by six and child tracing.
The seeded schedule counterbalances every mode in every position.
Execution remains serial. Host load remains observable, rather than assumed absent.
The reviewed pilot analysis hash must match a pinned artifact.
Each held-out task requires independent checks and a required common quality gate.
Model calls require explicit `--allow-model-calls`. This flag is operational authorization, not a claim of measurement validity.

## Quality gates

A quality command exits zero for pass, four for unavailable, and another nonzero code for failure.
Required unavailable gates prevent that attempt from passing.
Raw writer APIs do not imply protected verified-plan commit capability.
Current main has no protected-plan commit API. Its capability gate must report unavailable.
The exported `checkChangedVerifiedPlan` adapter distinguishes `Committed`, `ValidationRefused`, and `Unavailable`.
Unexpected infrastructure exceptions propagate. They cannot count as successful validation refusal.

Use isolated installed SDK consumers for protected-plan gates.
Register changed verified bytes, appended consumers, cross-engine plans, stale source, and dependency/configuration changes.
An adapter must classify actual validation refusal. A missing server or dependency cannot prove plan protection.
The archived architecture pair only reproduced changed verified-plan bytes.
Additional frozen-engine gates require those archived SDK capabilities and independently verified adapters.

## Usage and actual charges

The recorder preserves stdout and stderr before parsing.
It timestamps complete JSON output lines in `observed-events.jsonl`.
Provider timestamps take precedence over observation timestamps.
Codex `turn.completed`, native `token_usage_record`, and OpenCode `step_finish` events expose separate token categories.
Native response IDs deduplicate repeated usage records.
Cached input counts once. Reasoning exposed as an output subset counts once.
Missing reasoning detail stays explicitly unavailable. Zero in its numeric field means unobserved.
Missing completion timestamps or invalid cutoffs fail usage parsing.

Actual charges require optional receipt events:

```json
{ "type": "provider_charge", "timestamp": "2026-10-09T01:00:00Z", "receiptId": "provider-receipt-id", "currency": "USD", "amount": 0.25 }
```

Duplicate receipt IDs count once. Conflicting receipts fail parsing.
A provider's zero cost placeholder does not count as an actual receipt.
Without receipts, charges remain unavailable. Token reductions do not establish dollar savings.

External native usage can use registered `usageImports`.
Each import declares path, cutoff, role, phase, task, mode, repeat, and attempt.
Every imported file must have a pinned artifact hash.
Arm imports replace stdout accounting for that attempt. They cannot duplicate observed stdout totals.
Controller imports remain a separate resource category.
Keep response IDs unique across imported phase files. Preserve actual event timestamps.
Never estimate mechanical tokens from elapsed command time.
Mixed responses remain unattributed unless separate phase responses exist.

## Recording boundaries

The immutable manifest records `delivery-completed` as the endpoint.
Complete response usage includes every completed response through the runner's close timestamp.
Separate commit checks record their complete command close, streams, and exit.
Without a registered commit command, commit completion remains unavailable.
Publication counts only when a publication phase command is registered.
Prompts and repair steering are readable private files written before dispatch.
Additional steering can be archived with `steering --out DIRECTORY --text TEXT` before external delivery.
Do not send unrecorded interventions during a held-out task.

The external recorder uses Linux `strace`, GNU `time`, complete streams, and process-group timeouts.
Child fork, exec, wait, and exit records remain available for audit.
All arms receive equivalent tracing overhead.
Recorder CPU, controller commands, arm commands, memory, and sampled host load remain distinct.
Local cache conditions do not prove provider cache state. Provider cache priming remains unavailable.
Warm and cold conditions affect local `XDG_CACHE_HOME`. Uncontrolled uses the existing environment.

Reports retain every setup failure, timeout, refusal, failed attempt, and repair.
Summed resources include failed delivery. Workflow medians include repairs.
Setup and prepared-use resources appear separately.
Successful medians appear alongside all-workflow medians.
Task/workflow bootstrap intervals are descriptive. They do not repair selection bias or provider drift.

## Historical evidence

Run `evals/replay-historical.ts` with a private path map to replay all original raw attempt files.
The map contains batch name, published result path, raw directory, and matched-directory naming flag.
The replay checks saved tokens, seconds, quality, raw summary values, and transcript hashes.
Only sanitized metrics and hashes belong in public results.
Raw native transcripts and prompts stay private.

Read [historical benchmark limits](../../bench/README.md) before using any percentage.
Read the [maintained benchmark runbook](https://github.com/harlan-zw/ripide/blob/docs/recovery-skill-runbook/docs/benchmark-runbook.md) for rerun decisions.
A held-out repeated study with comparable quality must precede restored-gain advertising.
