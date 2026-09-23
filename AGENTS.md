# AGENTS.md

Guidance for AI agents (and humans) working in this repo.

## What this is

`m365-copilot-proxy` wraps Microsoft 365 Copilot's undocumented SignalR/WebSocket
API in an **OpenAI-compatible** interface so OpenAI-compatible coding agents (notably
[pi](https://pi.dev/)) can use it as a model backend.

**Read [`docs/m365-copilot-api.md`](docs/m365-copilot-api.md) before touching the
protocol code** — it documents every quirk of the M365 API (auth, SignalR frames,
tones, throttling, the "Disengaged" filter, Copilot Studio agents). It is the source
of truth; keep it in sync if you change protocol behaviour.

[`docs/hypotheses.md`](docs/hypotheses.md) is the open-questions notebook —
tool-call compliance experiments, the search for token/context-window data, the
"how do we improve this proxy" backlog. Update it whenever an experiment lands.

[`docs/prompt-engineering.md`](docs/prompt-engineering.md) is the distilled
reference for **prompting the Copilot model into tool-calling** — the load-bearing
levers, the confirmed dead-ends, and the A/B scoreboard. Read it before tinkering
with framing/format.

**Where findings graduate to.** `docs/hypotheses.md` is the *messy, in-progress*
layer. Once a finding is **decently conclusive** (real evidence, not n=1 noise),
promote it out of the notebook into the right reference doc so it isn't lost:
- **Protocol / API behaviour** (frames, auth, tones, throttling, Disengaged,
  agents) → [`docs/m365-copilot-api.md`](docs/m365-copilot-api.md).
- **Prompting / tool-calling strategy** (what framing/format makes the model act,
  what backfires) → [`docs/prompt-engineering.md`](docs/prompt-engineering.md).
Leave a one-line pointer + evidence reference behind in the notebook.

## Operating principles (read first)

Hard-won defaults for working on this proxy. Internalize these before touching anything.

1. **Always run sequentially — one thread at a time.** The rate limit is real but
   weird: it tracks *conversations/threads started per unit time*, not messages (F13),
   and it surfaces as `Disengaged`-looking 502s that are actually throttle. Never fire
   concurrent requests, and never loop fresh conversations back-to-back. Space experiment
   runs out (generous cooldowns between threads). A real pi/openclaw session — one long
   thread, many messages — is cheap; it's our *experiments* (a new thread per task) that
   burn the thread budget and trigger the throttle.

2. **Chase all hunches — tangents are encouraged.** This is an undocumented API we're
   reverse-engineering. The moment you think *"oh, maybe X works like this"* — stop and
   test it. A probe that teaches us something true about the system is often worth more
   than the task it interrupted. Don't suppress an idea because it's off the current
   thread. Record what you learn in [`docs/hypotheses.md`](docs/hypotheses.md).

3. **The end goal is always a usable agent in pi or openclaw.** Every change exists to make
   this proxy drop into pi/openclaw and actually drive a real coding loop. A clever protocol
   finding that doesn't move that needle is a footnote, not a win. Validate wins through a
   real harness, not only the bench.

4. **Be scientific: hypothesize → predict → test → conclude.** Turn every "I think X" into a
   falsifiable hypothesis with the cheapest probe that settles it. Don't ship on a plausible
   inference when the live API or the bench can decide it. Log it with sample size + an
   evidence pointer.

5. **Prompt tinkering: try N *wildly different* things at once, then let the data pick the
   direction.** Never iterate on the first idea — that's how you spin in loops re-trying
   variations of the same thing. Generate N genuinely distinct strategies (N = however many
   real ideas you have), A/B them all on the bench in **one** sweep, read the scorecard, and
   conclude a direction from the result. *Then* go deep on the winner.

**Things easy to forget (added during the June 24 framing-sweep):**

- **`Disengaged` is driven by jailbreak *shape*, not size (F10) — so a "stronger", more
  aggressive ALL-CAPS prompt can itself trip the filter.** When tinkering (#5), always
  include *leaner/softer* variants, not just heavier ones; the heavier prompt is often the
  one that disengages. Watch `usage.x_m365_dea_score` — M365's own disengagement-eligibility
  score — it rises *before* Disengaged fires (clean tool calls ~1e-8, prose ~1e-6,
  jailbreak-shaped ~1e-3).
- **n=1 is noise.** One SOLVED/Disengaged is a single sample on a stochastic,
  throttle-confounded backend. Confirm a winner with `--repeat`, and control for order
  effects (rotate strategy order across runs) before believing any number.
- **Native tool-calling is permanently OUT OF SCOPE.** MCP / a full Dataverse bot need a
  Copilot Studio license, which breaks the zero-cost premise (§8.11). Tangents (#2) are
  great — but don't re-open this one; it's a closed dead-end. Tool calling stays
  prompt-emulated.

## How we work — hypothesis-driven (default)

This is a reverse-engineering project against an undocumented API. **The default
mode is science: turn every "I think X" into a testable hypothesis, design the
cheapest probe that would confirm or kill it, run it, and record the result.**
Don't guess what works — measure it. Don't stop at a plausible inference when the
live API or the benchmark can settle it. Always be looking for the next testable
hypothesis that teaches us something.

- **Log every hypothesis in [`docs/hypotheses.md`](docs/hypotheses.md)** with a
  falsification criterion and a probe idea; update it when an experiment lands
  (confirmed / disproved, with sample size + evidence pointer).
- **[`docs/experiments.md`](docs/experiments.md) is the runnable catalog** — each
  experiment is a hypothesis + exact commands + how to read the result. Reach for
  it to *run* something; add to it when you design a new experiment.
- **Probes live in `scripts/`** — small, single-purpose, read-mostly. Reuse
  `scripts/_probe-chat.mjs` (one M365 turn in → structured result out; supports
  `optionsSets` / `extraAllowed` / `plugins` / `variants` / `tone` / agent
  overrides) and copy an existing probe rather than starting from scratch.
- **Quantify with the benchmark** — `scripts/bench/` (Terminal-Bench-style) scores
  real agentic coding tasks objectively, executing every tool call in a
  `--network none` Docker sandbox. To compare *any* lever (tool format, model/tone,
  prompt, optionsSets) run it with a `--label` and diff the scorecards in
  `scripts/bench/out/`. "Best" is a pass-rate number, not an opinion. See
  `scripts/bench/README.md`.
- Prefer empirical evidence — what the real first-party client sends/receives
  (capture it with Playwright), what the bench scores — over schema guesses.

## Layout (pnpm workspace, all TypeScript/ESM)

| Package | Role |
|---|---|
| `@m365-copilot/core` | auth (MSAL+Playwright), WebSocket client, sessions, agent mgmt, tool formatting, schemas |
| `@m365-copilot/proxy-lib` | OpenAI↔M365 translation: framework-free `createApp()` fetch handler, `SessionPool`, handler, tool-call parsing |
| `@m365-copilot/proxy` | standalone **Nitro** service / proxy binary (`m365-proxy`); file-based `routes/`, startup-auth `plugins/`, builds to `.output/` |
| `@m365-copilot/openclaw-plugin` | OpenClaw config generator + setup CLI |

`scripts/` holds RE probes + dev tools (`_probe-chat` helper, `proxy-verify`,
frame/optionsSets/tone probes, `gateway-*` captures) and **`scripts/bench/`** — the
quantitative benchmark. See the hypothesis-driven section above.

## Build & test

```sh
pnpm install
pnpm build          # tsdown, all packages (tests import from dist/, so build first)
pnpm test           # = test:unit; pure unit tests, NO auth/network
pnpm test:live      # M365_LIVE=1; live tests that hit real M365 (uses quota)
```

- ESM with `.js`-suffixed relative imports (tsdown/Node ESM). Keep that convention.
- Zod for boundary validation. No `console.log` in library code — use `createLogger`.
- `vitest run` skips live tests unless `M365_LIVE=1` (see `describe.skipIf`).

## Running against real M365 (important)

- **Run inside the Nix dev shell**: `nix develop --command bash -c '...'`. It provides
  `CHROMIUM_PATH` (a system Chromium); Playwright's bundled one is broken on NixOS.
- Auth uses `~/.config/opencode-m365/secrets.json` (email/password/mfaSecret) +
  `msal-cache.json`. **This data dir keeps the legacy `opencode-m365` name** — do not
  rename it or you orphan working credentials.
- Set `M365_DEBUG=1` to log to `~/.config/opencode-m365/debug.log`. There is **no
  interactive login** — auth is silent-refresh → automated (secrets.json) → fail loudly.
  A headless host / second PC never opens a browser tab or hangs on a paste-the-URL prompt.
- **Mind the quota**: ~600 messages **per conversation**, plus account-level throttling.
  Don't burn it on loops. A "rate limited / empty response" is often actually a
  `Disengaged` refusal (see the API doc), not throttling.

## Gotchas to know before you "fix" something

- **Tool calling needs the Copilot Studio agent AND the fenced/shell format.** The agent
  alone isn't enough — the old JSON `{"tool":...}` format scored 0/5 on real agentic tasks
  and was **removed**. Tools are now emitted as Markdown fences, and the load-bearing lever
  is **shell-routing**: M365's chat model won't act-as-agent but will write a ```` ```bash ````
  block, which the proxy routes to the harness's shell tool. That + the per-request shell
  framing (`formatFencedToolDefinitions`) is what produces real loops. See docs/hypotheses.md §9.
- **Prompt *framing* can't flip the turn-1 reflex; format/routing can.** 8 per-request
  behavioral-prompt variants moved nothing (0 tool calls); heavy anti-advise framing in the
  agent *backfired*. Don't try to wordsmith the model into acting — route its natural ```` ```bash ````.
- **The agent is versioned by an instructions hash.** Its name is
  `m365-tool-agent-<sha256(instructions)[:8]>`, so editing `getAgentInstructions()` auto-
  provisions a fresh agent on the next request. Stale versions are **always left in place**
  (we never delete agents), which avoids the multi-host footgun where a host on new code
  would delete the agent another host/PC is still using mid-conversation. A few orphaned
  lightweight bots are harmless. `updateBotInstructions()` is still dead code — we re-create
  rather than update in place. See API doc §10.
- **Reasoning tones don't work with the agent.** `gpt-5.x` / `*-think-deeper` route through
  the `DeepLeo` reasoning pipeline, which meta-analyzes the injected prompt instead of
  obeying it. Only the default `magic` and `*-quick` tones behave. The model can't be bound
  to our (declarative `minimalBots`) agent type at all — see API doc §10 *Agent types*.
- **M365 disengages on large tool payloads.** Keep injected toolsets lean. This is why
  pi works and heavy harnesses (opencode) don't. The proxy also enforces one tool call per
  turn and strips M365's invented `{confidence}`/`{final}` JSON (`M365_ALLOW_MULTI_TOOL` to opt out).
- **`claude-opus` is entitlement-gated and separately metered.** The WS `scenario` decides which
  models will serve: Opus is a dead route on `OfficeWebIncludedCopilot` and a real model on
  `OfficeWebPaidCopilot` (`getScenarioForTone`, derived per-turn from the resolved tone).
  `licenseType: Premium` pairs with it but unlocks nothing alone. Opus also has a small
  priority-access budget that **refuses in content, not in a status field** ("You've used your
  available priority access…"), so it reads as a successful turn — `parsePriorityAccessExhaustion`
  catches it and the proxy 429s. Resets midnight UTC (weekly: Monday). Don't burn it on sweeps.
  See docs/hypotheses.md §15.
- **Entitlement-gated ≠ metered.** `gpt-6-think-deeper` (`Gpt_6_Reasoning`) needs the same paid
  scenario as Opus but carries **no** priority-access budget and throttles like everything else,
  so `PAID_SCENARIO_TONES` is about reaching a model, not about what it costs. Don't key metering
  or framing decisions off that set — the quota detector reads the refusal text and the framing
  default is per-tone (Opus `minimal`, GPT-6 `baseline`). See docs/hypotheses.md §17.
- **Account degradation is THREAD-rate, not message-count** (docs/hypotheses.md §9 F13).
  Microsoft throttles *conversations started*, not messages sent — the per-conversation
  counter resets each thread. A bench that opens one fresh conversation per task burns the
  thread budget fast; a real pi session (one long thread, many messages) is fine. When
  everything starts empty-503-ing, it's thread-throttle, **not** the Disengaged content
  filter (check: no `messageType:"Disengaged"` → it's throttle). **A fresh login (move
  `msal-cache.json` aside, restart → new tokens) clears it.** Space experiment runs; don't
  loop new conversations.
- The `nativeclient` OAuth redirect bounces to `/common/wrongplace`; the auth code is
  scraped from the navigation request, not a settled URL.

## Verifying changes end-to-end

```sh
# proxy smoke + tool call + multiturn (run unsandboxed, inside nix develop):
nix develop --command bash -c 'M365_DEBUG=1 node scripts/proxy-verify.mjs --tools --multiturn --model=claude-sonnet'
```

`--tools` is load-bearing — without it no tools are sent and "NO TOOL CALL" is the
correct result, not a failure. Use a **Claude** model: those route agent-less,
which is the path that tool-calls (~5s). The `m365-copilot` default resolves to
the magic tone, which does not tool-call right now and confabulates "no
file-reading tool is available to me" — that is upstream's current state, not a
regression, so don't chase it (re-confirmed 2/2 on 2026-09-21; §9 F-route).

## Conventions

- Conventional Commits (`fix:`, `feat:`, `docs:`, `chore:`, `build:`). No `Co-Authored-By` lines.
- Small, focused files; handle errors explicitly; prefer immutable updates.
