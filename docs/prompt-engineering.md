# Prompt-engineering M365 Copilot into tool-calling

Distilled, **conclusive** findings on how to make M365 Copilot's chat-tuned model
emit usable tool calls — enough to drive a real agent loop in pi/openclaw. This is
the reference layer: the protocol lives in [`m365-copilot-api.md`](m365-copilot-api.md),
the messy in-progress experiments in [`hypotheses.md`](hypotheses.md). Promote things
here once they're settled with evidence (not n=1).

> **Methodology reminder** (see [`../AGENTS.md`](../AGENTS.md) → Operating principles):
> run sequentially (thread-rate throttle), try **N wildly different** strategies in
> one bench sweep rather than iterating on the first idea, and confirm winners with
> `--repeat` before believing a number. n=1 is noise.

## The cage theory (why this is hard)

Microsoft's server-side BizChat system prompt sits **above** ours in priority and
defines the model as a *retrieval chat assistant*. So instructions of the form
"be an agent / emit a tool call on demand" are refused or meta-analysed away — the
model decides to answer in prose or hallucinate a result **before** it would act.
We don't fight the cage; we use the one arm-hole it leaves open (see shell-routing).

## The load-bearing levers (confirmed)

These are what actually move compliance. In rough order of importance:

1. **The Copilot Studio agent (server-side system prompt).** Without it, M365 ignores
   the per-request tool instructions and answers in prose. It is *the* lever, not the
   syntax. ([api §10](m365-copilot-api.md), [hyp §1].)
2. **Shell-routing — the unlock.** The model won't "act as an agent" but **will**
   reflexively write a ```` ```bash ```` block. The proxy executes that block as the
   harness's shell tool (any name: `bash`/`run`/`run_command`/…). This is what turned
   the bench from **0/5 → real multi-turn loops** (a verified 9-tool-call fix-bug solve).
   ([hyp §9 F12].)
3. **Fenced format, not JSON.** Tools are emitted as Markdown code fences (info-string
   = tool name), not `{"tool":…}` JSON. JSON scored **0/5** on real agentic tasks; the
   multi-line-body escaping burden was a prime suspect. ([hyp §8.12, §9].)
4. **Anti-confabulation + first-move framing.** Explicitly telling the model it has run
   nothing yet, the files are real, and its FIRST output must be a ```` ```bash ```` block
   flips the stochastic turn-1 "I can't access the files, please paste them" reflex toward
   complying. ([hyp §9 F14].)
5. **Proxy-side hardening** (deterministic, behind the model): document guard
   (`isProseDocument` — don't execute a model's own markdown answer), confab retry,
   hallucinated-completion retry, tool-result labelling, one-call-per-turn, stripping
   invented `{confidence}`/`{final}` JSON. See [`tool-calling.md`](tool-calling.md).

## What does NOT work (confirmed dead-ends — don't re-litigate)

- **Wording-only per-request variants.** 8 behavioural-prompt rewrites (alone /
  env-is-real / first-move-forcing / batch-persona / verify-contract / terse /
  combined) each moved **nothing** (0 tool calls). Wording alone can't flip the turn-1
  reflex. ([hyp §9 "What did NOT work".]) → *the lever is format/routing, not adjectives.*
- **Heavy anti-advise framing baked into the AGENT** (server-side): **backfired**,
  suppressing even illustration-fence tool calls to 0. The agent prompt is now
  minimal/format-only; behavioural framing lives in the per-request `<tools>` block.
- **Context-seeding** (injecting a real `ls`/`cat` before the task): the model reads the
  primed info as "task complete" and says "Done" with 0 tools.
- **`tool_choice: "required"`** translated to a prompt rule: forces bogus `bash()` calls
  on pure-prose questions ("what is 7×8?"). Pass it through as advisory only. ([hyp F3].)
- **Reasoning tones + agent** (`*-think-deeper`, bare `gpt-5.x`, `DeepLeo`): the pipeline
  meta-reasons over the injected prompt instead of obeying it — it will critique your
  few-shot and reason itself *out* of tools. Use `magic` / `*-quick`. ([api §10].)
- **Native tool-calling (MCP / full Dataverse bot):** out of scope — needs a paid Copilot
  Studio license, breaking the zero-cost premise. ([hyp §8.11].)

## Constraints that bite while tinkering

- **`Disengaged` tracks jailbreak *shape*, not size** ([hyp F10]). A "stronger", more
  aggressive ALL-CAPS prompt can itself trip the filter — so a **leaner/softer** prompt
  can out-score a heavier one. Always include lean variants in a sweep. Watch
  `usage.x_m365_dea_score` (clean tool calls ~1e-8, prose ~1e-6, jailbreak-shaped ~1e-3);
  it rises before Disengaged fires.
- **Keep the toolset lean.** Heavy harnesses (opencode's ~15 tools) get empty Disengaged
  replies; pi's lean set works. ([api §9].) A heavy harness can often be *made* lean —
  but note that opencode's own config/hook levers do not affect the outgoing request, so
  the trim has to happen in the proxy. ([api §9, "Trimming a heavy harness"].)
- **Measure on *unfakeable* tasks.** The model hallucinates success on tasks it can answer
  from memory (fizzbuzz, count-lines) with 0 tool calls; only unfakeable tasks (fix-bug,
  find-needle, edit-config) force real calls. ([api §10 "measurement traps"].)
- **Bench ≠ pi.** The bench's short prompt is more compliant than pi's polished one; a
  bench win can still confab turn-1 under real pi. Confirm winners live. ([hyp F14].)

## The framing-variant registry (how to A/B strategies)

The per-request `<tools>` framing is the **live, no-reprovision lever**. Strategies are
registered in `packages/core/src/fenced.ts` (`FRAMING_VARIANTS`) and selected per-request:

- `M365_FRAMING_VARIANT=<name>` (env), or
- `M365_FRAMING_FILE=<path>` → first line of the file names the active variant, so **one
  long-lived proxy switches strategy per request** without a restart (used by the sweep).

Current strategies: `baseline` (shipped default, unchanged), `minimal`, `recency`,
`fewshot`, `proof_demand`, `persona`, `react`, `negative`, `terse`, and `reply_tool`
(synthetic `reply()` tool; also `M365_INJECT_REPLY_TOOL=1`).

**Run a sweep** (persistent proxy + control file; sequential, generously spaced):

```sh
# 1. one persistent proxy pointed at the control file
M365_FRAMING_FILE=/tmp/m365-framing M365_DEBUG=1 node packages/proxy/bin/m365-proxy.mjs 4141 &
# 2. sweep all strategies × discriminating tasks, rotated order, big cooldowns
COOLDOWN=45 BLOCK_COOLDOWN=60 bash scripts/bench/sweep2.sh
# 3. aggregate into a strategy × task matrix + leaderboard
node scripts/bench/analyze-sweep.mjs s2
```

## Results

### June 24 2026 — 10-strategy framing sweep — ⏳ IN PROGRESS

First head-to-head of all 10 strategies on the unfakeable tasks (`fix-bug`,
`find-needle`, `edit-config`), n=1, sequential with 45s/60s cooldowns. Scorecard
(strategy × task matrix + leaderboard) to be filled in from
`scripts/bench/analyze-sweep.mjs s2` once the run completes, then the winner
confirmed with `--repeat` and validated through real pi.

_Update this section with the matrix, the conclusion, and the chosen direction._
