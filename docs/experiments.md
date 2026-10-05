# Experiments — a runnable catalog

Reusable experiments for this project. Each is a **hypothesis + an exact way to
run it + how to read the result**. This is the "press go" layer; the messy
thinking lives in [`hypotheses.md`](hypotheses.md), confirmed facts in
[`m365-copilot-api.md`](m365-copilot-api.md).

> **Science discipline (see `AGENTS.md`):** change ONE variable, give it a
> `--label`, record the number. Don't trust small differences at `n=1` — use
> `--repeat`. **Run comparative experiments on a RESTED account** — degradation
> (api doc §7) makes `Disengaged` look like a format/prompt failure and poisons
> A/Bs. Pace requests; if `Disengaged`/empty spikes across *fresh* conversations,
> stop and wait ~15 min.

## Setup

```sh
pnpm build && pnpm run proxy 4141          # one shell; add env flags per experiment
# probes: M365_NO_INTERACTIVE=1 CHROMIUM_PATH=$(which chromium) node scripts/<probe>.mjs
# bench:  node scripts/bench/run.mjs --base-url http://localhost:4141/v1 --model <id> --label <name>
```

Bench scorecards land in `scripts/bench/out/<label>-<ts>.json` — diff them.

---

## A. Tool-call compliance — the headline problem (baseline: 0/5, §8.12)

The model prose-hallucinates instead of emitting tool JSON. Goal: any config that
gets a non-zero `SOLVED` / tool-call rate. **Always diff against the magic baseline.**

### E-C0 — Re-baseline (run first, on a rested account)
- **Why:** the `0/5` was measured while degraded; confirm it holds when fresh.
- **Run:** `node scripts/bench/run.mjs --model m365-copilot --label baseline --repeat 2`
- **Read:** `SOLVED %` + outcome mix. If still ~0 with few disengages → the prose
  failure is real (not throttle). If disengages vanish but prose stays → confirms
  the two failure modes are independent.
- **Cost:** ~25–50 msgs.

### E-C1 — Fenced format vs JSON  ✅ RESOLVED (JSON deleted)
- **Hypothesis (H4):** the model emits ` ```bash `/` ```edit ` blocks far more readily
  than `{"tool":...}` JSON. **Confirmed and then some** — fenced is now the *only* format;
  the JSON format was removed (it scored 0/5 on real agentic tasks). See E-C1b for the win.
- Format per tool: fence info-string = tool name, scalar args as `key: value` header lines,
  one free-form body arg as the fence body, an `old`/`new` pair as an aider-style
  `SEARCH/REPLACE` diff. Code: `packages/core/src/fenced.ts`, wired via `tools.ts`/`agent.ts`.
- **Known weakness:** a `write_file` body that itself contains a ` ``` ` fence can't be
  carried unambiguously — but in practice the model routes file writes through ```` ```bash ````
  heredocs (shell-routing), which sidesteps it.

### E-C1b — Shell-routing ⭐ THE WIN (June 14, hypotheses F12)
- **Result:** fenced format + the proxy's shell-first framing turns 0/5 into real
  multi-turn agent loops (verified 9-tool-call `fix-bug` solve on a NEUTRAL harness
  prompt). The model won't "be an agent" but will write ```bash; the proxy routes
  that block to the harness's shell tool (any name) and executes it. **Shipped as the
  default** (no env flag — fenced + shell-routing is the only path).
- **Run (winning config):**
  ```sh
  pnpm build && pnpm run proxy 4141   # fenced + shell framing are the default
  node scripts/bench/run.mjs --model m365-copilot --label tier1-neutral --tasks fix-bug,count-lines
  ```
- **New bench knobs (this session):** `--system <file>` / `BENCH_SEED=ls|cat`; prompt
  hypotheses live in `scripts/bench/prompts/p*.txt` (p0 neutral … p8/p9 bash-elicitation).
- **Read:** any multi-turn ```bash loop ending in a verifier pass. **Cost:** ~10 msgs
  but **2 threads** — mind F13 thread-throttle; keep runs small and spaced.
- **Caveat:** fakeable create-tasks (count-lines, fizzbuzz) still hallucinate; unfakeable
  ones (fix-bug, find-needle, edit-config) solve. See hypotheses §9 "Remaining gap".

### E-C2 — Task-type sensitivity
- **Hypothesis:** fakeable tasks (fizzbuzz, count-lines) hallucinate success;
  unfakeable tasks (find-needle, fix-bug, edit-config) disengage. Compliance
  depends on whether the model *can* fake an answer.
- **Run:** `--tasks fizzbuzz,count-lines --label fakeable` vs
  `--tasks find-needle,fix-bug,edit-config --label unfakeable`.
- **Read:** outcome mix per group. Confirms the §8.12 pattern; tells us whether
  "force a tool" framing should target fakeable tasks specifically.
- **Cost:** ~15 msgs.

### E-C3 — Anti-hallucination framing
- **Hypothesis:** a system/agent prompt that asserts the model has *no* prior
  knowledge of the sandbox ("the filesystem is unknown to you; you MUST inspect it;
  any claim about a file's contents without a tool_response is a hard error")
  lowers prose-hallucination.
- **Build:** variant of `getAgentInstructions` (or pass via the harness system
  prompt in `scripts/bench/run.mjs` `SYSTEM`).
- **Run:** bench A/B.  **Read:** SOLVED + prose-count delta.  **Cost:** ~25 msgs.

### E-C4 — `tool_choice` enforcement
- **Hypothesis:** sending `tool_choice:"required"` raises tool-call rate on
  actionable tasks (vs the false-bash foot-gun the docs found on prose questions —
  F3 — which the bench's tasks avoid, since all are actionable).
- **Run:** the bench always sends tools; add a flag to set `tool_choice` in the
  request, A/B.  **Read:** SOLVED delta.  **Cost:** ~25 msgs.

### E-C5 — Model comparison (agent path)
- **Hypothesis:** `gpt-5.5` (or another `*_Chat` tone) complies better than `magic` on the
  agent path. (Claude is **not** testable here — the agent forces GPT / disengages,
  §5; it's plain-chat only.)
- **Run:** `--model m365-copilot --label magic` vs `--model gpt-5.5 --label gpt55`
  vs `--model gpt-5.4-quick --label gpt54chat`. (Not `quick`: it now aliases `gpt-5.5`,
  so it would repeat the second arm — hypotheses §19.)
- **Read:** SOLVED per model.  **Cost:** ~25 msgs/model.

---

## B. Throttle / degradation (api doc §7)

### E-T1 — Characterise the throttle  (`scripts/throttle-probe.mjs`)
- **Hypothesis (H8.20):** account degradation is request-rate (RPM) driven with a
  recovery window — staying under some RPM avoids it.
- **Run:** `M365_NO_INTERACTIVE=1 CHROMIUM_PATH=$(which chromium) node scripts/throttle-probe.mjs --rpm 30 --max 25 --recover`
  Sweep `--rpm 10 / 30 / 60 / 120`.
- **Read:** request index where `Disengaged`/empty onset begins per RPM, and the
  recovery delay. Output → a safe client-side pacing config (requests/min the proxy
  should self-limit to).
- **Cost:** up to `--max` msgs/run (bursty by design).

### E-T2 — Is degradation grounding-path dependent?
- **Hypothesis (H8.8):** tenant-graph-grounded turns degrade sooner than ungrounded
  ones. (Pairs with E-O1's search toggle.)
- **Run:** throttle-probe with `plugins:[]` vs default Bing; compare onset.
- **Cost:** bursty.

### E-T3 — Does a fresh login clear throttle, or is it just idle time?  (`scripts/throttle-recovery-ab.mjs`)
- **Hypothesis (H-R1, §11):** re-auth does NOT clear thread-rate throttle (it's
  `oid`-keyed); F13's "fresh login recovered it" was confounded by ~4 min of rest.
  If true, auto-reauth is pure downside — it carries all the F25 login-fingerprint
  flag-risk for zero throttle benefit.
- **Run (needs a DEGRADED account):**
  `CHROMIUM_PATH=$(which chromium) node scripts/throttle-recovery-ab.mjs --rounds=12 --gap=45`
  Add `--induce=20` to force degradation first (burns ~20 threads). Within-episode
  two-token control: OLD (cache) vs NEW (fresh login), same `oid`, alternated probes.
- **Read:** the printed `verdict` — `H-R1_CONFIRMED_TOKEN_IRRELEVANT` (both recover
  together) vs `H-R1_REJECTED_TOKEN_IS_LEVER` (NEW recovers ≥2 rounds earlier).
- **Cost:** ~2 threads/round + one full login. Refuses to run on a rested account.

---

## C. License-free capability unlocks (optionsSets — §8.1)

All run with `scripts/_probe-chat.mjs` overrides; no license needed.

### E-O1 — Web-search toggle (H8.9)
- **Run:** a probe sending `plugins:[]` + `optionsSets:["nosearchall"]` vs default;
  same fresh-fact question.  **Read:** `InternalSearchQuery` frames + latency only
  in the search-on arm.  **Cost:** ~4 msgs.

### E-O2 — Memory / custom-instructions (H8.14)
- **Run:** `optionsSets:["add_custom_instructions","update_memory_plugin",
  "enable_inferred_memory_read"]`; turn 1 plant a code word, NEW conversation ask
  for it.  **Read:** recalled across conversations vs not.  **Cost:** ~3 msgs.

### E-O3 — Image input (H8.10)
- **Run:** POST a PNG to the substrate `UploadFile` endpoint (see PyRIT), attach
  `messageAnnotations`, ask "what's in this image?".  **Read:** pixel-level vision
  vs filename echo.  **Cost:** ~3 msgs.  **Needs:** the upload-flow probe.

### E-O4 — Code interpreter regression (already wired)
- **Run:** `node scripts/code-interpreter-probe.mjs` — SHA-256 oracle.
- **Read:** correct digest = real Python.  **Cost:** 1 msg. Use as a smoke test
  that the agent-less optionsSets path still works after changes.

---

## D. Limits / regression (confirmed once — re-run to catch M365 changes)

### E-L1 — Input ceiling / retrieval depth (F9/F10)
- **Run:** `node scripts/input-size-bisect.mjs` ; `code-interp-egress`-style needle
  tests.  **Read:** still ≥500k-token accept, dispersed-fact recall, benign size
  never disengages.  **Cost:** ~6 msgs.

### E-L2 — Output ceiling (F9)
- **Run:** essay word-target probe (output-ceiling-probe is integer-only; use an
  incompressible task).  **Read:** still wraps ~3k tokens.  **Cost:** ~2 msgs.

### E-L3 — Disengaged tool-count threshold (F6)
- **Hypothesis:** find the tool-count at which a *clean* (non-jailbreak) tool block
  disengages. Note: §8.12 showed tool *count* doesn't change the 0-compliance, but
  the disengage threshold is a separate axis.
- **Run:** `frame-dump-probe.mjs --many-tools` style, escalating tool count, watch
  `dea_violation` + `messageType`.  **Cost:** ~1 msg/step.

---

## E. Claude Sonnet 5 (paid scenario — §21)

### E-S1 — What gates Sonnet 5's own sandbox tools? (F36)
- **Hypothesis:** some client-side field turns `bash_tool`/`create_file` off. Falsified so far for
  optionsSets, plugins, variants and `allowedMessageTypes`; next candidates: `gptDefinitions`,
  `clientOverrides.capabilities`, a different `clientInfo.clientPlatform`.
- **Run:** `node scripts/sonnet5-native-tools-probe.mjs pwd-proxy,pwd-none,pwd-bare,pwd-noprogress`
  (add a cell per candidate). **Read:** `native tool calls: N` and whether the reply says
  `/home/claude`. **Cost:** 1 fresh thread per cell — needs a paid seat.

### E-S2 — Framing sweep for Sonnet 5 (F37, F43)
- **Done:** `relay_inline` (the relay note inside the first `<user>` block) is falsified: 1/20 vs
  relay's 9/10 in the same session (F43). The variant was removed; F43 gives its prompt layout.
- **Hypothesis under test next (H-opening):** Sonnet 5 settles provenance from how the real message
  opens. Needs two single-change variants registered in `fenced.ts`: (a) relay with the harness
  block moved first, note still untagged; (b) the `<user>`-tagged note + task first, harness block
  after. Predicted: (a) fails like relay_inline, (b) works like relay.
- **Run:** proxy with `M365_FRAMING_FILE`, then
  `ARMS="<a> default <b> <a>" TAG=s5c bash scripts/bench/sonnet5-sweep.sh`, alternating so each
  variant has a concurrent relay control.
  (`scripts/bench/phase-sweep.sh` now does the proxy and archiving too, and
  `scripts/bench/analyze-arms.mjs` reads the result back; see scripts/bench/README.md.)
  **Read:** SOLVED per arm, then `ChainOfThoughtSummary` frames in the archived
  `~/.config/m365-proxy/s5-sweep/<tag>-<n>-<arm>-frames` for *why* each miss refused.
  **Cost:** ~12 fresh threads per arm; ~190 threads in one day tripped `PerUserThrottled` (F40),
  so run at most ~8 arms per account per day.

---

## F. Agent-less dual-environment framing (hypotheses §23)

### E-D1 - Which framing keeps project work on the harness machine?

- **Hypothesis:** distinguishing the scratch sandbox from the user's project improves
  real local tool loops; `dual_env_sys` isolates the wrapper's effect on GPT.
- **Approval required:** the initial sweep starts 36 threads (6 arms x 3 tasks x 2
  rounds); confirmation starts 18 more, and the five-task pi suite starts 5. Runs are
  sequential with 5-second thread cooldowns (the requested sweep default); do not
  start them concurrently. Five seconds does not guarantee avoidance of account throttling.
- **Offline preview:** `bash scripts/bench/variant-sweep.sh --dry-run` and
  `bash scripts/pi-e2e.sh --dry-run` make no requests.

Build first, then start one persistent proxy on an available port (macOS: no Nix needed):

```sh
M365_DISABLE_AGENT=1 M365_FRAMING_FILE=/tmp/m365-framing M365_DEBUG=1 M365_DUMP_FRAMES=1 \
  M365_NO_CONFAB_RETRY=1 M365_NO_DISENGAGE_RETRY=1 \
  node packages/proxy/bin/m365-proxy.mjs 4199
```

The retry flags isolate framing performance and prevent extra Disengage-recovery threads.
From another terminal, after approval:

```sh
TAG=dual-env REPEAT=2 COOLDOWN=5 bash scripts/bench/variant-sweep.sh
node scripts/bench/analyze-sweep.mjs dual-env
```

The script rotates the first arm per round, sets the control file explicitly even for
baseline, and paces every task, not just arm boundaries. Scorecards include all repeats,
Disengaged errors and the maximum returned `x_m365_dea_score`. Check debug logs/frame dumps
for sandbox work and refusals; a returned score does not count hidden/retried refusals.
Confirm the measured top two by setting `ARMS` to their names, `REPEAT=3` and a fresh `TAG`.

Use a fresh tag per model/run. The analyzer separates models and accepts an optional
model argument (`node scripts/bench/analyze-sweep.mjs <tag> <model>`); rerunning the same
model/label keeps its latest file, not an independent repeat. Concurrent sweeps against
one framing control file change each other's per-turn prompts and invalidate arm labels.
Separate ports/control files prevent that interference, but still share the account quota.
On `m365_throttled`, respect `Retry-After`/`error.retry_after` rather than continuing at 5s.

Restart the proxy with its normal retry defaults, retaining `M365_DISABLE_AGENT=1` and
the framing control file. Set that file to the measured winner, then run:

```sh
MODEL=gpt-5.5-think-deeper COOLDOWN=5 bash scripts/pi-e2e.sh
```

**Read:** local verifier scores, not prose claims; beat the user-supplied 2/5 baseline,
target at least 4/5. `ONLY=edit,multistep` selects tasks, `PROXY_URL` defaults to
`http://localhost:4199/v1`, and `KEY` defaults to `sk-local`. Task directories and pi logs
are retained as evidence; the isolated pi configuration is removed on exit. Record the
sample size and evidence in hypotheses §23 before changing the provisional default.

## Adding an experiment

1. State the hypothesis + falsification criterion in `hypotheses.md`.
2. Add a runnable recipe here (commands + readout + cost).
3. Reuse `scripts/_probe-chat.mjs` (qualitative) or `scripts/bench/` (quantitative).
4. Record the result back in `hypotheses.md` with sample size + evidence pointer.

## E-N1 — Targeted new-model discovery (H24)

- **Hypothesis:** Luna, Astra, Sol 6.1, or a newer Sonnet route is live and serves the named model rather than a silent fallback.
- **Prerequisite:** `pnpm build`; use a rested, licensed account for paid-scenario conclusions.
- **Liveness:** `M365_NO_INTERACTIVE=1 node scripts/new-model-tone-probe.mjs --tones=Gpt_6_Luna,Gpt_6_Luna_Chat --cooldown-ms=300000` (replace `--tones` with selected candidates; both scenarios by default).
- **Identity:** repeat only LIVE tones with `--phase=self-id --tones=<comma-separated-live-tones>`. For Sonnet, use `--tones=Claude_Sonnet` and compare included with paid.
- **Read:** `scripts/new-model-tone-out/<timestamp>/results.json` and per-cell raw `.jsonl` frames. `DeepLeo` plus final `Success` is liveness, not model identity; `BotConnection` is not liveness. `InvalidCopilotLicense` is inconclusive for paid availability. Stop on `PerUserThrottled`; never run sweeps concurrently.
- **Cost:** one fresh conversation per tone/scenario cell, with the default five-minute cooldown between cells. Do not run the full candidate matrix until a small smoke sweep confirms the instrument.


## E-SR1 — Sonnet reasoning local-tool framing (H25)

**Hypothesis:** `relay`, unlike `baseline`, makes
`claude-sonnet-think-deeper` call Pi's local tools. Use the same built
standalone proxy and identical settings for both arms; change only the framing
variant. Run sequentially, rotating arm order on repeats. Wait **120 seconds
between fresh Pi conversations**, including across arms; do not run proxies'
requests concurrently.

```sh
pnpm build
M365_FRAMING_VARIANT=baseline M365_DISABLE_AGENT=1 M365_NO_CONFAB_RETRY=1 M365_NO_DISENGAGE_RETRY=1 node packages/proxy/bin/m365-proxy.mjs 4200
# In another terminal, start the same command with relay and port 4199.
MODEL=claude-sonnet-think-deeper PROXY_URL=http://localhost:4200/v1 ONLY=read COOLDOWN=120 bash scripts/pi-e2e.sh
sleep 120
MODEL=claude-sonnet-think-deeper PROXY_URL=http://localhost:4199/v1 ONLY=read COOLDOWN=120 bash scripts/pi-e2e.sh
```

Repeat with `ONLY=edit` and reversed arm order. `COOLDOWN` only spaces
tasks *within one invocation*, so the explicit sleep between invocations is
essential. Inspect each retained task directory's `.pi-out.txt`, verify the
local file/result, and compare proxy `finish=tool_calls` against `finish=stop`.
Stop on `PerUserThrottled`, Disengaged, or connection errors rather than
counting them as model failures. After changing the default, start a rebuilt
proxy **without** `M365_FRAMING_VARIANT` or `M365_FRAMING_FILE` and repeat
`ONLY=read`, `ONLY=edit`, and `ONLY=multistep` at 120-second intervals.
Results and limitations: hypotheses H25.


## E-SR2 — Go recursive folder-size task in real Pi

Run against a healthy local proxy built with the Sonnet reasoning relay default:

```sh
MODEL=claude-sonnet-think-deeper PROXY_URL=http://localhost:4201/v1 ONLY=go-du COOLDOWN=120 bash scripts/pi-e2e.sh
```

The task asks Pi to create and run a Go program in an isolated temporary directory,
measure the repository's `node_modules`, and report a summary. The verifier
builds and runs the generated source, checks a small fixture containing a
symbolic link, compares allocated bytes with `du -sk` (5% tolerance, minimum
2 MiB), and checks that Pi reported the measured number. It retains the task
directory and Pi output as evidence. Space separate invocations by 120 seconds;
`COOLDOWN` only spaces tasks within one invocation.

Initial live result: 1/1 PASS; generated program reported 348942336 allocated
bytes, matching `du` exactly. Evidence: the `go-du` task directory and
`.pi-out.txt` printed by `scripts/pi-e2e.sh`.
