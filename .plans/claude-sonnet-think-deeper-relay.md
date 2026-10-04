# Plan: Fix local repository access for claude-sonnet-think-deeper

## Goal

Make `claude-sonnet-think-deeper` reliably use Pi's local file and terminal tools instead of replying that it cannot access the repository.

## Evidence so far

In one paired real-Pi read test, the existing `baseline` framing failed without a local tool call (0/1), while `relay` made local tool calls and passed (1/1). Separate `relay` read and edit tests also passed. This points to framing, but the sample is too small to establish reliability.

## 1. Protect existing work

- Check `git status` before editing.
- Preserve unrelated changes, including the current work in `packages/core/src/tools.test.ts`, `tsconfig.json`, and `.plan/`.
- Do not alter other models' framing defaults.

## 2. Repeat the controlled comparison

- Use the same built proxy, Pi configuration, model, tasks, and retry settings for both arms. Change only `M365_FRAMING_VARIANT`: `baseline` versus `relay`.
- Run read and edit tasks sequentially, with cooldowns between fresh conversations. Rotate arm order across repetitions.
- Record the sample size, Pi transcript, proxy finish reason, actual local tool calls, and filesystem verification for each run.
- Stop and mark results inconclusive if account throttling, Disengaged responses, or connectivity errors interfere.

## 3. Make the narrow fix if the evidence supports it

- Set `Claude_Sonnet_Reasoning` to default to `relay` in `packages/core/src/fenced.ts`.
- Keep `M365_FRAMING_VARIANT` and `M365_FRAMING_FILE` overrides working.
- Do not change `Claude_Sonnet`, GPT, or other tone defaults as part of this fix.

## 4. Add offline regression tests

- Assert that `defaultFramingForModel("claude-sonnet-think-deeper")` selects `relay`.
- Assert that its formatted tool prompt uses the relay-style instructions and does not wrap them in a forged `<system>` block.
- Assert that an explicit framing override still wins.

## 5. Verify through Pi

- Build and run the relevant unit tests.
- Run read, edit, and multistep tasks against the rebuilt proxy with no framing override.
- Inspect real local tool calls and verify resulting files; do not count a prose claim as success.
- [x] A fresh `scripts/pi-local.sh -p` session with usual context/extensions read the plan heading from the repository (1/1). Restart old conversations to avoid stale context.

## 6. Record the result

- Add the hypothesis, falsification criterion, run conditions, sample counts, and evidence paths to `docs/hypotheses.md`.
- Add a reproducible comparison recipe to `docs/experiments.md`.
- If repeated evidence is conclusive, update `docs/prompt-engineering.md`.
- If the comparison is inconclusive, leave the default unchanged and document what remains to test.
