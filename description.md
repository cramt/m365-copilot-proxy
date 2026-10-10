# Merge upstream main into PR #45 and preserve model-aware retry framing

## Purpose and review boundary

This branch brings the existing `async-m365` work for PR #45 up to `origin/main`, resolves the merge conflicts, and includes a subsequent review fix. It is intended as a reviewable integration branch, **not** as a claim that every change visible against `async-m365` was newly written here.

| Reference | Commit | Meaning |
|---|---|---|
| Existing PR branch before the merge | `48e93e7` | `async-m365`, also the first parent of the merge |
| Upstream main merged into the PR | `9e2d9f1` | Second parent of the merge |
| Conflict-resolution merge | `a1a1fd5` | Combines the two histories and resolves overlapping changes |
| Post-merge review fix | `93da594` | Preserves model tone in retry prompts and makes small test/lint clean-ups |

**How to interpret the diff:** Comparing this branch with `async-m365` shows 44 changed files, but that comparison includes upstream work brought in by the merge. In particular, the new model support, framing experiments, benchmark tooling, and extensive research notes should not all be attributed to this PR's conflict resolution. The merge's remerge diff identifies 26 files with resolution decisions; that does not mean all content in those files was authored during the resolution.

## Changes made while resolving the merge

The integration work reconciles the existing PR's proxy behaviour with upstream changes in model routing, framing, metering, logging, tests, and experiment tooling.

| Area | Files involved in conflict resolution | Resolution intent and review focus |
|---|---|---|
| Model routing | `packages/core/src/copilot.ts`, `packages/core/src/copilot.test.ts` | Retain the newer upstream distinctions between models sharing a tone, including Sonnet 5 versus Sonnet 5.5, while preserving the PR's compatible routing behaviour. Review scenario selection, agent attachment, and model-ID-specific decisions together rather than judging individual lines in isolation. |
| Tool framing and parsing | `packages/core/src/fenced.ts`, `packages/core/src/fenced.test.ts`, `packages/core/src/tools.test.ts` | Reconcile framing defaults and tool-call parsing with the PR's tool handling. Preserve support for fenced calls, model-specific sandbox wording, native closing-markup handling, and YAML-style array/object arguments. |
| Session and logging | `packages/core/src/session.ts`, `packages/core/src/log.ts`, `packages/core/src/log.test.ts` | Keep session frame assembly, throttling and metering behaviour alongside configurable logging and frame-dump paths. The selected configuration directory is `~/.config/m365-proxy`. |
| Request handling | `packages/proxy-lib/src/handler.ts`, `packages/proxy-lib/src/streaming.test.ts` | Combine framing selection and tool-name recovery with metering, latency, retry, and model-fallback handling. In particular, ensure a fallback reports the model that actually answered and rebuilds the request rather than treating it as a continuation of an empty response. |
| HTTP route tests | `packages/proxy/completions-route.test.ts` | Reconcile assertions with the merged completion behaviour. |
| Probe and benchmark scripts | `scripts/_probe-chat.mjs`, `scripts/agent-tone-probe.mjs`, `scripts/bench/_mock-proxy.mjs`, `scripts/bench/analyze-arms.mjs`, `scripts/bench/run.mjs`, `scripts/bench/sonnet5-sweep.sh`, `scripts/da-app/native-action-ws-probe.mjs`, `scripts/sonnet5-native-tools-probe.mjs`, `scripts/tone-probe.mjs` | Reconcile competing script versions without treating upstream experiment features as newly authored conflict-resolution work. |
| Dependency lockfile | `pnpm-lock.yaml` | Regenerate the lockfile for the combined dependency graph without bypassing supply-chain verification. |
| Overlapping documentation | `AGENTS.md`, `README.md`, `docs/hypotheses.md`, `docs/m365-copilot-api.md`, `docs/prompt-engineering.md` | Preserve compatible guidance and findings from both sides; avoid retaining contradictory descriptions of routing, framing, throttling, or the configuration directory. |

The table describes the **integration decisions**, not the origin of every line in each file. For a precise review of those decisions, inspect the merge commit as a remerge diff as well as the ordinary branch diff.

## Separate finding from the post-merge review

The review found two retry paths in `packages/proxy-lib/src/handler.ts` that rebuilt the prompt without passing the selected model's `tone` to `formatMessages`. That context matters because framing can include model-specific sandbox instructions. A retry or priority-access fallback could therefore use the right model while rebuilding its prompt with incomplete framing context.

| File | Change in `93da594` | Why it matters |
|---|---|---|
| `packages/proxy-lib/src/handler.ts` | Pass `{ tone }` when rebuilding the request for the agent-route retry. | Keeps the retry prompt aligned with the selected model's framing. |
| `packages/proxy-lib/src/handler.ts` | Pass `{ tone }` when rebuilding the request after priority-access fallback changes models. | Keeps fallback-specific sandbox wording and framing aligned with the model that will answer. |
| `packages/proxy-lib/src/streaming.test.ts` | Add assertions for the rebuilt prompts on both paths. | The new agent-route assertion failed before the handler fix and passed after it. |
| `packages/proxy-lib/src/streaming.test.ts` | Replace several unchecked response-JSON accesses with existing typed test helpers. | Clears ESLint's unsafe-access findings without changing production behaviour. |
| `packages/core/src/fenced.test.ts` | Use the existing typed JSON-object parser in two test helpers. | Clears unsafe parsing findings; this is test-only clean-up. |
| `scripts/bench/turn-budget.mjs` | Remove a redundant initial assignment. | Clears an ESLint finding; no intended change to pacing behaviour. |

The follow-up commit changes four files in total: 16 insertions and 13 deletions. The production fix is the two `{ tone }` additions; the remaining changes are regression coverage and lint clean-up.

## Changes visible in the branch that came from upstream main

These areas are important to understand when reviewing the *combined result*, but their appearance in the diff against `async-m365` does not mean the merge-resolution work invented them.

| Area | Examples visible in the combined branch | Attribution caveat |
|---|---|---|
| Model catalogue and routing | Opus 4.5/5.5, Sonnet 5/5.5, GPT-6.1 Sol, scenario and agent distinctions | Primarily upstream work integrated by the merge; conflict resolution reconciled overlaps. |
| Framing and tool parsing | `relay_batch`, shell-less fallback to `relay`, Opus native closers, YAML-style `edit` arguments | Primarily upstream features; the merge retained compatible behaviour. |
| Priority-access handling | Separate Opus and Sonnet 5.5 budgets, remaining-allowance reporting, optional fallback models | Upstream and existing PR behaviour had to be combined in the handler and related code. |
| Benchmark and probe tooling | Turn-budget pacing, arm analysis, model/tone probes, fallback probe, sweep changes | Much of the tooling arrived from upstream main. |
| Research and user guidance | Expanded `README.md`, protocol reference, prompting guidance, experiment notes | Most of the extensive new findings were already on upstream main. |
| OpenClaw plugin | `packages/openclaw-plugin/src/index.ts` and `packages/openclaw-plugin/src/index.test.ts` | Carried in from upstream main. The plugin directory is excluded from the sparse working tree; sparse checkout does not prevent Git from merging tracked paths. The merged `index.test.ts` blob matches the upstream parent exactly and was **not** a manually resolved conflict. |

## Documentation status

| File | Status in the combined branch |
|---|---|
| `AGENTS.md` | Reconciled project guidance, including model routing, framing, throttling, and tool parsing. |
| `README.md` | Includes the combined model catalogue, entitlement and metering distinctions, fallback configuration, framing guidance, and logging configuration. |
| `docs/experiments.md` | Includes updated experiment instructions. |
| `docs/hypotheses.md` | Includes extensive upstream evidence, outcomes, and remaining questions about models, framing, sandbox behaviour, and throttling. |
| `docs/m365-copilot-api.md` | Includes reconciled protocol and API findings. |
| `docs/prompt-engineering.md` | Includes reconciled prompting and tool-calling guidance. |
| `scripts/bench/README.md` | Includes updated benchmark guidance. |

**Documentation limitation:** The specific post-merge `{ tone }` retry regression and its fix are described in this PR description and covered by tests, but were **not** separately added to the repository documentation in `93da594`. The physical disconnected-run certificate investigation is also outside this branch's implementation scope.

## Validation performed

| Check | Result | Qualification |
|---|---|---|
| Build | Passed | Run after resolving the merge; the unit-test command rebuilt the packages. |
| Unit tests | 433 passed, 3 skipped | Final full unit run after the review edits passed. |
| Benchmark tests | 17 passed | Run with Vitest. An earlier attempt with `node --test` was not a valid result because these tests use Vitest. |
| Typecheck | Passed | Re-run after the test-helper typing clean-up. |
| ESLint | Passed | Re-run after the four-file review fix. |
| `git diff --check` | Passed | Checked after the review edits. |
| Lockfile verification | Passed | Supply-chain verification and frozen-lockfile check passed during merge resolution using the approved npm registry. |
| Live M365 verification of the `{ tone }` fix | Not performed | The retry regression was checked with scripted streaming tests, not a new live request. |

No claim is made here that every upstream model or experiment was revalidated live as part of this merge.

## Suggested review sequence

| Step | What to inspect | Question to answer |
|---|---|---|
| 1 | `93da594` on its own | Do both retry paths carry the selected model's tone, and do the assertions cover the prompt rebuilt after each retry? |
| 2 | `a1a1fd5` as a remerge diff | Were conflict resolutions limited to combining compatible PR and upstream behaviour, without dropping either side's required logic? |
| 3 | `packages/core/src/copilot.ts` and `packages/core/src/fenced.ts` | Do model ID, scenario, agent decision, and framing remain consistent, especially after a fallback changes models? |
| 4 | `packages/core/src/session.ts` and `packages/proxy-lib/src/handler.ts` | Are frame assembly, metering, throttling, retries, tool handling, and response metadata preserved together? |
| 5 | `packages/proxy-lib/src/streaming.test.ts` and the relevant core tests | Do tests exercise the integrated behaviour rather than only one parent's behaviour? |
| 6 | `pnpm-lock.yaml`, scripts, and documentation | Are dependency, experiment, and guidance changes consistent with the merged implementation? |
| 7 | `packages/openclaw-plugin/` only if reviewing the full branch diff | Recognise these as upstream-carried changes, not a sparse-checkout conflict we manually edited. |

## Out of scope

The earlier physical disconnected cluster run failed when `FullReleaseDownload` encountered `tls: failed to verify certificate: x509: certificate signed by unknown authority`. The simulation disconnected run downloaded the same release successfully. The logs reviewed did not establish the physical downloader's effective CA store, certificate chain, or proxy path. **This branch does not fix or diagnose that certificate-trust failure.**