# Benchmarks

## Local CLI benchmark

Run `pnpm build`, then `pnpm bench` from the repository root.
The [benchmark implementation](./bench.ts) measures operations on generated fixtures.
The [fixture generator](./fixture.ts) defines their source.
These local CLI timings exclude model calls and agent work.

For community demonstrations, use the [video runbook](../docs/video-runbook.md).

## Agent benchmarks

### Matched batch, 9 October 2026

Forty runs covered the same ten tasks with both models and both methods.
Five tasks renamed TypeScript symbols. Five migrated static Vue class tokens.
Each task supplied four fresh copies of identical captured source.
RipIDE completed **20/20** runs and their checks. Ordinary editing completed **19/20**.

| Runner and model | Completed pairs | Fewer total tokens | Less total time | Median token reduction | Median time reduction |
| --- | --- | --- | --- | --- | --- |
| Codex, GPT-6 Luna, medium reasoning | 9 | 60.4% | 15.4% | 58.7% | 47.8% |
| OpenCode, GLM 5.3 Flash | 10 | 73.9% | 55.4% | 71.2% | 56.3% |

Total reductions compare summed tokens and time within each model, using only completed pairs.
Medians give each completed task equal weight.
Two Luna RipIDE runs were slower: Harlanzw.com took 39.8 versus 17.6 seconds; NuxtSEO.com took 49.0 versus 24.2 seconds.
The OpenCode Mdream.dev baseline used 312,498 tokens and affects the total token reduction.
The Luna Unrouting baseline stopped after inspection, without edits or a successful check. Its pair is excluded.

**Method.** One run per task, method, and model; three projects ran concurrently.
Starting model alternated by task. Luna always ran RipIDE first; OpenCode always ran ordinary editing first.
Method order was not balanced within each model, so cache effects can bias timing.
Independent checks compared expected source edits and baseline TypeScript diagnostics.
Timing includes startup, model work, edits, and the requested check. Installation and Skill loading are excluded.
Only the RipIDE method received the Skill. Both runners executed without an OS sandbox in scratch copies.

**Resources.** All 40 attempts used 2,460,704 total tokens, including cached input counted once.
The batch took 8.7 minutes elapsed and 23.5 summed agent minutes. Dollar charges were not recorded.

**Limits.** One repeat cannot establish timing variance. Source slices omit installed dependencies and generated Nuxt state.
Full builds, auto-import refactors, moves, and import replacements remain unmeasured.
Matched tasks improve comparison, but tool stacks, caches, token accounting, and provider load still differ.
See [all 40 measurements and source hashes](../evals/results/2026-10-09-matched.json)
and [commands to reproduce the batch](../evals/README.md#second-batch-and-codex).

#### Every measured pair

| Project | Runner | RipIDE seconds | Agent seconds | RipIDE tokens | Agent tokens | Result |
| --- | --- | --- | --- | --- | --- | --- |
| unrouting | codex | 8.7 | 7.3 | 45,458 | 27,800 | Agent failed |
| unrouting | opencode | 26.0 | 76.9 | 22,467 | 78,489 | Both passed |
| c12 | codex | 10.4 | 19.9 | 45,529 | 92,147 | Both passed |
| c12 | opencode | 38.7 | 64.9 | 22,609 | 63,138 | Both passed |
| harlanzw.com | codex | 39.8 | 17.6 | 30,394 | 73,666 | Both passed |
| harlanzw.com | opencode | 27.4 | 80.4 | 22,449 | 95,375 | Both passed |
| nuxt-link-checker | codex | 9.6 | 19.2 | 45,482 | 87,396 | Both passed |
| nuxt-link-checker | opencode | 30.3 | 69.1 | 29,623 | 102,250 | Both passed |
| massivemonster.co | codex | 9.0 | 16.0 | 30,285 | 71,209 | Both passed |
| massivemonster.co | opencode | 45.1 | 57.6 | 39,772 | 51,256 | Both passed |
| mdream.dev | codex | 7.6 | 18.6 | 30,443 | 83,810 | Both passed |
| mdream.dev | opencode | 26.8 | 108.4 | 22,675 | 312,498 | Both passed |
| nuxt-seo-utils | codex | 10.7 | 17.8 | 30,381 | 122,654 | Both passed |
| nuxt-seo-utils | opencode | 33.6 | 69.0 | 30,506 | 86,967 | Both passed |
| nuxt-site-config | codex | 7.7 | 17.5 | 30,300 | 93,808 | Both passed |
| nuxt-site-config | opencode | 27.8 | 64.5 | 22,370 | 89,436 | Both passed |
| nuxtseo.com | codex | 49.0 | 24.2 | 30,468 | 105,147 | Both passed |
| nuxtseo.com | opencode | 40.5 | 93.1 | 16,923 | 71,736 | Both passed |
| unlighthouse.dev | codex | 7.6 | 28.1 | 45,676 | 76,097 | Both passed |
| unlighthouse.dev | opencode | 32.5 | 53.2 | 31,996 | 50,019 | Both passed |

### Split batch, 9 October 2026

Ten new repositories supplied five TypeScript symbol renames and five static Vue class migrations.
Each project ran once with RipIDE and once with ordinary editing tools, using the same assigned runner and model.
RipIDE completed **10/10** tasks and their checks. Ordinary editing completed **9/10**.

| Runner and model | Completed pairs | Fewer total tokens with RipIDE | Less time with RipIDE |
| --- | --- | --- | --- |
| Codex, GPT-6 Luna, medium reasoning | 4 | 59.9% | 60.5% |
| OpenCode, GLM 5.3 Flash | 5 | 45.3% | 35.0% |

Percentages compare summed tokens and time within each runner, excluding failed pairs.
Different project assignments and models prevent a direct Codex versus OpenCode speed comparison.

| Project | Runner | RipIDE time | Agent time | RipIDE tokens | Agent tokens |
| --- | --- | --- | --- | --- | --- |
| C12 | Codex | 8.3 s | 48.2 s | 30,284 | 74,264 |
| Harlanzw.com | Codex | 15.6 s | 39.7 s | 45,626 | 110,120 |
| Unrouting | Codex | 9.9 s | 39.8 s, failed | 45,460 | 123,119 |
| Mdream.dev | Codex | 12.7 s | 21.2 s | 30,382 | 97,626 |
| Nuxt Link Checker | Codex | 12.1 s | 14.1 s | 30,261 | 58,397 |
| Massive Monster | OpenCode | 35.9 s | 50.4 s | 30,485 | 51,817 |
| Nuxt SEO Utils | OpenCode | 30.7 s | 62.1 s | 30,958 | 75,577 |
| NuxtSEO.com | OpenCode | 24.1 s | 71.9 s | 22,618 | 60,446 |
| Nuxt Site Config | OpenCode | 41.7 s | 44.2 s | 24,668 | 52,721 |
| Unlighthouse.dev | OpenCode | 46.7 s | 47.3 s | 49,004 | 47,906 |

The Unrouting baseline added compatibility aliases and stopped after failed source checks. Its pair is excluded from the percentages.
Unlighthouse.dev used 2.3% more tokens with RipIDE after repeated searches. Gains are not universal.

**Method.** Codex 0.161.0, OpenCode 1.18.32, Node 24.18.0; fresh tracked source slices, containing 4 to 49 files.
Three projects ran concurrently. Each project's two methods ran sequentially, with the first method alternating.
Both runners received isolated configuration. Only the RipIDE arm received the Skill.
Both runners executed without an OS sandbox. Initial Codex sandbox setup failures are excluded from these measurements.
Independent checks compared expected edits and baseline TypeScript diagnostics.
Timing includes runner startup, model work, edits, and the requested check; installation and Skill loading are excluded.

**Limits.** One run per method per project; these slices omit installed dependencies and generated Nuxt state.
They do not measure full builds or Nuxt auto-import refactors. Provider and CPU load affect timing.
Total tokens include cached input, counted once. Dollar savings were not measured.
See the [recorded measurements and source commits](../evals/results/2026-10-09.json)
and [commands to reproduce the batch](../evals/README.md#second-batch-and-codex).

### First batch, 8 October 2026

On 8 October 2026, OpenCode refactored six project source slices with RipIDE or ordinary editing tools.
Across five completed pairs, RipIDE used **39.9% fewer total tokens** and took **40.5% less time**.
These percentages compare summed tokens and time across the completed pairs.

| Project | Task | RipIDE time | Agent time | RipIDE tokens | Agent tokens |
| --- | --- | --- | --- | --- | --- |
| Unimport | TypeScript symbol rename | 39.5 s | 43.7 s | 53,262 | 46,267 |
| Unhead | TypeScript symbol rename | 32.3 s | 61.4 s | 30,888 | 64,287 |
| Mdream | TypeScript symbol rename | 41.9 s | 89.8 s | 37,429 | 87,293 |
| Skilld | TypeScript symbol rename | 55.9 s | 71.7 s | 48,967 | 89,981 |
| Request Indexing | Static Vue class rename | 22.8 s | Timeout at 100 s | 30,979 | 63,072 |
| Forgd | Static Vue class rename | 26.3 s | 62.7 s | 30,596 | 47,034 |

RipIDE completed all six tasks and their requested checks. Ordinary editing completed five.
The Request Indexing baseline made the expected edits but timed out before completing its check.
Its pair is excluded from the aggregate comparison. Unimport used more tokens with RipIDE.

**Method.** OpenCode 1.18.32, GLM 5.3 Flash, Node 24.18.0; one run per method per project.
Each run used a fresh copy of tracked source from a recorded local commit.
The four TypeScript slices contained 10 to 110 files; each Vue slice contained 20 files.
The RipIDE prompt included the revised Skill. The baseline used ordinary editing tools.
Timing includes startup, model work, edits, and the requested source check; CLI installation and Skill loading are excluded.
Three projects ran concurrently, with each project's two methods run sequentially in alternating order.
Independent checks compared edits with expected source and rejected increases in baseline TypeScript diagnostics.

**Limits.** This small sample measures source slices, without installed project dependencies or generated Nuxt state.
It does not measure full builds or Nuxt auto-import refactors. Provider and CPU variation can affect timing.
Total tokens include cached input, so token savings do not imply the same cost savings.

See the [eval implementation and commands](https://github.com/harlan-zw/ripide/blob/58d5da54dd1384d5e0def97bf05a4959a962bd74/evals/README.md)
and [measurement evidence](https://github.com/harlan-zw/ripide/pull/42#issuecomment-6060408443).
