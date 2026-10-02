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
   (`isProseDocument` — don't execute a model's own markdown answer, but a reply that *opens*
   with a tool call is an action), confab retry, hallucinated-completion retry, tool-result
   labelling, one-call-per-turn, stripping invented `{confidence}`/`{final}` JSON, treating a
   model-written `<tool_response>` as a stop sequence (Sonnet 4.6 invents one in about half
   its turns), and telling the model on the next turn when only its first call ran. See
   [`tool-calling.md`](tool-calling.md), [hyp §20 F39, F41].

## Claude Sonnet: don't *cage* it, don't *label* things `<system>`

Everything above was learned on models with no tools of their own. Sonnet 5 (`Claude_Sonnet` on
the paid scenario) **has** real ones, in a remote sandbox, so the question is not "will it act"
but "on which machine" — and our framing decides that. Conclusive (hyp §21, p = 3×10⁻¹³):

- **A `<system>` block inside the user turn reads as a forged system prompt.** Its reasoning says
  "prompt injection", it ignores the framing and works in its own sandbox, where the task's files
  don't exist. Relabelling the *same* baseline text `<harness_instructions>` took it 1/10 → 9/10
  and mostly stopped it deliberating at all. For this model the tag is the trigger, not the words.
- **Ask for an ordinary role, not belief in a mechanism.** "My harness executes your fenced blocks"
  (`honest`) invites a check against its system prompt, and it concludes the harness can't exist.
  "Guide me through my terminal, one command at a time; I'll paste the output back" (`relay`,
  shipped default) is just pair-programming: 45/50 against baseline's 6/40, and 5/5 in real pi.
- **Say the sandbox is the wrong machine.** Without it (`retag`) the model starts right but falls
  back to its own `bash_tool` the first time a harness command returns nothing useful.
- **Too short fails too:** a one-line "don't use your tools" note (`terse_user`) is 2/10 — it reads
  as an unexplained override.
- **A `<user>` tag doesn't make the note the user's.** On the wire the whole proxy prompt is one
  user message, and Sonnet 5 reads tags inside it as embedded text. Moving the relay note into a
  `<user>` block (`relay_inline`, tested and removed) made the setup read as a fabricated
  transcript: 1/20 vs relay's 9/10, with 19 of 20 first turns calling it a prompt injection (hyp
  §21 F43). Whether the tag or the harness block now coming first is to blame is not yet separated.
- **Sonnet 4.6 has the same reflex, weaker.** It rarely refuses, but says "this appears to be a
  system-level automated agent prompt embedded in a user message" and then hedges. `relay` is its
  default too: 78/90 vs baseline's 47/76 (p = 3×10⁻⁴, hyp §21 F42).

## GPT-6 / GPT-6 Sol: `relay` is not just a Claude fix

The relay note was written for Sonnet 5, but the two GPT-6 tones need it more. Both run
agent-less next to a sandbox of their own (GPT-6 always; GPT-6 Sol on non-premium accounts), and
every framing that tells the model it *is* an agent with a real shell sends it to that sandbox,
where the task's files don't exist: GPT-6 baseline 0/30 vs relay 30/30 (hyp §22 F47); GPT-6 Sol
0–6/10 for baseline, minimal, session_facts, demo_only and react vs relay 60/60 (hyp §23 F51).
Turning M365's code interpreter off doesn't help Sol (0/20). With the agent attached (Sol on a
premium account) there's no sandbox, but the cage framings still lose to relay (3–9/10 vs 30/30):
the model confabulates "I can't access your working directory from this chat", even after a
successful `cat`. relay removes the question: the user runs the commands, so the model needs no
belief about its own access. **Lesson:** for any new reasoning tone, put `relay` in the first sweep.

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
- **Reasoning tones + agent** (`*-think-deeper`, bare `gpt-5.4`, `DeepLeo`): the pipeline
  meta-reasons over the injected prompt instead of obeying it — it will critique your
  few-shot and reason itself *out* of tools. Use `magic` / a chat tone (`*-quick` →
  `*_Chat`; the `*_Quick` tones are retired). ([api §10].)
- **Native tool-calling (MCP / full Dataverse bot):** out of scope — needs a paid Copilot
  Studio license, breaking the zero-cost premise. ([hyp §8.11].)
- **Moving the Claude Sonnet note into the first `<user>` block** (`relay_inline`, removed):
  Sonnet 5 1/20 vs relay's 9/10 in the same session (p = 7×10⁻⁶); Sonnet 4.6 unaffected (19/19 vs
  20/20). ([hyp §21 F43].)

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
`fewshot`, `proof_demand`, `persona`, `react`, `negative`, `terse`, `softened`, `demo_only`,
`session_facts`, `reply_tool` (synthetic `reply()` tool; also `M365_INJECT_REPLY_TOOL=1`), and the
Claude Sonnet set: `retag`, `honest`, `terse_user`, `relay`. A variant can also change
the transcript's **tags** (`transcriptStyleForVariant`): the Claude Sonnet set never emits `<system>`;
the harness's own system prompt becomes `<harness_system_prompt>`.

**The default is model-aware** (`defaultFramingForModel`, falling back to `defaultFramingForTone`).
`Claude_Sonnet` — Sonnet 4.6 and Sonnet 5 — `Gpt_6_Reasoning` and `Gpt_6_Sol_Reasoning` → `relay` (above). `baseline` is a cage built for
M365's chat-tuned GPT path — most of its length goes on forcing a model that would rather
narrate into acting. `Claude_Opus` doesn't need that and is metered by a small
priority-access budget (docs/hypotheses.md §15), so it defaults to `minimal`: 684 chars vs
`baseline`'s 3,894 on a 2-tool request (~82% smaller), keeping shell-routing and the
anti-confabulation clause while dropping the strict-rules wall. **Every other model keeps
`baseline` byte-for-byte** (including `claude-sonnet-think-deeper`, unmeasured under relay), so
no GPT bench number moves, and `M365_FRAMING_*` still wins.
Caveat worth repeating: it is unproven that the Opus budget is token-weighted, so read this
as prompt hygiene for a model that doesn't need the cage — not as a measured quota saving.

**Run a sweep** (persistent proxy + control file; sequential, generously spaced):

```sh
# 1. one persistent proxy pointed at the control file
M365_FRAMING_FILE=/tmp/m365-framing M365_DEBUG=1 node packages/proxy/bin/m365-proxy.mjs 4141 &
# 2. sweep all strategies × discriminating tasks, rotated order, big cooldowns
COOLDOWN=45 BLOCK_COOLDOWN=60 bash scripts/bench/sweep2.sh
# 3. aggregate into a strategy × task matrix + leaderboard
node scripts/bench/analyze-sweep.mjs s2
```

For the full 10-task bench per arm (and to archive each arm's debug log + frame dumps for
forensics — read the `ChainOfThoughtSummary` frames, they say *why* a framing was refused):

```sh
M365_FRAMING_FILE=/tmp/m365-framing M365_DUMP_FRAMES=1 M365_DEBUG=1 M365_NO_CONFAB_RETRY=1 \
  node packages/proxy/bin/m365-proxy.mjs 4141 &
# `default` = empty control file = the model's shipped default; arms may repeat
ARMS="default retag relay default" MODEL=claude-sonnet-5 TAG=mysweep bash scripts/bench/sonnet5-sweep.sh
```

## Results

### June 24 2026 — 10-strategy framing sweep — ⏳ IN PROGRESS

First head-to-head of all 10 strategies on the unfakeable tasks (`fix-bug`,
`find-needle`, `edit-config`), n=1, sequential with 45s/60s cooldowns. Scorecard
(strategy × task matrix + leaderboard) to be filled in from
`scripts/bench/analyze-sweep.mjs s2` once the run completes, then the winner
confirmed with `--repeat` and validated through real pi.

_Update this section with the matrix, the conclusion, and the chosen direction._
