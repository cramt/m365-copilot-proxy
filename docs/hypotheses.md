# Reverse-engineering hypotheses & experiments

A live notebook of things we've **guessed**, things we've **tested**, and the
levers each one gives us. Update as we learn. The companion API doc
([`m365-copilot-api.md`](m365-copilot-api.md)) is for confirmed protocol
behaviour; this is the messy "we haven't shipped it yet" layer.

Status legend: 🟢 confirmed · 🟡 partially tested · 🔴 untested guess ·
⚫ disproved.

Findings should carry **n** (sample size), **service version under test**,
and **falsification criteria** wherever they're claiming something stronger
than "we eyeballed one run." See §M (Methods) for the experimental rig.

**Contents**

- §M — Methods (rig, raw-data pointers, caveats, falsification criteria)
- §0 — Headline findings (F1…F8) with confidence ratings
- §1 — Tool-call compliance hypotheses (most resolved June 9)
- §2 — Token-usage search (mostly disproved or low-confidence)
- §3 — "Context-window %" — what M365 actually enforces
- §4 — Frame surface area we haven't fully mined
- §5 — Disengaged-filter open questions
- §6 — Cost / metering open questions
- §7 — Probe backlog, ordered by info-gain ÷ cost
- §8 — Capability-expansion hypotheses (web-research dig: empty `optionsSets`, code interpreter, MCP actions, Claude tone, throttling levers, reference implementations)
- §11 — Detection / anti-flagging science run (July 7 2026 — auto-reauth is loud AND probably useless)
- §14 — Image generation (Aug 1 2026): SHIPPED. Works agent-less; the image IS the whole
  answer; artifact opens with the designerappservice token. `core generateImage()`, live-verified
- §13 — User-driven SSO auth for tenants with no automatable TOTP (July 29 2026,
  third-party): loopback redirect falsified, `nativeclient` corroborated by two forks
- §12 — Multi-agent research dig (July 13 2026) + framing A/Bs, and §12.13: tool-less
  requests silently execute in M365's sandbox and return a real (wrong-machine) transcript
- §15 — `scenario` is a model gate (Opus is real, not a dead tone) + its priority-access
  budget, and what that costs a proxy that prepends framing to every turn
- §20 — Claude bench forensics: proxy bugs found in the Sep 28 frame dumps (multi-message
  streams #29, self-written `<tool_response>` #31, the document guard #33, `Throttled` #35)
- §21 — Claude Sonnet 5 (paid scenario): its own sandbox, a `<system>`-tag injection defense,
  the `relay` framing (5/30 → 27/30; 5/5 in real pi); Sonnet 4.6 moved to relay as well (F42);
  moving the note into a `<user>` block (`relay_inline`, since removed) is falsified (F43)
- §22 — which tones the tool agent honours (`agent-tone-probe.mjs`): account-dependent for Claude,
  never for GPT-6 (agent-less + `relay`, #41); the paid scenario's `InvalidCopilotLicense` refusal
- §23 — GPT-6 Sol (#23): ungated, takes the agent only on a premium account (learned at runtime),
  has its own sandbox agent-less that no optionsSet removes, and `relay` wins on both paths
  (30/30 agent, 60/60 agent-less, 21/21 in real pi); a premium transient that mimics the dead route (F52)
- §24 — Claude Opus 4.5 (`claude-opus-4.5`): `Claude_Opus` on the included scenario, reachable only
  through the tool agent on a premium account; its system prompt says "Opus 5". The priority-access
  budget is on the wire (`OutOfCredits`, `throttling.metering`), counts turns, and the included scenario
  has none; both Opus models move onto the agent and `relay_batch` (the `<system>`-tagged framings
  trip the jailbreak classifier, F56; batching cuts turns ~40%, F60); the refusal isn't streamed and
  issue #18 (F59); Opus's native call markup leaking into fences (F57); four throttles in
  a day that a per-turn bucket fits better than a conversation count (F58)
- §25 — `relay` vs `relay_batch` for the other user-voice tones (Sonnet 4.6/5, GPT-6, GPT-6 Sol):
  batching saves ~33% of turns on the GPT-6 tones and ~15% on the Sonnets (F61); the F58 bucket
  predicts throttles on non-premium accounts too, and the bench can pace itself by it
  (`M365_AVOID_THROTTLING=1`)
- §26 — `Claude_Sonnet` @ paid is now Sonnet 5.5 and Sonnet 5 has its own tone, `Claude_Sonnet_5`
  (F64); Sonnet 5.5 has its own priority-access budget, 80/day and 150/week (F65), and Sonnet 5's
  `/home/claude` sandbox (F66); a `GPT61Sol*` budget with no tone we can find (H26a, resolved in §27);
  whether relay_batch would save Sonnet 5.5's budget (H26b, open)
- §27 — GPT-6.1 Sol (`Gpt_61_Sol_Reasoning`, `gpt-6.1-sol`): ungated on the included scenario, the
  agent only on a premium account (F68), the paid scenario spends the `GPT61Sol*` budget (F67), and
  only the user-voice framings work agent-less (F69); `relay_batch` is its default on both paths (F70);
  whether the included scenario serves the same model as the paid one (H27a, open)
- §28 — GPT-6 Sol, `relay` vs `relay_batch` again, with real pi: F61's sandbox gap was noise (15 → 13
  turns in 40 tasks; pooled 17 and 17), relay_batch passes on both paths and is its default now (F71)
- §29 — agent-less GPT-6.1 Sol vs GPT-6 Sol: the same solves and turns under every framing, but only
  GPT-6.1 Sol keeps out of its sandbox under the user-voice ones (relay_batch 0/40 tasks vs 6/20, honest
  3/40 vs 17/20); the included scenario's GPT-6.1 Sol isn't GPT-6 Sol renamed (F72, bears on H27a)
- §32 — one conversation, two backends (Oct 4 2026): each turn's new connection landed on a random
  backend, the regions kept separate copies of the conversation, and about half the turns ran on a
  partial history; `X-RoutingParameter-SessionKey` pins a conversation to one backend (F85)

---

---

## 15. `scenario` is a model gate — Opus is real, and it is metered

**Premise (user report, driving a live paid/premium seat).** `Claude_Opus` works, and works well,
through this proxy — but only when the WS connection is opened with
`scenario=OfficeWebPaidCopilot`. And driving it through the proxy exhausts its daily allowance
"very quickly", far faster than using the model by hand.

### F26 — `scenario` gates which models will serve; `licenseType` does not 🟢
**Claim.** The `scenario` query parameter is an entitlement selector that changes the served model
set. `Claude_Opus` returns M365's canned `BotConnection` apology under the default
`OfficeWebIncludedCopilot` and serves a real answer under `OfficeWebPaidCopilot`.
`licenseType=Premium` is the value the paid scenario travels with — **it does not grant access to
different models on its own**, so flipping it alone is not a lever.

**Which Opus.** The model served under this tone is **Claude Opus 5, knowledge cutoff May 2026** —
no longer 4.5, 4.6, or 4.8. Worth stating explicitly because the surrounding notes were written
while Opus looked dead and carried `claude-opus-4-*` strings inherited from client payloads; the
advertised alias is `claude-opus-5` and the fallback matches on `opus` alone, so no version
suffix is load-bearing.

**What this overturns.** F23's "Claude_Opus 0/3, dead end" and F24's "bare `claude-opus` still maps
to the dead tone". Both were measured on the included scenario. The *observations* stand; the
*conclusion* was scoped to a connection parameter nobody was varying — the classic shape of a
finding that holds one variable fixed without noticing it is a variable. §12.15's three-state tone
model needs a fourth entry alongside it: **entitlement-gated**, indistinguishable at the wire from
"registered but dead" unless you change scenario and re-probe.

**Confidence.** High that the scenario is the lever (deterministic: same tone, same account, two
scenarios, two outcomes). This is an **entitlement, not a bypass** — the seat must actually hold
paid/premium access; asking for the paid scenario on a seat that doesn't have it does not conjure
Opus. Untested on an unentitled seat, so we cannot say what that failure looks like.

**Shipped.** `getScenarioForTone()` (`copilot.ts`) → `PAID_SCENARIO_TONES`, applied per-turn in
`session.ts` from the resolved tone, so routing is automatic and no caller has to know the rule.
`M365_SCENARIO` / `M365_LICENSE_TYPE` override independently.

**Falsification / next.** (a) Probe the rest of the tone table under the paid scenario — if any
other tone changes state, the model list is entitlement-shaped more broadly than one model and the
table in api-doc §5 needs a scenario column, not a footnote. (b) Test whether the paid scenario
degrades anything on the included path (no reason to think so; unverified). (c) `scripts/tone-probe.mjs`
now runs scenario-paired cells and prints a `SCENARIO-SENSITIVE` line, which is the cheap way to
answer (a) in one sweep.

### F27 — Opus has a separate priority-access budget, and it refuses in *content* 🟢
**Claim.** Opus is metered by a "priority access" allowance unrelated to the ~600-message
per-conversation cap (§7) and to thread-rate throttle (F13). Exhaustion is reported as a **normal,
successful turn whose text is a refusal**:

> You've used your available priority access to the Opus model for today. You can choose another
> available model or wait until tomorrow to use the Opus model again.

> You've used your available priority access to the Opus model for the week. You can choose another
> available model or wait until Monday to use the Opus model again.

**Both reset at midnight UTC**; the weekly one on Monday.

**Why it matters more than the limit itself.** The failure wears a success's clothes. `hasContent`
is true, `messageType` is not `Disengaged`, throttle is not at-limit — so the empty-retry path, the
Disengaged fail-fast and the rate-limit check all pass it straight through, and an agent loop reads
"wait until tomorrow" as the model's answer to its task. This is the same hazard class as the
image-quota text (§14 H14.4) and the wrong-machine transcript (§12.13): **M365 says something true
in a channel where our code is looking for something else.** Recurring lesson — content-carrying
refusals need content-level detection; no status field will ever flag them.

**Shipped.** `parsePriorityAccessExhaustion()` (`priority-access.ts`, unit-tested incl. the
Monday-rollover and the "it is already Monday" edge) → proxy returns **429** with
`code: "priority_access_exhausted"` and `Retry-After` counted to the UTC reset, so a client backs
off to the refill instead of retrying into a wall. The streaming path needed its own guard
(`couldBePriorityAccessPrefix`): deltas are forwarded as they arrive, so without it the refusal
reaches the client *ahead of* the 429 that replaces it.

**Confidence.** High on the two wordings and the reset semantics (reported first-hand, verbatim).
Unknown: the actual allowance size, whether daily and weekly are independent counters or nested,
and whether it is per-account or per-tenant.

### H15.1 — Does the proxy's framing block burn the budget faster? 🟡 partially addressed, UNPROVEN

> **Settled (§24 F55, 2026-10-04): no.** The budget is per turn (`creditScenario: "TotalTurn"`; each
> Opus turn lowers `ClaudeOpusQuery75`/`ClaudeOpusQueryDaily` by exactly 1 whatever the prompt size).
> `minimal` saved nothing, and Opus now defaults to `relay` (§24 F56).
**Premise.** Opus exhausts "very quickly" through the proxy. The structural difference between
proxy use and hand use is that every agentic turn prepends a tool-framing block — `baseline` is
**3,894 chars for a 2-tool request**, and it exists to force M365's chat-tuned GPT path to *act*
rather than narrate. Opus does not need that cage: it acts from the tool schema alone.

**Shipped (cheap, defensible regardless).** `defaultFramingForTone()` puts Opus on `minimal`:
**684 chars, ~82% smaller**, keeping the two load-bearing levers (shell-routing + anti-confabulation)
and dropping the strict-rules wall. Every other tone keeps the bench-tuned `baseline`
byte-for-byte, so no existing reliability number moves. `M365_FRAMING_VARIANT` still wins.

**⚠️ The causal claim is NOT tested.** We do not know whether priority access is token-weighted or
counted per message. If it is per-message, this buys latency and prompt hygiene and *nothing* on
quota — the right default for a model that doesn't need the cage, but not a measured win. Writing
it up as "we cut Opus usage 82%" would be exactly the inference-from-plausibility this notebook
exists to prevent.

**Probe that would settle it (cheap, one variable, expensive only in budget):** run the same
fixed task to exhaustion twice on a rested day — once forced to `baseline`, once on `minimal` —
and count turns-to-refusal. Token-weighted ⇒ `minimal` survives materially more turns.
Per-message ⇒ identical counts. Until someone spends a day on that, treat H15.1 as open.

**Adjacent, untested:** Opus is a `Claude_*` tone, so it already runs agent-less (F23) and skips
the agent's server-side instructions entirely — the per-request block is the whole prompt overhead
there. Also unknown whether *output* tokens count toward the budget, which would make the
`*_Reasoning` tones (if Opus ever gets one) disproportionately expensive.

### Claude_Fable — accepted, answers, and is not Fable 🟡
In the real client's tone list (§12.6) next to `Claude_Sonnet`. Accepted here and returns content —
but self-IDs as **GPT-5**. So this is a *fourth* validator outcome: not live, not rejected, not the
BotConnection deflection, but **silently substituted** — a shape where "it replied" is maximally
misleading. Best reading: the Fable route is gated on the **Frontier program**, and an unentitled
account gets the house model rather than an error. Unlike Opus there is no known query parameter
that opens it; program membership is not a string we can send.

**Therefore deliberately NOT in `MODEL_TONES`.** Advertising `fable` would ship a model ID that
lies about which model answers — worse than not offering it. It lives in `scripts/tone-probe.mjs`
only, probed on both scenarios so the day it starts self-identifying as Fable is visible in a
routine sweep. **Falsify by:** a probe where `Claude_Fable` self-IDs as Fable — then map it.

## 11. July 7 2026 — flying under Microsoft's radar (auto-reauth detection science run)

**Premise (user).** The auto-reauth loop (`auth-recovery.ts` → `forceReauth`) may be
tripping Microsoft's abuse/identity-risk detection. Goal: characterise our detectable
surface and reduce it — on our OWN account, to avoid false-positive lockouts, not to
attack anyone.

Two detection systems key on us:
- **Entra ID Identity Protection** (the *auth* side) — scores every sign-in for risk
  (unfamiliar device/properties, atypical frequency, automation). This is where
  `forceReauth` lives, and it's the **high-risk** surface.
- **Substrate / BizChat abuse** (the *API* side) — client fingerprint + request cadence.
  Lower risk (we already reuse conversations, pace threads).

### F25 — Our headless login browser presents a textbook automation fingerprint 🟢
**Claim.** `runBrowserLogin()`'s Chromium config leaks the loudest possible "I am a bot"
signals to `login.microsoftonline.com`, which is one of the most aggressively
device-fingerprinted pages on the web (it feeds Identity Protection risk scoring).

**Evidence (n=1 config test, zero-network — `about:blank` eval of the EXACT `auth.ts`
launch opts; `scripts/`-style probe, not committed).** Config A = current
`{headless:true, args:["--no-sandbox","--disable-dev-shm-usage"]}`:
- `navigator.webdriver === true` — direct automation flag, read by AAD's fp JS.
- UA = `…HeadlessChrome/146.0.0.0…` — **the string "HeadlessChrome" is sent in the
  User-Agent header on every login request**, so we advertise "bot" even server-side,
  no JS needed.
- WebGL renderer = `SwiftShader` (software rasteriser) — classic headless/VM tell (no GPU).
- `navigator.userAgentData === null` — real Chrome exposes it; null is itself anomalous.
- Fresh context every login → **no persistent device cookie** (`ESTSAUTHPERSISTENT`), so
  every login looks like a brand-new unfamiliar device → "unfamiliar sign-in properties"
  fires *every time*.

**Naive-hardening trap (Config B tested too).** Just overriding UA→real Chrome +
`webdriver→undefined` + `--disable-blink-features=AutomationControlled` **removes the two
loudest tells but creates NEW contradictions**: UA now says "Windows Chrome 141" while
`navigator.platform` still says `Linux x86_64`, `userAgentData` still null, WebGL still
SwiftShader. Piecemeal string-spoofing yields an *incoherent* fingerprint, which is also
flaggable. **Lesson: don't try to out-spoof AAD's fingerprinter — avoid the login page.**

**Confidence.** High for the fingerprint facts (measured). The *mapping* from these tells
to an actual Entra risk detection is inferred, not yet read from Microsoft's logs (see H-R2).

### H-R1 — Re-auth does NOT clear throttle; any recovery is the idle time it forces 🟡→(near-confirmed)
**Claim.** The whole reason auto-reauth exists (F13: "fresh login clears degradation") is a
**confound**. Throttle is `oid`-keyed (API doc §2/§7, `token-regen-probe`: a regenerated
token carries the same `oid` → same throttle bucket). F13's recovery was explicitly
"n=1 and confounded with a ~4-min rest." So the login didn't clear anything — **the ~15 min
of login+restart wall-clock is just the idle gap that lets the account self-heal** (§7:
"self-heals with a lull").

**This contradiction already lives in the repo:** `auth-recovery.ts`/AGENTS.md say "fresh
login clears it"; API doc §2/§7 say "re-auth does NOT clear throttling." §2/§7 is the more
controlled finding. (Resolved 2026-10-04 in §2/§7's favour: `auth-recovery.ts` became the
degradation backoff, and AGENTS.md now says a fresh login does not clear the throttle. E-T3,
the probe that would settle it outright, still hasn't run on a degraded account.) If H-R1 holds, auto-reauth provides **zero** throttle benefit while
carrying **all** the F25 flag-risk — pure downside.

**Prediction.** On a degraded account, `forceReauth`→retry and (equal-wall-clock idle with
the SAME token)→retry recover at the **same** time; neither is faster.
**Probe (BUILT, validated — `scripts/throttle-recovery-ab.mjs`).** Within-episode two-token
control: hold token_OLD (cache) and token_NEW (fresh full login), both same `oid`; while
degraded, alternate `pong` probes between them on a fixed cadence and see which recovers
first. Both recover together ⇒ token-independent (H-R1 confirmed); NEW recovers ≥2 rounds
before OLD ⇒ token is the lever. Refuses to conclude on a rested account. Dry-run July 7:
plumbing works, account was rested (clean `pong`, throttle 1/600) → needs a degraded episode
(run opportunistically when degraded, or `--induce=N` to force it, which burns N threads).
**Falsification.** Fresh token returns clean `pong` while the same-moment OLD token still
empties ⇒ token really is the lever, keep reauth.

### H-R2 — The interactive re-login is the actual Entra-risk event; silent refresh is invisible 🔴
**Claim.** Silent MSAL refresh (refresh-token grant, no browser) generates a benign
"non-interactive" sign-in; the headless password+TOTP re-login generates an **interactive**
sign-in from an unfamiliar automated device → elevated risk. At the reauth cadence
(threshold 3 empties/120s, cooldown 300s) sustained degradation can fire **~12 full
password+TOTP logins/hour** — wildly atypical (real users: silent-refresh for days, a few
interactive logins/*day*).
**Cheap probe (zero quota, reads Microsoft's OWN verdict).** Check
`https://mysignins.microsoft.com` (or Entra sign-in logs) for the account: do the
`forceReauth` events show as interactive sign-ins flagged "unfamiliar/atypical", and has the
user-risk level risen? This is the single highest-info probe and touches no chat quota.
**Falsification.** Reauth logins appear as ordinary low-risk sign-ins with no risk
detections accruing ⇒ the auth surface isn't the problem, look at Substrate.

### H-R3 — A persistent browser profile makes the RARE login device-familiar (partly SSO) 🟢
**Claim.** `chromium.launchPersistentContext(userDataDir)` persists `ESTSAUTH*`/device
cookies, so a returning login is recognised as a *familiar device* → risk reduction.
**VALIDATED live (July 8 2026, two throwaway back-to-back logins, `scripts/`
login-validate).** Run 1 cold = full form (9.5s). Run 2 warm = AAD showed the **account
picker with the remembered account** (proof the device/session cookie persisted), clicked
the tile → **email step skipped** → password + MFA → auth code in **3.4s**; the resulting
token drove a real `pong` (throttle 1/600). So the profile IS recognised as a returning
device (the risk-lowering signal). *Partial:* password + TOTP are still re-entered — this
tenant doesn't have "remember MFA/device" enabled, so it's device-familiar but not fully
silent. Implemented in `auth.ts` (`launchPersistentContext` + `clickAccountTileIfPresent`
+ SSO-tolerant `driveAzureLogin`). **Note for the implementer:** after picking the tile you
MUST skip the email step — the page goes straight to "Enter password" and re-typing the
email matches a stale hidden `loginfmt` and derails the flow (cost 3 debug cycles).

### Ranked recommendations (design; not yet implemented)
1. **Stop discarding the refresh token / stop the loud path.** Don't `removeAccount()` in
   `forceReauth`; the token isn't the problem (H-R1). Prefer silent refresh always.
2. **Replace auto-reauth-on-empties with plain backoff/idle** — this is almost certainly
   what actually "recovered" F13, and it deletes the entire F25 flag surface. Two birds.
3. **If an interactive login is ever needed, use a persistent profile** (H-R3) so it's
   SSO-silent and device-consistent, and drop the headless tells (real headful Chrome under
   Xvfb, real profile) rather than string-spoofing (F25 Config-B trap).
4. **Make Substrate's WS fingerprint coherent** with the auth stack (today: WS advertises
   Firefox 148, auth is Chromium — mismatched). Lower priority than 1–3.
5. **Verify with H-R2 first** — read the sign-in logs before changing code, so we're
   treating the surface Microsoft actually flags, not a guessed one.

---

## 10. June 25 2026 — framing A/B sweep (rested account) + a benign task that always Disengages

Overnight A/B on the long-rested `ao@re-zip.com` account (≈2 weeks idle → **zero
thread-rate throttle all night**; every single ERROR was a content-filter Disengaged,
F13 not implicated even once). Persistent proxy, `magic` tone + declarative tool agent,
fenced shell-routing. Orchestrator `scripts/bench/overnight-sweep.sh` rotates BOTH
strategy and task order per round (controls the §M caveat-4 order effect AND the
task-position confound). Raw: `/tmp/m365-overnight.csv` + `scripts/bench/out/ov-*.json`.

### F24 — (July 7 2026) The `magic`/GPT path REGRESSED to 0 tool-calls; Claude-tone agent-less still works; model-string routing had a confab trap 🟡
**Trigger.** A live Claude Code session pointed at the proxy confabulated ("I can't access or
execute commands… paste the files") on an agentic ask — the classic turn-1 give-up, but the
confab-retry safety net never fired.
**Probe.** `route-probe` (scratchpad, n=2/cell, single-turn, one shell tool, 25s cooldowns,
service `0.2.0` running build, magic-agent + baseline framing as deployed):
| model string | resolved path | acted | latency | verdict |
|---|---|---|---|---|
| `m365-copilot` | magic tone + agent requested | **0/2** | ~49s | confabulate / prose ("no usable shell output") |
| `claude-sonnet` | `Claude_Sonnet` + agent-less | **2/2** | ~5s | tool_calls |
| `claude-opus-4-8[1m]` | magic (fallback) + agent SUPPRESSED | **0/2** | ~8s | "I don't have a functioning shell tool" |
**Findings.**
1. **The `magic`/GPT path is not tool-calling right now (0/2).** This is a REGRESSION vs F23's
   contemporaneous 8/8 for `m365-copilot` (June 25). Cause not isolated (couldn't read
   `compliantAgentName` — the proxy surfaces `contentOrigin` only, and per api-doc §237 `DeepLeo`
   shows on BOTH agent and agent-less paths, so the probe can't tell whether the agent attached or
   `getOrCreateAgent()` is returning null on the deployed service). Candidate causes: agent
   creation failing (missing PP/BAP scopes on the service's cached auth), a deleted-agent trap, or
   a genuine model-side drift. **Next:** surface `gptIdentifiers[].compliantAgentName` in `usage`
   so the agent-attach state is observable, and check the service's auth scopes / agent cache.
2. **Claude-tone agent-less is the reliable path (2/2, fast).** Consistent with F23; it did NOT
   regress. So the immediate operational answer is **use `claude-sonnet`, not `m365-copilot`.**
3. **Model-string routing bug (deterministic, fixed).** `claude-opus-4-8[1m]` (what a Claude Code
   client sends) hit the WORST quadrant: `getToneForModel` exact-matched nothing → fell back to
   `magic` (GPT), while `useToolAgent = /claude/i.test(model)` still stripped the agent → GPT-chat
   agent-less = guaranteed confab. The tone-resolution and agent-attach decisions disagreed.
**Shipped (this session, uncommitted):**
- `getToneForModel`: unmapped `claude-*` now → `Claude_Sonnet` (the working path) instead of the
  `magic` fallback. `getAvailableModels` still advertises only the exact keys.
- `handler`: `useToolAgent` now derives from the RESOLVED tone (`/^Claude_/`), not the raw model
  string — so agent-less ⟺ Claude tone. The two now can't disagree.
- `tools.ts` confab regex: `to?` (which forced a literal "t", so "can't access"/"can't inspect"
  slipped through) → `(?:to\s+)?`; added `execute|retrieve|fetch` to the verb list (the observed
  give-up phrasing). Was a second reason the safety net missed this failure.
**Confidence.** High on the routing/regex bugs (deterministic, unit-tested). ~~Medium~~ **LOW** on the
magic regression — see correction. **Falsify:** re-run `route-probe` on a rested account.

**⚠️ Correction (later same day, 2026-07-07) — the "magic regressed" claim does NOT hold.** A follow-up
tone sweep (`tone-sweep.mjs`, same rig) two hours later got `m365-copilot` **2/2 ACTED** — the exact
opposite of the 0/2 that seeded this finding. In the same sweep the *controls* also swung
(`claude-sonnet` 1/2, `gpt-5.5-think-deeper` 1/2), and `quick`/`Gpt_Quick` returned instant 502s
(dead tone or throttle-onset; §19: `Gpt_Quick` is now validator-rejected, which surfaces as exactly
this instant 502, so "dead" is the likelier reading). **Interpretation:** single-turn, back-to-back probes are dominated by
THREAD-RATE degradation (F13), not tone quality — ~16 fresh conversations were started across the two
runs, which is exactly what trips the throttle-that-looks-like-confab. So both the 0/2 and the 2/2 are
measuring the account's thread-rate state, not the `magic` tone. **The instrument is wrong for this
question:** ranking tones needs the multi-turn bench with rotated order + generous cooldowns on a
RESTED account (the F23 overnight methodology), because a real pi session is ONE long thread (cheap)
while our probes are many threads (self-throttling). Net: no evidence `magic` is specifically broken;
the deterministic routing/regex fixes stand on their own merits; the pi default (`gpt-5.5-think-deeper`)
rests on real-session experience, which is the more reliable signal here.
**Note (SUPERSEDED — see §15):** this read `Claude_Opus` as a dead agent-less tone (F23: 0/3,
`BotConnection` apology) and routed around it. The observation was right and the conclusion was
wrong: every one of those probes ran under `scenario=OfficeWebIncludedCopilot`, which does not
serve Opus. Under `OfficeWebPaidCopilot` the same tone answers normally. The tone was never dead —
our connection was never entitled. `claude-opus` now maps to `Claude_Opus` **and** carries the paid
scenario; unmapped `*opus*` strings route there too instead of being downgraded to Sonnet.

### F23 — CLAUDE-FOR-TOOLS works via agent-LESS shell-routing (overturns §8.9-8.11 "MCP-only") 🟢
**Claim.** Claude Sonnet 4.5 will drive a real agentic coding loop through the proxy **without the
declarative agent** — agent-less, the `Claude_Sonnet` tone routes to real Claude AND it emits tool
fences reliably, so shell-routing executes them. This means Claude+tools needs **no** Copilot-Studio
agent and **no** MCP/native-action path (§8.9 said "Claude usable for plain chat but NOT tools via
our agent"; §8.10-8.11 parked Claude+tools behind the license-gated MCP path — **both now wrong**).
**Why the agent blocked it:** the declarative agent (a) overrides the tone back to GPT-5 (H8.6) and
(b) adds jailbreak-shape signal. GPT-the-chat-model needs the agent to tool-call at all; Claude does
not — so dropping the agent for Claude is strictly better.
**Evidence (June 25):**
- Agent-less probe (`scripts/claude-tools-probe.mjs`, softened framing, n=4): `Claude_Sonnet`
  self-IDs "Claude Sonnet 4.5", emits a tool fence **4/4**, disengaged 0/4. Control `magic` (GPT-5)
  agent-less: tool fence **0/4** (narrates) — confirms GPT needs the agent, Claude doesn't.
- End-to-end bench, `--model claude-sonnet --tasks fix-bug --repeat 3`: **2/3 SOLVED** (4 & 6 tool
  calls/loop), 1 GAVE_UP_PROSE. The 1 miss is OURS not Claude's: Claude emitted a short preamble +
  TWO ```bash fences in one turn, which the prose-document guard / mixed-output path swallowed
  (tunable — Claude's style is "one sentence + multiple fences"; tune `isProseDocument` / one-call-
  per-turn for it). So the real Claude solve-rate is ≥2/3 and rising once the parser is tuned.
**Shipped (handler):** Claude models (`/claude/i`) now go **agent-less even with tools**
(`useToolAgent`); GPT/magic still get the agent. Force old behavior with `M365_FORCE_AGENT=1`.
**Why it matters (product):** a *stronger coding model* (Claude Sonnet 4.5) through the zero-cost
proxy, and the agent-less path **structurally avoids the whole Disengage/jailbreak-classifier mess**
(no agent instructions to scan) — F17/F22 mostly don't apply to the Claude path. Strong candidate
for the DEFAULT coding model.
**Confidence.** High that Claude tool-calls agent-less (4/4 probe + 2/3 end-to-end, real-Claude
self-ID). Medium on the solve-rate (small n; parser-tuning will raise it; single account/day, and
note the F22 temporal drift applies to disengage broadly).
**Falsification / next.** Tune the multi-fence parsing and re-run claude-sonnet on the full bench +
real pi (N≥5) vs gpt; if Claude ≥ GPT solve-rate, make claude-sonnet the default model. Check
one-tool-per-turn handling of Claude's multi-fence turns.

**Head-to-head verdict (June 25) — CONTEMPORANEOUS, fix-bug N=8 each, same window:**
| model | solve | avg tools/task | msgs | notes |
|---|---|---|---|---|
| `claude-sonnet` (agent-less) | **8/8 (100%)** | 5.3 | 50 | real Claude Sonnet 4.5; explores more |
| `m365-copilot` (GPT + agent) | **8/8 (100%)** | 2.4 | 27 | more token/quota-efficient |
**TIE on solve-rate** (fix-bug is easy → both ace it). My earlier "Claude 2/4, not ready" was
small-N bad luck — at N=8 it's flawless and the intermittent malformed-fence issue didn't even
surface (rare, non-blocking; `isProseDocument` already fixed for Claude's preamble style). The real
trade-offs: **GPT ≈2× more efficient** (2.4 vs 5.3 tool calls — matters for the 600-msg/conv quota);
**Claude is agent-less → structurally IMMUNE to the F17/F22 Disengage class** (the thing we fought all
day). **Other tones (agent-less, n=3):** `Claude_Sonnet` 3/3 tool-fence, `Claude_Sonnet_Reasoning`
**3/3** (reasoning-Claude tool-calls too — contradicts the old "reasoning tones meta-analyze" claim,
which was the agent/GPT path), `Claude_Opus` **0/3** (`origin=BotConnection`, apology — not routable
agent-less on this tenant; dead end).
**Decision:** keep GPT+agent as DEFAULT (efficient, proven); ship `claude-sonnet` as a first-class
alternative (agent-less, 100% on fix-bug, disengage-immune). NOT a slam-dunk to flip the default —
it's a genuine efficiency-vs-robustness trade. **To settle it:** compare on a HARDER/multi-file task
(fix-bug is too easy to differentiate) and a disengage-prone task (where Claude's agent-less path
should win outright). Malformed-fence parser hardening is now "nice-to-have," not blocking.

### F17 — The AGENT path Disengages on "replace literal value X→Y in a file" requests 🟢
**Claim (corrected — supersedes the wake-5 "task content" reading).** On the declarative-
agent + tool-framing path, a request shaped like *"the file contains X, change it to Y"* /
*"set the port to 8080 instead of 3000"* reliably trips the Disengaged filter — turn-1,
before any tool runs. It is NOT the config/port/json vocabulary, NOT the specific numbers,
and NOT file-writing in general. It is the **substitute-a-specific-literal-value-in-an-
existing-file request shape, on the agent path specifically**. The identical prompts in
plain chat (DeepLeo, no agent/tools) do NOT Disengage at all.
**Evidence (June 25, magic tone, `minimal` framing for the agent runs):**
- *Plain chat, no agent/tools (Phase A, n=2 each):* the exact "Edit config.json…port 8080
  instead of 3000" prompt and 5 reworded variants — **0/12 Disengaged**, dea_violation
  ~1e-9 (clean; fix-bug actually highest at 7e-9). `scripts/disengage-config-probe.mjs`.
- *Agent + framing path (Phases B/C, n=2 each):* DISENGAGE 2/2 for every "replace X→Y"
  variant — `edit-config` (config.json/port), `ec-bugfix` ("has a bug…port should be 8080,
  fix it"), `ec-notes` (settings.txt, no json), `ec-plain` ("value.txt contains 3000, change
  to 8080" — no config/port words), `ec-nonport` ("42 → 99" — non-port numbers). SOLVE 2/2
  for `ec-create` ("create greeting.txt with 'hello world'") and `fix-bug` ("find and fix
  the bug" — no literal substitution given). Earlier sweep: `edit-config` 15/15 Disengaged
  across all 10 framings; `fix-bug` 2/20; fizzbuzz/count-lines (create) ~9/10 solved.
  Tasks added to `scripts/bench/tasks.mjs` (ec-*). CSVs `/tmp/m365-f17{b,c}.csv`.
**Discriminator (what flips it):** the prompt names a specific existing value and a specific
replacement ("change X to Y" / "X should be Y, fix it"). Create-a-file and find-and-fix-the-
bug (where the fix isn't given as a literal) both pass. **Speculation:** the agent-path
classifier reads "replace this exact content with that exact content in a file" as a
file-tampering / injection shape; DeepLeo (plain chat) does not apply this.
**Why it matters / extends F10.** Disengage isn't only jailbreak *shape* (F10) or input
size (F10) — the **declarative-agent classifier is stricter than DeepLeo** and fires on a
benign *request shape* that plain chat accepts. New axis: routing path × request shape.
**Confidence.** High that the pattern is real and agent-specific (perfectly consistent
across wording/number variants n=2 each + 15/15 sweep; plain chat clean on identical text).
Medium on the exact boundary (small n; "literal substitution" is the best-fitting rule but
untested against e.g. "increment the value" / multi-line replaces).
**Falsification / next probes.** (a) Plain chat + the SAME framing block but no agent →
isolates agent-vs-framing (I only tested no-framing plain chat). (b) "double the value in
value.txt" (a transform, not a stated literal) — predict SOLVE. (c) multi-line literal
replace. **Live-agent implication (toward the goal):** real harnesses DO send "change X to
Y" asks. Candidate proxy mitigation: on Disengaged, auto-retry once rephrasing a literal-
substitution ask into a find-and-fix/transform framing (e.g. drop the explicit target), or
route such turns agent-less (DeepLeo tolerated them). Worth a controlled test before shipping.
**CONFIRMED bites real pi (June 25):** the exact "Edit config.json so the port is 8080…"
task through the actual `pi` agent Disengaged **3/3** (`pi-reliability.sh TASK=edit-config`);
pi surfaced the raw 502 and left the file unchanged — a hard user-facing failure, not a
bench artifact. **Mitigation feasibility hinges on an untested question:** does agent-less
(DeepLeo) + the fenced shell-routing framing still emit ```bash tool calls? Phase A proved
DeepLeo doesn't Disengage these prompts, but the agent has been the load-bearing tool-call
lever. NEXT: probe agent-less+framing on edit-config — if it (a) doesn't Disengage AND
(b) writes ```bash, then "on Disengaged, retry agent-less" is a viable proxy fix.

### F21 — The substitution-Disengage is driven by FRAMING WEIGHT; no clean auto-mitigation 🟡
**Refined mechanism (supersedes "agent-path" as sole cause).** The "replace literal X→Y"
Disengage scales with the **weight of file-manipulation framing**, and the declarative agent
stacks on top of it. Probe `scripts/disengage-agentless-probe.mjs`, edit-config task, magic tone:
| condition | Disengaged | emitted tool fence |
|---|---|---|
| plain chat, NO framing (Phase A) | 0/2 | n/a (not asked to tool-call) |
| agent-less (DeepLeo) + **minimal** framing | **0/3** | 1/3 (unreliable) |
| agent-less (DeepLeo) + **baseline** (heavy) framing | **4/4** | 0/4 |
| real proxy: agent + minimal framing (bench/pi) | **15/15 + 3/3** | — |
So heavy file-edit framing ("create/overwrite with heredocs, edit in place with sed -i") on a
literal-substitution task trips the filter even agent-less; the agent pushes even *minimal*
framing over the edge. Two independent contributors (framing weight, agent) stack.
**Mitigation verdict: no clean automatic fix (a real tension).** Reliable tool-calling needs
the agent (or heavy framing) — F12/F19 — but both of those are exactly what Disengage a
substitution task. The minimal-framing agent-less corner avoids the Disengage but tool-calls
only ~1/3. So "retry agent-less" would trade a clear 502 for a likely SILENT non-completion —
worse UX than the current fail-fast Disengaged error. **Recommendation: keep the fail-fast
error (already shipped); do NOT auto-retry agent-less.** The practical workaround is at the
request level: literal "change X→Y in <file>" top-level asks are the weak spot; "fix/implement"
asks that don't pre-state the exact replacement sail through (fix-bug 10/10, create 100%).
**Confidence.** Medium-high: the framing-weight gradient (0/3 minimal → 4/4 baseline agent-less)
is clean; the "no clean fix" follows from the agent-needed-for-tools tension (well-established).
**Probe caveat.** `oneTurn` did not actually attach the agent (control showed DeepLeo origin);
agent-path facts here rest on the bench/pi (valid). A real handler-level agent-less retry test
would confirm, but the tool-call-reliability tension already makes it not worth shipping.

**June 25 GUI capture — the agent IS the trigger; optionsSets are NOT the lever (decisive).**
Drove Microsoft's OWN M365 Copilot web client headless (`scripts/m365-gui-capture.mjs`,
Playwright+secrets login, captured the substrate Chathub WS frames) and gave it the exact
"edit config.json port 8080" task:
- The **GUI did NOT Disengage** — it just chatted ("here's the minimal precise patch…"). Confirms
  eyes-on that the substitution task itself is fine; our agent path is what Disengages.
- The GUI sends **`threadLevelGptId: {}` (NO agent)**, `tone: Magic`, `plugins:[BingWebSearch]`,
  and a RICH `optionsSets` (`update_memory_plugin`, `add_custom_instructions`, `cwc_code_interpreter*`,
  flux/image, …) + big `variants`/`allowedMessageTypes`. We send `optionsSets:[]` on the agent path.
- **Tested the obvious fix:** merged the GUI's optionsSets into our AGENT path (new env
  `M365_EXTRA_OPTIONSSETS`, session.ts) and re-ran edit-config → **still DISENGAGED 3/3**. So
  optionsSets do not rescue the agent path: **the `threadLevelGptId` agent attachment itself is the
  trigger** for a substitution task, independent of optionsSets/variants.
**Consequence — the fix path is narrowed to one option.** There is no "match the GUI's flags and
keep the agent" fix. To avoid the Disengage we MUST drop the agent (agent-less/DeepLeo never
Disengages these — Phase A + GUI). The whole problem therefore reduces to the open frontier:
**make agent-less shell-routing reliable** (agent-less currently emits ```bash only ~1/3 on minimal
framing, 0/4 on baseline-which-Disengages). Next experiment: sweep agent-less DeepLeo framings for
one that reliably elicits ```bash WITHOUT the heavy file-edit verbs that Disengage — if found,
"drop the agent for tools" fixes F17 and may also unlock Claude-for-tools (the agent forces GPT).

**June 25 in-GUI-context emulation — it's the PAYLOAD (agent), not our connection (airtight).**
`scripts/m365-gui-emulate.mjs`: logged into the real GUI, then from the PAGE opened a fresh WS to
the same Chathub endpoint reusing the GUI's own token + origin + query params, and sent OUR proxy
payload (threadLevelGptId=our agent + minimal shell framing + the "edit config.json port 8080"
task) — only the message payload differs from the GUI. Result: **DISENGAGED** (bot text = our prompt
echoed). So with the GUI's exact connection/token/headers/WS-params held constant, our payload still
Disengages → the trigger is conclusively the **agent attachment on a substitution task**, NOT our
proxy's token audience, headers, WS params, reconnect behavior, or optionsSets. (Also confirmed:
rapid reconnect/retry does not recover — edit-config Disengaged 26/26 across all attempts; the turn
ends with a clean type:3, so a reconnect just re-disengages. The GUI itself uses one WS, no reconnect
— it never Disengages because it sends no agent.) Fix path unchanged and now ironclad: agent-less
reliable shell-routing is the only way out.
**Bonus:** our agents (`m365-tool-agent-<hash>`, "Tool-Calling Coding Agent") appear as selectable
Agents in the real M365 GUI sidebar, and our proxy conversations show in the chat list (named
`<conversation_id>…` from our first-message tag) — the agent path can be exercised by hand in the GUI.

### F22 — The substitution-Disengage is Prompt-Shields JAILBREAK detection: an ADDITIVE shape threshold 🟢
**Claim (this corrects/supersedes the earlier F22 "naming the old value" reading AND the F17/F21
"it's the agent" reading — both were confounded).** The Disengage on benign edits is Microsoft's
**Azure AI Content Safety "Prompt Shields" (jailbreak / prompt-attack detection)** — a *shape-based,
additive, probabilistic* classifier that scores "instruction-override / command-imperative" patterns
and fires when the cumulative score crosses a threshold. No single token is "the trigger"; weak
signals SUM. `messageType:"Disengaged"`, `offense:"None"`, `contentOrigin:"Apology"` = the jailbreak
path (NOT the offensive-content `OffensiveRequestClassifier` path).

**Decisive evidence — interleaved A/B/C, n=5 each, same account state (controls for time/throttle):**
| prompt | outcome |
|---|---|
| **A** "Edit config.json so the port is 8080 **instead of 3000. Leave every other field unchanged.**" | **DISENGAGED 5/5** |
| **B** "Edit config.json so the port is 8080 instead of 3000." (replace-imperative ALONE) | TOOL_CALL 5/5 |
| **C** "Set the port in config.json to 8080. Leave every other field unchanged." (override-clause ALONE) | TOOL_CALL 5/5 |
So it is an **INTERACTION**: "replace X with Y" (command shape) + "leave every other field unchanged"
(= "ignore/disregard the rest", override shape) each sit *below* threshold; together they cross it.

**Why the earlier single-shot tests lied (the §-wide lesson — "quadruple-check").** My first wording
sweep (W1 refuse / W2–5 pass, n=1) confounded TWO co-varying clauses — W1 had *both* "instead of 3000"
AND "leave every other field unchanged"; W2–5 dropped *both*. I wrongly concluded "naming the old
value." The matrix probe (`scripts/disengage-matrix.sh`) then showed "instead of 3000" ALONE
tool-calls 2/2, breaking the confound; the interleaved A/B/C nailed the interaction. Classic additive
threshold: small wording deltas move you across it, so n=1 + uncontrolled wording = noise.

**Reconciles everything:**
- Plain chat + combo (the real GUI) → no agent override-signal → UNDER threshold → fine (Phase A, GUI capture).
- Agent + combo → agent's tool-descriptions/framing add baseline override-shape signal → OVER → Disengage.
  (So F17/F21 "the agent is the trigger" was half-right: the agent CONTRIBUTES signal, it isn't the sole cause.)
- Agent + single clause (B or C) → under → fine. Agent + both (A) → over → Disengage.
- fix-bug / ec-create / find-and-fix never Disengage: no override-shape clause.
- Research-confirmed: Prompt Shields is officially shape-based, **admits false positives**, runs on
  turn-1 AND on the agent's own instructions/tool descriptions (→ worse in agent/Studio contexts),
  and the "ignore/forget/disregard previous instructions/rules" category is exactly what
  "leave everything else unchanged" mimics. Sources in §10-refs below.

**NOT rate-limiting (but they can co-occur).** The interleaved A/B/C fire at identical request rate;
only A fails → content-shape, not rate. Throttle (F13) has a DIFFERENT signature: empty reply +
`ReferencesListComplete`, NO `Disengaged` frame. Open hypothesis worth a load-vs-disengage-rate test:
does degradation LOWER the Prompt-Shields threshold (borderline shapes disengage more under load)?
Unproven; the combo trips 5/5 on a zero-throttle account, so the shape-trigger stands alone.

**Fix options (the real solve — needs a decision):**
1. *Guidance / framing:* avoid override-shaped clauses in the per-request framing AND advise edits as
   "set/change X to TARGET" without an "ignore/leave-everything-else" meta-instruction. Also audit OUR
   agent instructions + tool descriptions for override-shaped text (research: that's a common culprit).
2. *Proxy rephrase-on-Disengage:* on a Disengage, retry once stripping override-shaped clauses
   ("leave/keep everything else…", "ignore the rest", "replace A with") in a FRESH conversation
   (a Disengaged conversation appears sticky — needs a new ConversationId). Low downside; some semantic risk.
3. *Lower content-moderation level* (Copilot Studio prompt setting Low/Moderate/High) — but jailbreak/
   prompt-injection defense is "always enforced, can't be disabled", so this won't fully fix it.
**Confidence.** High on the interaction + jailbreak-path mechanism (interleaved 5/5 split + official
docs). Medium on the exact additive weights (it's threshold-noisy; e.g. ec-plain "contains 3000,
change it" disengaged earlier but "replace 3000 with 8080" didn't — both replace-shaped, so wording
nuance + possible context modulation moves the score). Treat it as a fuzzy threshold, not a rule.
**Falsification.** A single override-clause (B or C shape) that Disengages alone on a rested account;
or the combo (A) tool-calling. Re-test if Microsoft retunes Prompt Shields.

**§10-refs (from the June 25 web dig — see also AGENTS.md):**
- Prompt Shields (jailbreak detection, shape-based, admits false positives): learn.microsoft.com/azure/ai-services/content-safety/concepts/jailbreak-detection
- Copilot Studio RAI: content evaluated twice (input+output), covers jailbreak/prompt-injection; surfaces as `ContentFiltered`: learn.microsoft.com/troubleshoot/power-platform/copilot-studio/generative-answers/agent-response-filtered-by-responsible-ai
- `Disengaged` WS protocol + `OffensiveRequestClassifier` (Zenity RE of the BizChat API): labs.zenity.io/p/access-copilot-m365-terminal
- Agent instructions/tool-descriptions tripping the filter (first-hand fix): iiu.dk/2025/09/18/copilot-studio-contentfiltered/
- Jailbreak false-positives on command/imperative shapes + sanitize "ignore/override/bypass", retry w/ backoff: learn.microsoft.com/answers/questions/2244789
- Always-enforced (can't disable) prompt-injection defense: learn.microsoft.com/microsoft-365/copilot/harmful-content-protection-copilot-chat
- NOTE: "DEA / dea_violation / disengagement-eligibility" has ZERO external corroboration — likely internal-only; our `x_m365_dea_score` naming is our own inference, keep that caveat.

**June 25 follow-up tangent — `dea_violation` does NOT gauge the disengage (hunch falsified) + softened mitigation rate:**
- Hoped `x_m365_dea_score` (the bot-message classifier score) would be a continuous dial predicting the disengage threshold. It is NOT: a Disengaged turn returns **`dea=none`** (the input-side Prompt-Shields gate fires before any output bot-message exists to score), and PASSING turns always read low (~1e-8–4e-8) regardless of how near they were to tipping. So our exposed `x_m365_dea_score` is the OUTPUT content score; the disengage is a SEPARATE input-side gate. They're both shape-driven (loosely correlated) but dea is unmeasurable at/after the threshold → useless as a predictive dial. Don't trust the `dea`-name as a disengage predictor.
- `dea` is **stable within a session** (~4.0e-8 clustered over n=12) but **shifts across sessions** (target-only 1.9e-8 vs 2+2 2.4e-9 earlier) → an account/session baseline component (matches the "feels state-dependent" theme).
- **⚠ BIG: the disengage rate DRIFTS over hours (large temporal/account-state component).** The
  exact combo + framing that Disengaged **26/26 (and 5/5 interleaved) in the morning** passed
  **0/6 under minimal AND 0/6 under baseline in the afternoon** — same prompt, same framing, same
  account, ~3h apart. So the substitution-Disengage is NOT a stable content-deterministic trigger:
  there's a strong account/service-state baseline that drifts, and the content-shape effect
  (softened < minimal/baseline, F22) is a real but *secondary modulation on top of it*. The
  morning A/Bs were valid **contemporaneous** snapshots (interleaved controls for state), but the
  baseline is unstable across hours — this is the "is it rate-limiting / state? could it be both?"
  question answered: **partly state, modulated by shape.** Implications: (a) normal pi usage hits
  it only INTERMITTENTLY (when the account is in a sensitive state); (b) the shipped
  Disengage→softened-retry (handler) is dormant insurance that activates then; (c) we could not
  live-verify that retry in the afternoon because nothing was disengaging — it's implemented +
  unit-safe but its live escape is verified only by the morning's softened-vs-minimal data.
  OPEN: what drives the drift? (time-of-day, cumulative load, token age, MS service-side tuning).
- **Softened mitigation RATE:** `softened` framing drops the worst-case combo ("X instead of Y. Leave every other field unchanged.") from ~100% disengage (minimal) to **~4%** (1 disengage across ~26 softened combo runs: titration 1/1 once, else 0/5 + 5/5 + 12/12 + pi 0/4). Strong but not perfect → the residual ~4% is the case for ALSO adding the rephrase/retry-on-Disengage (strip override-shaped clauses, fresh conversation). Normal phrasings: 0 disengage observed under softened.

### F18 — Framing shape modulates Disengage on a fragile task; aggressive framings backfire 🟡
**Claim.** On the solvable tasks (`fix-bug`, `find-needle`) the framing strategy clearly
affects the outcome, and the AGGRESSIVE/role-heavy framings Disengage MORE, not less. The
shipped `baseline` and the `fewshot` demo are best; `persona` is worst — it Disengages
even the easy `fix-bug`.
**Evidence (n=4–5 per strategy, solvable tasks only; still accumulating):**
| strategy | solve% (fix-bug+find-needle) | note |
|---|---|---|
| fewshot | 100% (5/5) | worked mini-transcript demo |
| baseline | 100% (4/4) | **the shipped default** |
| reply_tool | 75% (3/4) | baseline + synthetic reply() |
| terse / negative / minimal | 50% (2/4) | |
| recency / react | 40% (2/5) | |
| proof_demand | 20% (1/5) | heavy "EVIDENCE RULE" framing |
| persona | 0% (0/5) | "SHGEN, incapable of prose" — Disengages even fix-bug (0/2) |

On `fix-bug` alone everyone solves 2/2 EXCEPT persona (0/2) and proof_demand (1/2); the
spread is driven by the filter-fragile `find-needle`.
**Reading.** Consistent with F10: the more cage-fighting/role-heavy the prompt, the more
it trips the filter on an already-fragile task. **The shipped baseline is already
near-optimal — do NOT replace it with a "stronger" prompt.** `fewshot` is the only variant
matching it (marginal; small n).
**Confidence.** Medium on the extremes (persona worst, baseline/fewshot best are robust
across rounds); low on the middle order (n=4–5, find-needle is stochastic). Order rotated;
no throttle observed (so not a late-variant penalty).
**Falsification.** More rounds; if baseline/fewshot fall below the aggressive variants on
solvable tasks, revisit. Probe whether `fewshot` meaningfully beats `baseline` at higher n.

### F19 — the §8.12 fakeable-task hallucination is largely CLOSED (by framing, not the detector) 🟢
**Claim.** The §8.12 "remaining gap" — *fakeable* create-from-scratch tasks (fizzbuzz,
count-lines) hallucinate "created and executed it" with 0 tools (~0/5) — is now mostly
gone. On the rested account, fenced shell-routing makes the model emit a real ```bash
block on **turn 1** and actually write+run the file.
**Evidence.** Overnight sweep, fakeable tasks: **fizzbuzz 9/10 SOLVED** (only `persona`
Disengaged), **count-lines 3/3 SOLVED** (n growing). SOLVED ⟺ real in-sandbox execution
(the bench verifier runs the file). Crucially, almost every solve is **tools=1, msgs=2** —
i.e. the model acted on turn 1; there was no hallucination to catch.
**Mechanism — framing, with the detector as backstop.** The improvement is the shell-first
framing (F12/F14), not the hallucination detector: across the night the
`looksLikeHallucinatedCompletion` broadening (commit fc92498) fired **0×** (no occasion —
the model doesn't shortcut anymore), while the pre-existing **confab-retry fired 2× and
SALVAGED both** ("Confabulation detected → forcing retry → hasToolCalls=true"), validating
F16's confab-retry **live for the first time**. So: framing closed the gap; the detectors
are insurance that rarely triggers.
**Confidence.** High on the direction (fizzbuzz 9/10 is a large swing from ~0/5). Medium on
exact rates (count-lines n still growing; single account/tone).
**Falsification.** A fakeable task that hallucinates "done" with 0 tools AND the detector
fails to force a real call. Watch count-lines as n grows; re-test if framing changes.
**Caveat.** `persona` still Disengages even fizzbuzz — consistent with F18 (aggressive
framing backfires). The detector broadening (fc92498) remains correct unit-tested insurance
but is **unobserved live** precisely because the framing prevents the failure upstream.

### F20 — Real `pi` drives the proxy to fix a bug end-to-end: 10/10 (the goal, validated) 🟢
**Claim.** The ULTIMATE goal — a usable coding agent in pi backed by M365 Copilot — works
reliably, not just in the bench's hand-rolled loop. The actual `pi` coding agent (0.78.1,
headless `--print`) pointed at the local proxy fixes a real bug (calc.py `a-b`→`a+b`,
verified by `python3 check.py` printing OK) **10/10 independent runs**.
**Evidence.** `scripts/bench/pi-reliability.sh` N=10, per-run nonce → fresh M365 conversation
each run, real `pi` agent loop on the HOST (python3 from nixpkgs), proxy on :4141, `magic`
tone + agent + fenced shell-routing. **10/10 SOLVED, mean 107s** (range 64–162s). Zero
confabulation/disengage/throttle. CSV `/tmp/m365-pi-reliability.csv`. This answers F14's
"run fix-bug through pi ~10× to pin the comply-rate" — comply-rate = 100% on fix-bug.
**Confidence.** High for fix-bug end-to-end through real pi (10/10, independent convs, on a
rested account). This is the principle-#3 validation: a real harness, not only the bench.
**Caveats / boundaries.** (a) fix-bug is the *canonical reliable* task — 100% here does NOT
generalize to all tasks: F17 shows "change X→Y in a file" asks Disengage on the agent path,
and F18 shows aggressive framings hurt. The honest claim is "real pi reliably completes a
find-and-fix coding task," the core loop — not "every request succeeds." (b) Single account/
tone/day. (c) pi runs model commands on the host (benign task, temp dir).
**Next.** Test real pi on (i) a "change X→Y" task (does F17's agent-Disengage actually bite
pi usage?), (ii) a multi-file/harder task, (iii) under pi's own system prompt vs the bench's.
**Generality (June 25, follow-up):** a HARDER multi-file task (bug in `mathutil.py` caught by
`test.py`, requires read→run→reason→fix across files, NO literal substitution given) through
real pi = **3/4 SOLVED** (mean 77s). The 1 failure was a **hallucinated completion**: the model
printed "OK" and offered to explain the test while `mathutil.py` stayed unfixed — the residual
hallucination tail on harder tasks (its "OK" phrasing had no past-tense mutation claim, so
`looksLikeHallucinatedCompletion` didn't catch it). So F20 generalizes beyond the single
canonical task (the loop investigates multiple files and fixes real logic bugs), but harder/
multi-step tasks carry a ~10-25% hallucinated-success tail (n small) that the framing+detectors
don't fully close — the honest ceiling of the prompt-emulated path. (i) is F17/F21; (iii) untested.

---

## 9. June 14 2026 — agentic tool-use SOLVED via shell-routing (bench 0/5 → real multi-turn loops)

The headline §8.12 problem (0/5, model narrates instead of acting) is **broken open**.
Service version unrecorded this session (capture next run); single tenant `ao@re-zip.com`,
`magic` tone, fenced format. All bench runs in `scripts/bench/out/`, full trace in
`~/.config/opencode-m365/debug.log`, frames in `~/.config/opencode-m365/frames/`.

### F12 — Shell-routing is the unlock: model writes ```bash, proxy executes it 🟢

**Claim.** M365's chat-tuned model will **not** "act as an agent" (emit a structured
tool call on demand) but **will** reflexively write a ```bash block when asked to "do
the task by writing shell commands." Routing that block to the harness's shell tool
turns prose-narration into real, converging agent loops.

**Evidence.** Bench, fenced format:
| config | result | note |
|---|---|---|
| JSON (default), neutral prompt | **0/5** | reproduced §8.12 baseline |
| fenced + bench p8 "write bash" prompt | **2/5** (fix-bug, find-needle) | first real solves ever |
| fenced + p9 heredoc prompt | **1/5** (edit-config) | different task, same mechanism |
| fenced + **Tier-1 proxy framing**, NEUTRAL prompt | **fix-bug SOLVED, 9 tool calls / 10 msgs / 116s** | the loop is the proof |

The 9-turn fix-bug loop (`tier1-neutral`, raw frames captured): model wrote
`cat > /work/calc.py <<'EOF' … return a + b … EOF`, verified with `python3 -c`, re-ran
`check.py`, iterated to a green `OK`. The bench's objective verifier confirmed it.

**Mechanism.** The model often *still narrates* ("I'm unable to access the files…") **while
simultaneously emitting a ```bash block**. The fenced parser executes the block, the real
output grounds the next turn, the handler strips the prose — and it converges. The prose
disclaimer is harmless noise; the executed bash is what matters.

**Why it works (the cage theory).** Microsoft's server-side BizChat prompt sits *above*
ours in priority and defines the model as a retrieval chat assistant — so "be an agent"
(§8 prompt variants, all inert) is refused, but "write the shell command a user would run"
is *encouraged* behaviour. We stopped fighting the cage and used the one arm-hole it leaves
open. **Fragile/adversarial** — a DeepLeo framing change could close it.

**Shipped (Tier 1, `packages/core/src/fenced.ts`).** When the harness exposes a shell-like
tool (`bash`/`sh`/`shell`/`run`/`run_command`/… — pi, opencode, hermes, openclaw all do),
the proxy (a) injects shell-first framing into its own `<tools>` block ("do the whole step
by writing ONE ```bash block: heredocs to create, sed to edit, python3 to run"), and
(b) **aliases** ```bash/```sh/```shell to that tool whatever it's named, so the model's
reflexive ```bash maps to e.g. `run_command`. Harness-agnostic: real clients inherit it
with **no special prompt** (proven by the neutral-prompt 9-turn solve). Unit-tested.

**Confidence.** High that the mechanism produces real loops (a verified 9-turn solve + ~4
independent solves across prompts/runs). Medium on the rate (1–2/5, throttle-confounded; see
F13). The exact SOLVED task varies with prompt/account state; the *mechanism* is stable.

**Falsification.** Re-run `tier1-neutral` on a rested account: if fix-bug stops producing a
multi-turn ```bash loop, or JSON ever matches fenced on SOLVED, F12 weakens.

### F13 — Account degradation is THREAD-rate, not message-count; fresh login clears it 🟡

> **Superseded in part (§11 H-R1):** the "fresh login clears it" half was n=1 and confounded with
> a rest; the regenerated token keeps the same `oid`, i.e. the same throttle bucket (API doc §2/§7).
> Treat the throttle as lifting with idle time, not with a login. The thread-rate half stands.

> **Update (Sep 28 2026, #35):** it is not silent. A throttled turn's final `type:2` item says
> `result.value: "Throttled"`, `errorCode: "PerUserThrottled"`; the proxy now 429s on it.

**Claim.** The "everything 502s / Disengages" degradation tracks **conversations (threads)
started**, not messages sent, and **re-authenticating (new MSAL tokens) restores function**.

**Evidence.**
- Throttle counter `numUserMessagesInConversation` **resets per conversation** (each bench
  task uses a nonce → fresh thread → counter back to 1). The 600-cap was never the limiter.
- The bench starts **one thread per task**; ~15 runs × 5 tasks ≈ **75 threads in ~35 min** →
  degradation onset. The degraded-era 502s carried `messageType:"ReferencesListComplete"`,
  `offense:"None"` — **no `Disengaged`** — i.e. **empty-response throttle**, not the content
  filter. (Earlier "disengage" reads were probably throttle all along.)
- Timeline: 17:20 p8 → 2/5; 17:28 p8 (same prompt) → 0/5, fix-bug/find-needle now 502.
  **Then logged out (moved `msal-cache.json` aside) + fresh Playwright/TOTP login** →
  immediately fix-bug SOLVED with a clean 9-turn loop. The two failing multi-request tasks
  recovered the moment the session got fresh tokens.

**Confidence.** Medium — re-login recovery is n=1 and confounded with a ~4-min rest, but the
magnitude (constant 502 → 9 successful turns) points to the token/session, and matches the
user-reported "Microsoft counts threads, not messages."

**Falsification.** Drive a single long thread to hundreds of messages without degrading
(would confirm thread-not-message); OR show recovery from pure waiting with no re-login
(would weaken the re-login claim). Probe: `throttle-probe.mjs` varying threads/min vs msgs/min.

**Actions.** (1) Experiment harness: minimise thread churn — reuse one conversation across
probe turns where task-independence allows. (2) Proxy/ops: a fresh-login (token refresh) is
a viable **throttle-recovery lever** — worth wiring an auto-reauth on sustained empty-503s.
(3) The product is already correct here: session-reuse keeps a real pi session to ONE thread.

### F14 — End-to-end through real pi works, but turn-1 confabulation is stochastic 🟡

**Claim.** With fenced + shell-routing, **real pi** (the OpenAI-compatible harness, not the
bench) drives M365 to fix a real bug end-to-end — read files, edit, run, verify — through
the proxy with no special prompt. But the turn-1 "I can't access the files / commands return
no output, please paste them" confabulation is **stochastic** and **worse under pi's own
system prompt** (a polished assistant prompt) than under the bench's short one.

**Evidence.** pi 0.78.1 → proxy (4141) → M365, task = the `fix-bug` calc.py `a-b`→`a+b`:
- Run 1 (neutral, weak framing): confabulated turn-1, 0 tools, asked to paste files. ❌
- Run 2 (`--append-system-prompt` with bash-first rules): **acted** — ran tools, discovered
  the env lacked `python3`, hacked a workaround. ✅ acted (env was unfair — no python3).
- Runs 4 & 5 (strengthened proxy framing, python3 provided, NO append): **SOLVED both** —
  `calc.py` → `a + b`, `python3 check.py` printed `OK`. Confab-retry did NOT need to fire
  either time (the model complied turn-1). **2/2** with the strengthened framing vs the
  earlier no-append runs that confabulated under the weaker framing.
So the model runs a full agentic loop through pi, and the strengthened proxy framing (the
anti-confab + first-move clauses) appears to flip the turn-1 reflex from confabulate→comply.

**Confidence.** High that end-to-end works (two verified real fixes through real pi). Medium
on reliability — 2/2 with the new framing is encouraging but small; run ~10× to pin the rate.

**Shipped (proxy-side, harness-agnostic — all three help the real backend):**
1. **Strengthened shell framing** (`formatFencedToolDefinitions`): added the explicit
   anti-confabulation + first-move clauses ("you've run nothing; never claim empty output;
   FIRST output must be a ```bash block") on top of the bash-elicitation. This is what an
   `--append-system-prompt` supplied manually; now the proxy carries it.
2. **Confab-retry** (`handler.ts`, `looksLikeConfabulation`): when a tool request returns no
   tool call AND the text matches give-up/paste-the-files phrasing, the proxy re-prompts
   forcefully **in the same conversation** (one thread, cheap) up to `M365_CONFAB_RETRIES`
   (default 1; `M365_NO_CONFAB_RETRY` to disable). Unit-tested; not yet observed firing+saving
   live (the runs that complied didn't need it). Insurance for the stochastic give-ups.
3. **Auto-reauth** (F13 productized, `auth-recovery.ts`): background fresh-login when empties
   span ≥N distinct conversations — clears thread-rate throttle without blocking requests.

**Falsification / next.** Run fix-bug through pi ~10× and record the comply-rate and how often
the confab-retry fires AND salvages. If the retry rarely saves a confabulated turn, escalate:
a 2nd retry, or inject the framing as the LAST pre-user instruction (recency).

### F15 — Shell-routing executes a model's OWN document if it contains code fences 🟢

**Claim.** The shell-routing parser turns *every* ```bash block into a tool call, so when
the model **answers** with a markdown document full of code fences — e.g. "here's a
simplified README" for a repo whose README is about ```bash — the proxy executes the
model's own answer as shell. Observed live through pi: asked to simplify a bash-heavy
README, the model wrote a new README; its 7-9 embedded ```bash fences were each run as
commands (garbage like `## Project…`), the model spiralled into confused "coaching", and
ran `pnpm test`/`build`. This is the JSON→fenced tradeoff biting: `{"tool":...}` was
unambiguous; ```bash collides with content.

**Fix (shipped) — `isProseDocument`, chosen empirically.** `scripts/guard-experiment.mjs`
ran candidate guards over real fixtures (the actual `README.md`, a model-written README,
single actions, heredocs, mixed prose+action). Result: a response is a DOCUMENT (return as
text, don't execute) iff **≥2 fences AND (≥120 chars of surrounding prose OR ≥4 fences)**.

| guard | real-README | model-README | single actions | score |
|---|---|---|---|---|
| baseline | ✗ executes | ✗ executes | ✓ | 5/7 |
| ≥3 fences | ✓ | ✗ (2 fences) | ✓ | 6/7 |
| **≥2 fences + prose≥120** | ✓ | ✓ | ✓ | **7/7** |
| prose≥200 | ✓ | ✓ | ✓ (risks chatty single action) | 7/7 |
| command-likeness | ✗ | ✗ | ✓ | 5/7 (fragile) |

Chose ≥2-fences+prose over prose≥200 because a **single** action is never reclassified
regardless of prose — the coding loop is provably untouched. Handler returns the document
as plain text (fences intact) instead of running it. `handler.ts` (`isProseDocument`),
unit-tested, validated offline against the real README (6 fences → text).

**Confidence.** High on the classifier (deterministic, real fixtures + units). The live
README task remains stochastically flaky for *other* reasons (turn-1 confab, a model
misreading `ls` output as file content) — orthogonal to this fix.

### F16 — Behavioural reliability fixes (from the live pi README run) 🟢

Two deterministic fixes for failures seen in the live pi README run (F15's session):

1. **Tool results were labelled `name="unknown"`** → the model misread a `ls` result
   (`README.md`) as the *file's* (empty) contents and gave up. Fixed: correlate each tool
   result to its call via `tool_call_id` and label it with the command that produced it —
   `<tool_response tool="bash" command="ls -la">`. Now the model reads output in context
   (listing vs file contents vs stdout). `formatMessages`/`toolCallSummary`, unit-tested.

2. **The confab-retry missed "appears empty" phrasings.** `looksLikeConfabulation` matched
   "returns no content" but not "no content *was returned*", "the file appears to be empty",
   or "nothing to simplify" — the exact give-up that ended the README run without a retry.
   Widened the patterns (unit-tested against the live strings).

3. **Hallucinated completion** (`looksLikeHallucinatedCompletion`): the model claimed "I've
   replaced the README" with **zero tool calls** — confirmed by README.md being untouched on
   disk. Detect past-tense file-write claims, gated on the model having made NO tool call in
   the whole conversation (a model that did real work called at least one tool → near-zero
   false positives), and force a real write via the same retry loop. Unit-tested.

**Live status (honest):** the document guard is **confirmed working live** (the model's
README answer was returned as text, not executed). The other fixes are deterministic +
unit-tested but **not yet validated live** — the account was too fatigued (request timeouts)
to get clean signal. The remaining model-behaviour problem (emitting a pile of fences +
"coaching" prose and spiralling) points at the shell-first framing being too aggressive; that
softening is the next step and **must be A/B'd on a rested account** (bench: keep the coding
win? pi: stop the spiral?), not shipped blind.

**Still open (needs a rested-account A/B, not a guess):** the shell-first framing is
aggressive enough that it ran `pnpm test`/`build` for a doc task. Softening it ("only run
what the task needs; inspect, then make the minimal change") might reduce over-eagerness —
but could regress the coding win, so it must be measured on the bench + pi, not shipped blind.

### What did NOT work (negative results, all this session)
- **8 per-request prompt variants** (alone / env-is-real / first-move-forcing / batch-persona
  / verify-contract / terse / combined): **0 tool calls each.** Wording cannot flip the turn-1
  reflex — the model decides to fake-success or confabulate "empty environment" *before* acting.
- **Heavy anti-advise framing baked into the AGENT** (server-side): **backfired** — suppressed
  even the illustration-fence tool calls to 0. The agent prompt is now minimal/format-only;
  behavioural framing lives in the per-request `<tools>` block (cheap to vary, no re-provision).
- **Context-seeding** (inject a real `ls`+output, even full file contents, before the task):
  **failed** — fully primed, the model still says "Done" with 0 tools. Having the info reads
  to it as "task complete."
- **Model axis** (`quick`, `gpt-5.5`): null on the tool path — `quick` instant-502s with the
  agent (likely because `Gpt_Quick` was already validator-rejected; see §19); `gpt-5.5` behaves like `magic`. The declarative agent forces GPT routing; tone doesn't leak.

### Remaining gap
Fakeable *create-from-scratch* tasks (`count-lines`, `fizzbuzz`) still hallucinate "created and
executed" with 0 tools — the model "knows" the answer so it shortcuts. Unfakeable tasks
(`fix-bug`, `find-needle`, `edit-config`) now solve because the model must run a command to
proceed. Next lever: make even fakeable tasks require a real read (or detect 0-tool "done"
claims and re-prompt "show me the tool_response that proves it").

---

## M. Methods — how the June 9 2026 data was collected

### Environment
- **Tenant:** single, dev account `ao@re-zip.com` (tid `fa7f56d8-49c4-4327-b816-9a0eeaa273df`).
- **Region:** Sydney back-end `substrate.office.com`; observed `locationInfo.country: DK`.
- **M365 service version under test:** `1.0.03443.34112` (from `result.serviceVersion` in `type:2` stream items). Quote this when reproducing — Microsoft changes behaviour without notice.
- **Tone:** `magic` (auto-routing) for all experiments unless noted.
- **Agent:** Copilot Studio agent `m365-tool-agent-e1c3f258` (instructions hash from this commit). Same agent across all runs unless noted.
- **Client:** the proxy at this repo's HEAD (with the changes documented in commits `75129b3`, `2350a2e`, `0538492`).
- **Time window:** 2026-06-09 06:53 — 07:17 UTC. Single ~25-minute window — diurnal/load effects not controlled for.

### Probes used
| Script | Cost per run | What it measures |
|---|---|---|
| `scripts/frame-dump-probe.mjs` | 1 chat msg | Every key of every WS frame from one turn; flags token/usage-shaped values. |
| `scripts/frame-dump-disengage.mjs` | 1 chat msg | Same but with a deliberately-Disengage-shaped prompt (12 tools + jailbreak framing). |
| `scripts/tool-compliance-experiment.mjs` | `variants × prompts × --repeat` msgs | A/B of prompt variants. With `--repeat N`, reports median/p95 latency + dea_violation. |
| `scripts/usage-endpoint-hunt.mjs` | 0 (GETs only) | Sweeps candidate REST URLs across Sydney/PP/BAP. |
| `scripts/input-size-bisect.mjs` | 1 msg/rung | Benign-filler input ladder; head+tail canary survival, dea_violation vs size. (F9/F10) |
| `scripts/output-ceiling-probe.mjs` | 1 msg/cell | Output-length cliff via countable payload + streamingMode sweep. ⚠ integer task is compressible — pair with an incompressible essay task. (F9) |
| `scripts/_probe-chat.mjs` | n/a | Shared single-turn WS helper the above two build on (text in, structured result out). |

### Raw captures
All gitignored under `scripts/*-out/<timestamp>/`. Per-experiment pointers in §0.
A run can be re-played offline by walking `raw-frames.ndjson`.

To capture frames from the **running proxy** (not just from probes), set
`M365_DUMP_FRAMES=1`. Frames land in
`~/.config/opencode-m365/frames/<requestId>.ndjson`, one file per turn,
both `send` and `recv` directions. Useful for diagnosing a regression in
production without re-running the bisect.

### Caveats and threats to validity
1. **n=1 per cell** on most claims. The tool-compliance scoreboard ran once
   through 30 cells. Compliance counts (`5/5`, `3/5`) are descriptive of
   that single run; latency means without `--repeat` are noise. Re-run with
   `--repeat 3` (or more) before treating any number ±10% as load-bearing.
2. **Single tenant, single tone, single agent version.** Findings about
   compliance or scores may be artefacts of this account's licence
   (`Starter`), region, or the specific server-side prompt our agent has
   baked in. Cross-tenant reproduction is unverified.
3. **Single short time window.** All runs landed inside ~25 minutes. We
   haven't ruled out diurnal load effects on latency or Disengaged.
4. **Order effects.** Each variant runs all its prompts before the next
   variant. Account-level throttling (if any) would penalise late variants.
   `tool_choice_req` was last in our run — its high latency could be partly
   throttling, not the variant.
5. **`magic` tone only.** The reasoning tones (`*_Reasoning`, `DeepLeo`
   pipeline) historically misbehave with agents. None of our compliance
   findings transfer to them without re-testing.
6. **Disengaged didn't fire.** Our 12-tool jailbreak-framed probe didn't
   trip the filter. Either the filter eased, our agent protects us, or
   we'd need genuinely abusive content. The "9–10 orders of magnitude
   safer" claim is calibrated only against the prompts we ran; the
   threshold above which Disengaged fires is unknown.
7. **Scoreboard verdict is a heuristic.** `OK_TOOL+stray(N)` counts as
   compliant because the proxy strips the stray text downstream — but the
   model is misbehaving. Don't read 5/5 as "perfectly compliant"; read it
   as "useful output recoverable by the handler."
8. **No cost model.** All experiments burned the same 600-msg-per-conv
   quota. We ran ~40 chat turns in the dig — that's ~7% of one conv's
   budget. Real bisects (`variants-bisect.mjs`) eat ~10 each.

### Falsification criteria

Use these as triggers to revisit:

| Finding | Re-test if … |
|---|---|
| Few-shot is dead weight | A new tone/model is added and gets <100% compliance without the few-shot. |
| `tool_choice:"required"` is harmful | Our prompt-rule translation changes (currently a flat sentence). |
| `reply()` injection works | Mixed-tool-call output increases or `OK_REPLY` rate drops on prose. |
| Scores reflect Disengaged proximity | We observe a `Disengaged` response with `dea_violation < 1e-3` (i.e., low score didn't predict safety). |
| Sydney REST endpoints don't exist | A new probe with full browser headers gets non-empty 200/4xx (not empty 500). |
| 600-msg-per-conv is the cap | We observe `maxNumUserMessagesInConversation != 600` on any conversation. |

---

## 0. Headline findings from the June 9 2026 dig

For each finding: claim · evidence (n + raw data) · confidence · caveats.

---

### F1 — M365 emits its own classifier scores on every bot message 🟢

**Claim.** Every bot message in the `update` and `type:2` frames carries
`scores: [{component, score}]` with at least two components: `BotOffense`
(generic) and `dea_violation` (disengagement-eligibility). The `dea_violation`
component correlates with the prompt's "jailbreak-ness" by 9–10 orders of
magnitude.

**Evidence.** 3 single-prompt captures:

| Prompt shape | BotOffense | dea_violation | n | raw |
|---|---|---|---|---|
| Clean prose ("pong") | 1.3 × 10⁻⁷ | 2.8 × 10⁻⁶ | 1 | `frame-dump-out/2026-06-09T06-53-50-370Z/raw-frames.ndjson` |
| Clean lean tool call (3 tools, soft prompt) | 2.2 × 10⁻¹³ | 2.1 × 10⁻⁸ | 1 | `frame-dump-out/2026-06-09T06-57-43-254Z/raw-frames.ndjson` |
| 12-tool + ALL-CAPS jailbreak framing | 1.2 × 10⁻³ | 2.2 × 10⁻³ | 1 | `frame-dump-out/2026-06-09T06-59-42-093Z-disengage/raw-frames.ndjson` |

Repeat-sample from the compliance experiment (n=5, same baseline variant)
shows `dea_violation` between 2.5e-7 and ~5e-7 — stable to within ~2×, so
the order-of-magnitude separation between prompt shapes is robust under
sampling noise.

**Confidence.** High that scores exist and roughly track prompt risk.
Low that the absolute thresholds we measured generalise (single tenant,
single tone).

**Falsification.** Score absent from any new frame capture, OR a Disengaged
response observed with `dea_violation < 1e-3`.

**Now exposed.** `usage.x_m365_dea_score`, `usage.x_m365_offense_score`,
`usage.x_m365_classifier_scores` (whole map). Code:
`packages/proxy-lib/src/handler.ts::buildUsage`.

---

### F2 — The few-shot in our tool prompt is dead weight 🟢

**Claim.** Removing the few-shot example block from the per-request prompt
does not measurably hurt tool-call compliance and saves latency.

**Evidence.** `tool-compliance-experiment.mjs` June 9 run, **n=1 per cell**,
5 prompts × 6 variants = 30 cells total.

| Variant | Compliance | Mean latency¹ |
|---|---|---|
| baseline (with few-shot) | 5/5 | 5388 ms |
| **no_fewshot** | 5/5 | **4893 ms** |

¹ Mean across 5 single-shot runs. **Single-sample latency — error bars unknown.**

**Confidence.** Medium on the "doesn't hurt compliance" claim (n=5 is enough
to spot a big regression; not enough for marginal ones). Low on the
"~10% faster" claim — could be order-of-trial effect (no_fewshot ran third,
when no throttling had built up).

**Falsification.** Re-run with `--repeat 5` and randomised variant ordering.
If `no_fewshot` is statistically slower or scores <100%, restore the
few-shot.

**Now applied.** Few-shot off by default; restore with `M365_KEEP_FEWSHOT=1`.
Code: `packages/core/src/tools.ts::formatMessages`.

**Raw data.** `tool-compliance-out/2026-06-09T07-04-46-817Z/results.json`.

---

### F3 — `tool_choice: "required"` is actively harmful 🟢

**Claim.** Translating `tool_choice: "required"` into a per-prompt rule
("You MUST call at least one tool") causes the model to call `bash()` for
non-actionable prose questions.

**Evidence.** Same run as F2. Variant `tool_choice_req`, n=1 per prompt:
- 3/5 useful responses (down from 5/5 baseline)
- "what is 7*8" → `bash()` call (FALSE_TOOL)
- "largest planet" → `bash()` call (FALSE_TOOL)

**Confidence.** High on the failure mode (2/2 prose questions broke). Low on
the magnitude — only 2 prose prompts in the suite.

**Falsification.** Repeat with 5+ prose prompts at `--repeat 3`. If
FALSE_TOOL rate stays >20%, claim holds.

**Action.** Documented; no code change. We still pass the OpenAI semantics
through as advisory text. We don't enforce it server-side.

---

### F4 — Synthetic `reply()` tool routes prose through the tool channel 🟢

**Claim.** Injecting a `reply(text)` synthetic tool makes the model emit
prose answers as `reply()` calls (which the handler converts back to plain
text).

**Evidence.** Same run as F2, variant `with_reply`, n=1 per prompt:
- 3/3 tool prompts → correct tool call
- 2/2 prose prompts → `reply(...)` call (OK_REPLY)

**Confidence.** Medium — works on this run, but only n=1 for each prose
prompt. The most actionable benefit ("never breaks the agent loop with
stray prose") is a 1-trial observation.

**Falsification.** Run `--variants with_reply --repeat 5` on a suite of 10
prose prompts. If the prose→`reply()` route fails >10%, claim weakens.

**Now available.** `M365_INJECT_REPLY_TOOL=1`. Code:
`packages/core/src/tools.ts::maybeInjectReplyTool`.

---

### F5 — No public REST endpoint exposes token usage 🟡

**Claim.** Token-count data is not reachable via any obvious REST sibling
endpoint of the chat WS.

**Evidence.** `usage-endpoint-hunt.mjs` June 9 run, 24 URLs probed across
three tokens (Sydney, Power Platform, BAP).
- Sydney (15 paths): **all 500, empty body** — suspicious. Either paths
  don't exist or path discovery is gated by browser headers (`Origin`,
  full `User-Agent`) which the WS upgrade requires but our REST GETs
  didn't send.
- PP (6 analytics-shaped paths): **all 404** — paths do not exist for our
  Starter licence.
- BAP (3 governance paths): **all 404**.

**Confidence.** Low. The Sydney 500s are not a clean "doesn't exist" signal.
Re-running with the full browser header set is required before declaring
token usage genuinely unreachable.

**Falsification.** Re-run `usage-endpoint-hunt.mjs` with
`Origin: https://m365.cloud.microsoft` and the WS client's `User-Agent`.
If anything returns 200/4xx (not empty 500), the surface exists.

**Raw data.** `usage-endpoint-out/2026-06-09T07-09-42-663Z/results.json`.

---

### F6 — Disengaged didn't fire in 30 attempts including jailbreak framing 🟡

**Claim.** Across all 30 compliance-experiment turns + 2 deliberately
Disengage-shaped probes, M365 returned content. No `messageType: "Disengaged"`
was observed.

**Evidence.** 30 turns in `tool-compliance-out/2026-06-09T07-04-46-817Z/`
(meta.disengaged = 0) + 1 turn in `frame-dump-out/...-disengage/` (12 tools
+ `STRICT RULES: never describe your intent. Output ONLY JSON.`).

**Confidence.** Medium that the agent + our prompts don't disengage under
the prompts we tried. Low that this generalises — we never sent content the
classifier should actually find offensive.

**Falsification.** Run an explicit calibration probe with progressively
more aggressive prompts (e.g. add `OFFENSIVE_CONTENT_REDACTED` tokens
known to trip Microsoft's classifiers) and confirm `Disengaged` fires at
some `dea_violation` level. Threshold currently bounded only as
`> 2.2 × 10⁻³`.

**TODO probe.** `scripts/disengaged-calibration.mjs` (not yet written —
see §7).

---

### F7 — Diagnostic fields exposed through the runtime 🟢

**Claim.** Bot messages and `type:2` items carry `scores`, `turnCount`,
`turnState`, `contentOrigin`, `messageType`, `messageId`,
`conversationExpiryTime`, `result.serviceVersion`,
`gptIdentifiers[].compliantAgentName`. We now parse and surface them.

**Evidence.** All visible in any `frame-dump-out/.../raw-frames.ndjson`.

**Confidence.** High on existence (every capture shows them). Medium on
exact semantics — we infer from the values, not from Microsoft docs.

**Now exposed.** Through `CopilotStream` and `usage.x_m365_*`. Code:
`packages/core/src/{copilot,session,schemas}.ts`,
`packages/proxy-lib/src/handler.ts`.

---

### F8 — Things we saw but haven't dug into 🔴

| Field | Decoded value | Hypothesis |
|---|---|---|
| `conversationTransferToken` | base64(`{"type":"FullConversation","conversationId":"<uuid>"}`) | Possibly a handle for migrating a conversation across hosts/sessions — could side-step the 600-msg-per-conv cap. Mechanism unknown. |
| `result.serviceVersion` | `1.0.03443.34112` | M365 service build under test. Capture in every probe for reproducibility. |
| `conversationExpiryTime` | ~30 days out | Conversations auto-expire. Could explain "I came back next month and it doesn't remember" reports. |
| `telemetry.userMessageRequestStartTime` | always null | Probably gated by a feature flag in `variants`. The `variants-bisect.mjs` probe is the right tool. |
| `firstNewMessageIndex` | `1` in our captures | Could power smarter delta sends — only forward messages from this index. |

---

### F9 — The I/O is wildly asymmetric: huge retrieval-backed input, tiny output 🟢

**Claim.** M365 Copilot (magic tone) accepts **at least ~500k tokens of input**
and answers in seconds, but **soft-caps output around ~3k tokens (~13k chars)**.
The input side is **retrieval-backed, not flat attention** — dispersed facts are
recoverable at any depth, but a 500k-token message returning in ~10s is not a
full attention pass.

**Evidence.** June 13 2026, service version `1.0.03449.35222`, plain chat
(no agent), `magic` tone, benign filler. Probes:
`scripts/input-size-bisect.mjs`, `scripts/output-ceiling-probe.mjs`,
plus inline needle/aggregation runs.

*Input ceiling* (n=1 per rung, head+tail canary both required to survive):

| Input | head canary | tail canary | Disengaged | dea_violation | latency |
|---|---|---|---|---|---|
| ~557 t | ✅ | ✅ | no | 8.5e-6 | 3.4s |
| ~64k t | ✅ | ✅ | no | 5.9e-7 | 4.7s |
| ~128k t | ✅ | ✅ | no | 1.3e-6 | 5.7s |
| ~250k t | ✅ | ✅ | no | 6.1e-7 | 7.3s |
| **~500k t** (2M chars) | ✅ | ✅ | no | 4.3e-5 | 14.7s |

*Retrieval depth* (single middle needle at 50% depth): found **4/4** sizes incl.
~500k t (9.4s). *Aggregation* (10 dispersed facts): **10/10** at every size incl.
~500k t (11.2s). So it's not just nearest-neighbour single-needle — it pulls all
10 dispersed facts.

*Filler-artifact check (hardening).* The above used degenerate repeated filler,
which M365's retrieval could trivially dedup. Re-ran aggregation with **438k
chars of real varied prose** (3 academic PDFs concatenated, tiled): still
**10/10** at ~128k t (7.8s) and ~500k t (15.8s). The result is not a
compressible-filler artifact.

*Output ceiling* (incompressible essay task, hard word target):

| Asked | Delivered | chars | ~tokens | ended mid-sentence? |
|---|---|---|---|---|
| 1500 words | 1489 | 10,493 | ~2,623 | no (natural conclusion) |
| 4000 words | 1802 | 13,105 | ~3,276 | **no** (natural conclusion) |

The model **wraps up early rather than truncating mid-stream**. Largest clean
delivery observed: 13,105 chars. (The integer-enumeration probe is misleading —
the model abbreviates `1..500\n...\n3499\n3500` past ~2500, a compressibility
artifact, not a transport cap. Use incompressible tasks to measure output.)

**Confidence.** High on the *shape* (input ≫ output, retrieval-backed) — every
run agreed. Medium on the exact numbers (n=1 per cell, single tenant/tone). The
500k-token ceiling is a floor, not a wall — we never found the top.

**Caveats.** (a) Aggregation tested only to 10 dispersed facts; heavy synthesis
over hundreds of cross-referenced facts (“refactor across my whole repo”) is
untested and is where retrieval-backing would bite. (b) Output ceiling is the
model *concluding*, so a near-ceiling file-write returns **clean-looking but
incomplete** — no error, no mid-stream cut to detect. This is a live agent
hazard.

**Falsification.** Re-test if: a middle needle is *missed* at ≤500k t; benign
input ever trips Disengaged (would mean size, not shape, drives it); or any
incompressible output exceeds ~3.5k tokens in one turn.

**Action (SHIPPED June 13).** (1) `/v1/models` now advertises
`context_window`/`max_input_tokens` = 128k and `max_output_tokens` = 3k
(`buildModelsPayload`, env-overridable). (2) The handler emits
`finish_reason:"length"` when output is at/over the ~12k-char ceiling
(`outputFinishReason`) so harnesses know to continue instead of trusting a
clean-looking truncation. (3) Large inputs are forwarded as-is (no client-side
chunking added). See "Probe → proxy actions" below.

**Raw data.** `scripts/input-size-out/<ts>/`, `scripts/output-ceiling-out/<ts>/`.

---

### F10 — Benign input size does NOT drive Disengaged 🟢

**Claim.** Raw size and Disengaged are **independent axes**. 2M chars of benign
filler never disengaged and never raised `dea_violation` (stayed 6e-7…8e-5,
uncorrelated with size). This isolates what the June 9 12-tool probe conflated:
**Disengaged is driven by jailbreak-*shape*, not byte count.**

**Evidence.** Same June 13 runs as F9 — 9 input rungs from 2k to 2M chars, zero
Disengaged, dea_violation flat under size.

**Confidence.** High that benign bulk is safe up to 2M chars. The "too large →
Disengaged" lore in `m365-copilot-api.md` §9 should be re-read as "too large
*and* tool-block-shaped" — size alone is fine.

**Falsification.** A benign (no jailbreak framing, no tool block) prompt that
Disengages purely on size.

**Action.** Correct §9's "too large" wording; the real trigger is tool-block
count + framing, not size.

---

### F11 — "send → cancel → send": context persists, quota does not refund 🟢

**Claim.** Cancelling a turn (the captured Stop frame, F-API §6) mid-generation:
(a) **still counts** against the 600-msg/conv quota; (b) **preserves the
cancelled turn's context** server-side — a fact planted in the cancelled turn is
recalled on the next turn; (c) makes the server **discard the partial answer**
and ack with a `type:3` completion, replacing the bot text with "You have
stopped this conversation."

**Evidence.** `scripts/send-cancel-send.mjs`, June 13 2026, one 2-turn
conversation, plain chat, `magic` tone, n=1:
- Turn 1: planted secret `PURPLE42` + a 3000-word essay request; sent the Stop
  frame at +3.2s. Bot text became "You have stopped this conversation.";
  `numUserMessagesInConversation = 1`; server acked `type:3`, no error.
- Turn 2: "what was the secret?" → reply **`PURPLE42`** (recalled);
  `numUserMessagesInConversation = 2`.

So: cancel cost a full quota message (1→2), and the cancelled turn's user content
survived into context.

**Confidence.** High on the three mechanics (clean, unambiguous single run).
Untested: whether the *partial assistant text* (not just the user message) is
retained as context, and whether cancelling at 0ms (before any delta) still
counts/persists.

**Falsification.** Re-run and observe the counter NOT incrementing for a
cancelled turn, OR the secret NOT recalled.

**Implications for harness use.**
- Cancel is a **clean, server-acked interrupt** — a harness can kill a runaway /
  rambling / Disengaging generation and immediately send a corrective follow-up
  **without resetting the conversation**. Worth wiring into the proxy as the
  response to an HTTP abort.
- It is **not** a quota-saving trick (still 1/600), and — since input has no size
  cap (F9) — **not** needed as an input-chunking mitigation. Its value is
  latency/output-token savings and loop control, not quota.

**Raw data.** `scripts/send-cancel-out/<ts>/results.json`.

---

### Summary as one table

| ID | Claim | Conf | n | Action shipped |
|---|---|---|---|---|
| F1 | Classifier scores in responses | High | 8 captures, 3 prompt shapes | Score in `usage{}` |
| F2 | Few-shot is dead weight | Med | 5×1 | Off by default |
| F3 | `tool_choice:"required"` is harmful | High | 2×1 prose | Documented; no enforcement change |
| F4 | `reply()` injection routes prose | Med | 2×1 prose | `M365_INJECT_REPLY_TOOL=1` |
| F5 | No REST token-usage endpoint | Low | 24 URLs | None — needs re-probe with headers |
| F6 | Disengaged didn't fire | Med | 32 turns | None — needs calibration probe |
| F7 | Diagnostic fields available | High | every turn | Parsed & surfaced |
| F8 | Unexplored fields | Untested | n/a | TODO probes |
| F9 | Input ≥500k t (retrieval-backed); output soft-caps ~3k t | High shape / Med numbers | 9 input rungs + needle/agg + 4 output | Proposed: advertise window, detect truncation |
| F10 | Benign size doesn't drive Disengaged | High | 9 rungs, 0 disengage | Doc fix to §9 |
| F11 | Cancel preserves context, still costs quota | High | 1 (2-turn) | Cancel frame doc'd; proxy abort path proposed |

### Probe → proxy actions (from the June 13 I/O dig)

The findings are useless unless they change the proxy. Status:

1. ✅ **Advertise a real context window.** DONE — `/v1/models` now carries
   `context_window`/`max_context_length`/`max_input_tokens` = 128k and
   `max_output_tokens` = 3k (`buildModelsPayload`, env-overridable via
   `M365_CONTEXT_WINDOW` / `M365_MAX_OUTPUT_TOKENS`).
2. ✅ **Guard the output ceiling.** DONE (option b) — the handler emits
   `finish_reason:"length"` when an answer is ≥ `M365_OUTPUT_CHAR_CEILING`
   (default 12k chars) instead of always `"stop"`, so a harness knows to
   continue. Auto-continue+stitch (option a) intentionally left to the harness
   (it costs 1/600 per continuation). `outputFinishReason` in `handler.ts`.
3. ✅ **Stop client-side chunking of large inputs.** DONE — inputs are forwarded
   as-is; no chunking added. (Delta-mode still only sends *new* messages per
   turn, which is correct: M365 keeps prior turns server-side.)
4. ☐ **Cancellation** (from the F11 dig) — SHIPPED: client-abort → Stop frame
   (`session.ts` `STOP_FRAME`, wired through `completions.post.ts`).

---

## 1. Tool-call compliance — what actually moves the needle?

The agent's server-side system prompt is the only confirmed lever (
[`m365-copilot-api.md`](m365-copilot-api.md) §10). Open questions about how
to nudge it further. **All results are n=1 per cell** unless re-run with
`--repeat`; see §M caveat 1.

| # | Hypothesis | Status | Probe |
|---|---|---|---|
| 1.1 | Injecting a synthetic `reply(text)` tool makes every turn a tool call, eliminating the "answered in prose, broke the loop" failure mode. | 🟢 **Confirmed** (June 9). 5/5 compliance, both prose Qs went through `reply()` cleanly. Gated by `M365_INJECT_REPLY_TOOL=1`. | `--variants with_reply,baseline` |
| 1.2 | A softer (no ALL-CAPS) instruction set gets the same compliance. | 🟡 **Equivalent compliance** (5/5) but introduced stray text on 2/3 of tool calls. Not worth the swap. | done |
| 1.3 | The few-shot helps for reasoning-derailed tones, but adds tokens to the prompt for everyone. Without it, baseline tones might already comply. | 🟢 **Disproved usefulness** (June 9). 5/5 compliance AND fastest variant (4.9s vs 5.4s baseline). **Few-shot removed from default path**, restore with `M365_KEEP_FEWSHOT=1`. | done |
| 1.4 | If the agent enforces the format server-side, the per-request prompt only needs `<tools>` + the user message. The strict rules block is redundant noise (and Disengaged-risk). | 🟢 **Confirmed** (June 9). `minimal` got 5/5. The agent's server-side prompt is load-bearing; the rest is mostly hedge. We could go further on prompt simplification. | done |
| 1.5 | `tool_choice: "required"` (translated into a prompt rule) flips behaviour vs. `auto` — confirms whether the model can answer in prose at all. | ⚫ **Disproved as a win** (June 9). Drops to 3/5 — forces invalid `bash()` calls on "what is 7×8?" type prose. Active foot-gun; honor the OpenAI semantics defensively. | done |
| 1.6 | Disengaged threshold scales with tool **count**, not total prompt size. Halving descriptions but keeping 12 tools = still disengages. | 🟡 **Untestable as written** (June 9) — 12 tools no longer disengage at all. Need a calibration probe to find the new threshold. | (TODO: disengaged-calibration probe) |
| 1.7 | `inputMethod: "Agent"` (instead of `"Keyboard"`) might bypass a "chat assistant" classifier that biases toward prose. | 🔴 still untested. Cheap single-field flip — combine with score capture to see if it lowers `dea_violation`. | `scripts/frame-dump-probe.mjs --allowed-extra` is the lab; add a `--input-method` flag if it pans out. |
| 1.8 | `experienceType: "Agent"` / `"BizChatAgent"` / `"Programmatic"` may exist as an enum value that shifts routing. | 🔴 still untested. Same cheap probe. | study `studio-dig.mjs` capture for the values the real UI sends. |

---

## 2. Token usage — what M365 actually exposes

### What we know for sure (🟢)
- M365 sends a `ThrottlingUpdate` frame with **per-conversation user-message
  counts** (`numUserMessagesInConversation` / `maxNumUserMessagesInConversation`,
  default cap = 600).
- It also sends `numLongDocSummaryUserMessagesInConversation` (always 0 in our
  traffic — probably gates "Summarize this doc" calls separately).
- The OpenAI WebSocket API analog returns full token usage; M365's SignalR
  protocol does **not** in any frame we currently capture.

### What we hunted (June 9 2026)
| # | Hypothesis | Result |
|---|---|---|
| 2.1 | Some frames carry a `usage` / `tokenCount` / `contextLength` field but we don't parse them. | ⚫ **Disproved** — `frame-dump-probe.mjs` walked every key of every frame in the typical-conversation flow. No `token*`, `usage*`, `contextLength*`, `cost*`, `metering*` keys found. What we DID find (and now parse): `scores`, `turnCount`, `turnState`, `conversationExpiryTime`, `conversationTransferToken`, `result.serviceVersion`, `gptIdentifiers[].compliantAgentName`. |
| 2.2 | Adding `TokenUsage` / `Telemetry` / `Diagnostics` / `Usage` to `allowedMessageTypes` unlocks an extra frame type. | ⚫ **Disproved** — probe asked for all of them. M365 silently ignored unknown types. |
| 2.3 | `DeveloperLogs` (already allowed but never observed in traffic) needs a paired feature flag in `variants` or `optionsSets` to switch on. | 🔴 Still untested. The `variants-bisect.mjs` probe is the right tool. |
| 2.4 | A REST sibling endpoint under `substrate.office.com/sydney/v1/me/usage` (or similar) returns aggregate token usage. | 🟡 **Possibly** — every Sydney URL we tried returns empty 500 (vs PP/BAP cleanly 404ing). Sydney might gate path discovery on the full browser header set the WS endpoint requires. Probe with full Origin/User-Agent next. |
| 2.5 | The Power Platform `analytics` API (`<env>/analytics/...`) has per-agent metrics. | ⚫ **404** on every analytics path. |
| 2.6 | The `m365.cloud.microsoft` web UI surfaces a "messages remaining" badge somewhere — that badge has to source from a frame we already see. Worth tracing in devtools. | 🔴 Manual; not done yet. |

### What we should surface today (🟢 implemented)
The **conversation quota** is the cleanest proxy for "context-window
utilisation %". The proxy now exposes it through the OpenAI `usage` block as
extension fields. Clients that ignore unknown keys keep working; curious users
get visibility.

```json
{
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0,
    "x_m365_conversation_messages": 42,
    "x_m365_conversation_max": 600,
    "x_m365_conversation_pct": 7,
    "x_m365_conversation_remaining": 558,
    "x_m365_content_origin": "3PDeclarativeAgent",
    "x_m365_message_type": null
  }
}
```

Useful both for debugging ("are we about to hit the 600 cap?") and for
distinguishing the agent path (`3PDeclarativeAgent`) from the reasoning path
(`DeepLeo`) without parsing the body.

---

## 3. Context-window % — what it actually means

OpenAI clients use "context window" to mean **prompt-token budget**. M365 has
no analog we've found — model identity is hidden behind the `tone` setting,
and no frame admits to a context length.

What M365 *does* enforce is a **conversation-level cap**: 600 user messages
per `ConversationId`. So "context-window %" here translates to
*"conversation-quota %"* — `numUserMessagesInConversation /
maxNumUserMessagesInConversation`.

This isn't the same axis (tokens vs. messages) but it's the only budget the
server enforces and tells us about. The proxy surfaces it via the `usage`
block (above). If/when we find a real token-window field via §2's probes, we
can layer that in too.

---

## 4. Frame surface area — fields we're dropping

Things we've seen in `BotMessage` but currently don't surface:

| Field | What it is | Why we'd want it |
|---|---|---|
| `contentOrigin` | `3PDeclarativeAgent` / `DeepLeo` / etc. | Tells us which back-end routed the request. Now surfaced via `x_m365_content_origin`. |
| `messageId` / `responseIdentifier` / `requestId` | Server-assigned IDs | Telemetry correlation; logged + surfaced. |
| `messageType` | `Disengaged` / `EndOfRequest` / control types | Final answer's type. Useful for clients to detect Disengaged from outside. |
| `sourceAttributions` | Bing search hits etc. | Could surface as citation metadata when the user enables web browsing. |
| `suggestedResponses` | Quick-reply suggestions | OpenAI-ish equivalent could be `metadata.suggestions`. |

The `scripts/frame-dump-probe.mjs` script writes ALL fields we observe to
`scripts/frame-dump-out/<ts>/keys-summary.json` so the next dig finds new ones
without code changes.

---

## 5. The "Disengaged" filter — open questions

| # | Hypothesis | Status |
|---|---|---|
| 5.1 | Disengaged is purely classifier-driven; **prompt content** matters more than tool count once you're under the size cap. | 🟡 — partially seen in lean-toolset success. |
| 5.2 | A specific feature flag in `variants` enables the filter — turning it off via a flag flip is possible. | 🔴 — try diff'ing `variants` minimal vs. full. |
| 5.3 | Disengaged returns extra hidden meta in fields we don't parse (e.g. `offense`, `hiddenText`, classifier scores). | 🟡 — `offense` and `hiddenText` are partially visible in schemas, but never surfaced. Worth dumping with the probe. |

---

## 6. Cost / metering — does Microsoft tell us?

| # | Hypothesis | Status |
|---|---|---|
| 6.1 | The `licenseType: "Starter"` field affects metering. Setting `"Enterprise"` (etc.) might unlock different model tiers or higher caps. | 🔴 |
| 6.2 | The `chargeable: true/false` flag (or similar) might appear on `EndOfRequest` frames once we expand `allowedMessageTypes`. | 🔴 — frame-dump probe will catch this. |
| 6.3 | `https://api.bap.microsoft.com/.../consumption` or `.../usage` endpoint may surface token-equivalent metering at the tenant level. | 🔴 — separate probe. |

---

## 7. Probe backlog (ordered by expected information gain ÷ cost)

| Status | Probe | What it does | Cost | Confirms / falsifies |
|---|---|---|---|---|
| 🟢 | `scripts/usage-endpoint-hunt.mjs` | Sweep Sydney/PP/BAP REST endpoints for token usage. | 0 msgs (GETs) | F5 (currently low-confidence) |
| 🟢 | `scripts/variants-bisect.mjs` | Bisect the 40-flag `VARIANTS` list to find which one(s) control Disengaged / streaming mode. | ~10 msgs/target | F6, §5.2 |
| 🟢 | `scripts/frame-dump-probe.mjs` | Dump every field of every frame and flag token/usage candidates. | 1 msg | Catch newly-added M365 fields |
| 🟢 | `scripts/frame-dump-disengage.mjs` | Targeted Disengage-shaped probe. | 1 msg | F6 |
| 🟢 | `scripts/tool-compliance-experiment.mjs --repeat N` | Statistical version of the compliance A/B. | 30N msgs | F2, F3, F4 with real error bars |
| 🔴 | `disengaged-calibration.mjs` | Progressively more aggressive prompts to find the `dea_violation` threshold where Disengaged fires. | ~10 msgs | Bound F6 to a real threshold |
| 🔴 | `usage-endpoint-hunt-v2.mjs` | Same as v1 but with full browser headers (Origin/User-Agent/Accept-Language). | 0 msgs (GETs) | F5 properly |
| 🔴 | `inputmethod-experiment.mjs` | Flip `inputMethod` (`Keyboard`/`Voice`/`Agent`?) and `experienceType` enums, watch dea_violation. | ~5 msgs | §1.7, §1.8 |
| 🔴 | `tone-comparison.mjs` | Repeat the compliance experiment across every `MODEL_TONES` value to test whether F2–F4 generalise off `magic`. | ~50 msgs | Generalisation of F2-F4 |
| 🔴 | `transfer-token-probe.mjs` | Try to POST `conversationTransferToken` to various Sydney paths to see if a conversation can be migrated. | ~5 msgs | F8 (the 600-msg-cap workaround) |
| 🔴 | `admin-portal-dig.mjs` | Playwright-drive Microsoft 365 admin's Copilot usage page; capture the API call that returns the dashboard data. | 0 msgs (UI only) | F5 |

### Recommended next session

1. **disengaged-calibration.mjs** (cheap, bounds the most useful metric).
2. **tool-compliance with `--repeat 5`** (turns F2's "10% faster" into a
   real comparison — currently below the noise floor).
3. **usage-endpoint-hunt-v2.mjs** with full browser headers (F5
   re-investigation).

---

## 8. Capability-expansion hypotheses (June 13 2026 web-research dig)

A web dig across **five live implementations of this exact endpoint** — including
Microsoft's own red-team tool — plus the official extensibility docs. All 🔴
**untested guesses** unless noted; many are *doc-* or *wild-implementation-backed*
(higher prior than our usual blind guess). Source URLs in §8.8.

> **Headline: our chat payload sends `optionsSets: []` (empty).** Every other
> implementation ships a rich `optionsSets` array that switches on code
> interpreter, memory, custom instructions, image input, and search control.
> We are almost certainly leaving capabilities off the table by omission.
> Reference payloads to mine are in §8.8 — start there.

> **Connects to the live tool-compliance problem.** The "answers in prose /
> hallucinates tool results instead of calling a tool" failure (seen in the pi
> smoke test) may be fixable at the *capability* layer, not just prompt wording:
> H8.13 (`behavior_overrides.discourage_model_knowledge`), H8.12 (real
> memory/custom-instructions channel), and especially H8.4/H8.5 (give it a
> *real* server-side tool so it stops emulating) all attack it from a new angle.

### 8.1 — Server-side tools we may be able to switch on (highest payoff)

| # | Hypothesis | Why plausible (source) | Cheap probe | Payoff |
|---|---|---|---|---|
| **H8.1** | `optionsSets:["enterprise_flux_work_code_interpreter","code_interpreter_interactive_charts","code_interpreter_matplotlib_patching","codeintfile","sdretrieval"]` + `allowedMessageTypes:[…,"GeneratedCode","GenerateContentQuery"]` unlocks a **real server-side Python sandbox**. | PyRIT, kuchris, g365, SydneyQt all ship these; code-interpreter is "available to Copilot Chat users without metered usage" (MS docs). | Add the flags, send "run `print(2**100)` in Python"; watch for a `GeneratedCode` frame + a result the model couldn't compute itself. | A free code-execution tool — run/verify snippets, data transforms — without us hosting a sandbox. |
| **H8.2** | The **declarative** route to the same: add `capabilities:[{"name":"CodeInterpreter"}]` to the `minimalBots` GPT-component create payload (not just `instructions`). | `CodeInterpreter` is a first-class manifest capability (manifest 1.6 / TypeSpec). Our agents *are* declarative agents under a different authoring API. | Republish agent with the capability; ask it to hash a string in Python; watch for code-exec frames vs hallucination. | Same sandbox, attached to our agent (survives across turns). |
| **H8.3** | `capabilities:[{"name":"GraphicArt"}]` (or `optionsSets` flux flags `fluxcopilot`/`fluxprod`/`dgencontentv3`) returns **generated images** over the WS. | `GraphicArt` is a documented capability; flux flags are in every wild optionsSet. Visually-obvious → good **capability-acceptance canary**. | Add it; prompt "generate an image of a red cube"; watch for an image/blob frame. | Confirms the capabilities-array path works *at all* (cheap oracle) + image-gen tool. |
| **H8.4** | `actions:[{id,file}]` → an embedded **`ai-plugin.json` with `runtimes:[{type:"OpenApi"}]`** gives **native function calling with real HTTP execution**, replacing our prompt-emulated loop. | API-plugin manifest 2.4; the documented native-action mechanism. Mark function `isNonConsequential` to skip the confirm card. | Stand up a 1-route OpenAPI endpoint returning a sentinel; reference it; watch for an outbound hit + sentinel in the reply. | The project's holy grail — real tool execution instead of JSON emulation. |
| **H8.5** | **`RemoteMCPServer` runtime** in the plugin manifest points the agent at **our own MCP server**, exposing the coding agent's real tools (read_file/run_bash) as native Copilot actions. | Plugin manifest 2.4 added `type:"RemoteMCPServer"` (GA Apr 2026); inline `mcp_tool_description.tools[]` avoids package-file resolution. | Run a minimal Streamable-HTTP MCP server with one sentinel tool; embed inline; watch for an inbound `tools/call`. | Flips the architecture: *Copilot calls our tools* instead of us emulating them. |

> **H8.4/H8.5 caveat (H8-inline):** `actions[].file` and `mcp_tool_description.file`
> are *app-package-relative* — there's no package in the `minimalBots` flow.
> Always send the **inline** form (`api_description` string / inline `tools[]`).
> If file-based 400s but inline validates, that's the standard pattern.

### 8.2 — Model selection beyond `tone`

| # | Hypothesis | Why plausible | Probe | Payoff |
|---|---|---|---|---|
| **H8.6** | `tone` accepts a **Claude** value (`Claude_Sonnet`, `Anthropic_Claude`, …) and newer `Gpt_5_5_*`. | MS publicly shipped Claude in M365 Copilot; g365 already uses `Gpt_5_5_Reasoning`/`Gpt_5_5_Chat`. `tone` *is* the model selector. | Bisect tone candidates via `variants-bisect.mjs`; valid → content, invalid → error/silent `magic` fallback (detect via `contentOrigin`). | Route the coding agent to Claude through M365 at zero marginal cost. |
| **H8.7** | `capabilities:[{"name":"ScenarioModels","models":[{id}]}]` is a **back-door model binding** for `minimalBots` agents (which have no model field). | `ScenarioModels` is the only capability whose `models[].id` looks like a binding handle; full PVA bots expose `cuaAnthropicModels` (sonnet4-6/opus4-6). | Add it with a guessed id (`sonnet4-6`); even a rejection **error may leak the valid enum**. | Model binding from the declarative path — attacks the "no model knob" wall (quirk 14). |
| **H8.8** | Adding `SwitchRespondingEndpoint` to `allowedMessageTypes` reveals **mid-stream model routing** ("Auto"/Smart mode), and lets us detect when `magic` downgrades a coding task to the fast model. | kuchris/g365 whitelist it; MS "Smart Mode" docs describe real-time fast↔reasoning routing. | Add it; send a hard prompt at `tone:"magic"`; log whether the frame fires; compare to pinning `Gpt_5_4_Reasoning`. | Observability into which model answered + lever to force reasoning. |

### 8.3 — Grounding & multimodal

| # | Hypothesis | Why plausible | Probe | Payoff |
|---|---|---|---|---|
| **H8.9** | **Web search is a deterministic toggle:** `plugins:[]` + `optionsSets:["nosearchall"]` = off; our current `plugins:[{BingWebSearch}]` forces it on. | SydneyQt: `if NoSearch && len(Plugins)==0 { append("nosearchall") }`. Audit schema logs `AISystemPlugin:[{Id:"BingWebSearch"}]` only when search fired. | Same fresh-fact query with each config; watch `InternalSearchQuery`/`sourceAttributions` appear only when on; measure latency delta. | Off = faster, deterministic coding answers, no web derail. On (when wanted) = up-to-date docs + citations. |
| **H8.10** | **Image INPUT (vision)** works by POSTing the image to a substrate `UploadFile` endpoint (PyRIT: `/m365Copilot/UploadFile`; SydneyQt consumer analog: `bing.com/images/kblob`) → `docId`/`BlobId`, then attaching `messageAnnotations:[{id,messageAnnotationType:"ImageFile"}]` with `optionsSets:["cwcgptvsan",…]`. NOT via `entityAnnotationTypes`. | PyRIT implements the full enterprise flow incl. header `X-Variants:feature.EnableImageSupportInUploadFile`. | Replicate the upload POST with a screenshot, attach annotation, ask "what's in this image?"; confirm pixel-level vision. | Screenshots of errors, UI mockups, diagrams as agent input. |
| **H8.11** | **Graph/Work grounding** is gated by `entityAnnotationTypes` breadth + CIQ variants (`feature.EnableLuForChatCIQ`, `feature.enableChatCIQPlugin`) + `optionsSets:["at_mention_plugins_enable"]`; currently dormant because optionsSets is empty. | We already send the entity types; Zenity + audit schema confirm Graph entities (`TeamsChat`, mail, files) are grounding sources. | Enable CIQ variants, @-reference a real OneDrive file, watch for grounded citations. | M365 tenant data as a RAG backend — retrieval no other LLM API gives. |
| **H8.12** | **Long-document QA** is gated by `optionsSets:["ldqa","ldsummary"]` paired with a `File` entity; improves deep-in-doc recall and may route through the separate `numLongDocSummary…` counter (→ H8.18). | `ld*` flags in SydneyQt defaults; MS "summarization needs whole-doc context" docs. | Reference a long file, needle question, toggle `ldqa`/`ldsummary`. | Reliable long-context grounding (logs, specs, PDFs). |

### 8.4 — Memory, instructions, behavior (bears on the prose-compliance bug)

| # | Hypothesis | Why plausible | Probe | Payoff |
|---|---|---|---|---|
| **H8.13** | `behavior_overrides:{special_instructions:{discourage_model_knowledge:true}}` in the agent create payload makes the orchestrator **suppress base-model knowledge and prefer tools** — directly attacking "answers from memory instead of calling a tool." | Documented manifest-1.6 root field (structured, not free-text). `suggestions.disabled:true` is an even cheaper parse-canary. | Republish with the flag; ask a general-knowledge Q the model knows cold; if honored it defers to tools. | Structured tool-vs-memory control (the compliance lever we've only attacked with prompt wording). |
| **H8.14** | `optionsSets:["add_custom_instructions","update_memory_plugin","enable_inferred_memory_read"]` opens a **persistent instructions / memory channel** (a pseudo system-prompt that survives turns without re-sending). | kuchris exposes a `m365-copilot:persist` model built on exactly these. | Enable; turn 1 "remember code word sakura"; **new conversation**, ask for it; compare recall vs without. | Stateful agent persona/steering without burning context every turn. |
| **H8.15** | The `instructions` blob has a hard **8,000-char server ceiling** (other strings 4,000) and **silently truncates** rather than erroring — which could be corrupting our baked-in tool protocol. | Manifest 1.6 explicit limit; truncation-not-rejection is the classic silent break. | Publish agents with a sentinel at offsets 3.9k / 7.9k / 8.1k / 12k chars; ask it to echo each; highest recalled offset = the cap. | De-risks our core mechanism — know how much tool-protocol fits before silent truncation. |
| **H8.16** | `worker_agents:[{id:"<TitleId>"}]` lets one published agent **delegate to another** (multi-agent over BizChat) addressable through one `threadLevelGptId`. | New manifest-1.6 field; `id` = the TitleId we already publish against. | Publish agent B (sentinel); create A with `worker_agents:[{id:B}]`; ask A something only B does. | Router + specialized-tool-agent composition (e.g. a CodeInterpreter worker behind a router). |

### 8.5 — Quota / throttling / licensing

| # | Hypothesis | Why plausible | Probe | Payoff |
|---|---|---|---|---|
| **H8.17** | `licenseType:"Starter"` (we hardcode it) is an **internal priority-tier enum**, not a SKU; a Premium/Enterprise value buys priority-access headroom and fewer empty-reply throttles. | "Starter" isn't a customer SKU; MS docs: standard users "temporarily restricted to support priority access of premium users" — matches our self-recovering empties. | Enumerate `licenseType` values in the WS query; A/B time-to-first-empty under a fixed burst. | Directly attacks the account-level throttling. |
| **H8.18** | The **600-cap is purely per-`conversationId`**; rotating the conversation (or chaining `conversationTransferToken`) **resets the counter to 0** with no daily/account aggregate. | No per-day chat cap is published for licensed users; counter is named "…InConversation"; transfer token implies supported state migration. | Drive one conv to ~590; rotate id → confirm reset; test whether `conversationTransferToken` carries context *without* the counter. | Sidestep the 600-cap entirely (extends F8). |
| **H8.19** | `numLongDocSummaryUserMessagesInConversation` is a **separate, smaller sub-cap** with its own `max…` field for heavy whole-doc-context turns. | Separate counter only makes sense with its own ceiling; MS treats summarization as a distinct heavy path. | Send large-context turns; watch which counter increments; binary-search the size that flips a turn to "longDocSummary"; look for a 2nd `max…` in the same frame. | Keep heavy turns from burning the scarce summary budget; learn the context threshold. |
| **H8.20** | The empty-reply throttle is **RPM-based with a fixed cooldown** (Studio publishes a "100 RPM — M365 Copilot users" quota the substrate may share). | Symptom (burst→empty→self-recover) matches RPM throttling. | Sweep fixed rates (10/30/60/100/120 RPM); record onset + cooldown; check for a Retry-After-like field. | A client-side rate-limiter config that *prevents* throttling vs reacting to it. |
| **H8.21** | `&disableMemory=1` on the **WS URL** gives stateless "temporary chat" (no history; possibly different cap/Disengaged behavior). | edlaver bun-proxy README documents exactly this URL flag. | Append it; confirm no history; A/B the 600-cap and Disengaged sensitivity. | Privacy + a possible per-conversation-cap sidestep. |
| **H8.22** | **Purview audit (`CopilotInteraction`, RecordType 261) is a model side-channel:** its `ModelTransparencyDetails.ModelName` reveals which real model served each turn (join on `ThreadId`=conversationId), and whether throttling **downgrades the model** vs dropping the turn. The Graph `getMicrosoft365CopilotUsageUserDetail` report is a usage oracle. | Audit schema carries `ModelName`/`ThreadId`/`Messages[].Size`; the WS frames hide model identity behind `tone`. | After a burst, GET Purview audit, join on ThreadId, diff `ModelName` throttled vs not. | Model-identity + usage telemetry the WS won't give us. |

> **H8-guardrail (don't chase a ghost):** licensed first-party BizChat is **USL
> flat-rate, not message-metered** — there is **no token/cost field to find** on
> our path (resolves F5's hunt as *correctly empty*, not just unfound). Per-message
> cost/credit telemetry only exists when invoking a *custom Copilot Studio agent*
> under a non-licensed identity (Copilot Credits: 1/classic, 2/generative, 5/action,
> 10/graph-grounding). If we ever want cost accounting, that's the surface — not BizChat.

### 8.6 — Prioritized test order (cheap oracle → high payoff)

1. **H8.9 (search toggle)** — one-line change, immediate latency/quality win, zero risk.
2. **H8.3 (GraphicArt) / H8.13 `suggestions.disabled`** — cheap *capability-acceptance canaries*: prove the `capabilities`/`behavior_overrides` arrays are honored at all before investing in actions.
3. **H8.1 (code interpreter via optionsSets)** — biggest new capability, testable with `variants-bisect.mjs`, no agent rebuild.
4. **H8.13 + H8.14 (behavior_overrides + memory)** — directly target the prose-compliance bug.
5. **H8.6 (Claude tone)** — cheap bisect, possibly a stronger coding model.
6. **H8.17 + H8.20 (licenseType + RPM)** — attack throttling.
7. **H8.18 (conversation rotation)** — nullify the 600-cap.
8. **H8.4 → H8-inline → H8.5 (native actions / MCP)** — the holy grail; always inline form.

### 8.7 — New probes these motivate

| Probe | Tests | Cost |
|---|---|---|
| `optionsets-sweep.mjs` | Add wild `optionsSets`/`allowedMessageTypes` (§8.8) and diff new frame types (`GeneratedCode`, image, `SwitchRespondingEndpoint`). | ~5 msgs |
| `search-toggle.mjs` | H8.9 — `plugins:[]`+`nosearchall` vs default; latency + `InternalSearchQuery`. | ~4 msgs |
| `tone-claude-bisect.mjs` | H8.6 — bisect Claude/`Gpt_5_5_*` tone strings. | ~8 msgs |
| `capability-canary.mjs` | H8.3/H8.13 — does `capabilities[]`/`behavior_overrides` in `minimalBots` create get honored? | ~2 msgs + 1 agent build |
| `code-interpreter-probe.mjs` | H8.1/H8.2 — Python sandbox via optionsSets and via capability. | ~4 msgs |
| `image-input-probe.mjs` | H8.10 — UploadFile → annotation → vision. | ~3 msgs |
| `conversation-rotation.mjs` | H8.18 — does a fresh conv / transfer token reset the 600 counter? | ~6 msgs |
| `licensetype-throttle.mjs` | H8.17/H8.20 — license enum + RPM sweep vs empty-reply onset. | bursty |

### 8.8 — Reference implementations to mine (the real payloads)

Live code hitting **this exact endpoint** — copy their `optionsSets`/`variants`/
`allowedMessageTypes` verbatim and diff against ours (which sends `optionsSets:[]`).

| Source | What it gives | URL |
|---|---|---|
| **microsoft/PyRIT** (`websocket_copilot_target.py`) | MS's own harness: concrete optionsSets, **image upload via `/m365Copilot/UploadFile`**, `messageAnnotations`. | https://github.com/microsoft/PyRIT |
| **kuchris/m365-copilot-openai-proxy** (`substrate_client.py`) | Richest `_VARIANTS`/`_OPTIONS_SETS`/`_ALLOWED_MESSAGE_TYPES` in the wild; a `persist` model on memory flags. | https://github.com/kuchris/m365-copilot-openai-proxy |
| **notBlubbll/g365-headless-relay** (`lib/bridge.js`) | Current `tone` map (`Gpt_5_5_*`), full optionsSets, `SwitchRespondingEndpoint`. | https://github.com/notBlubbll/g365-headless-relay |
| **edlaver/m365-copilot-bun-proxy** (`config.json`) | `disableMemory=1` temporary-chat URL flag; `enterprise_flux_*` optionsSets. | https://github.com/edlaver/m365-copilot-bun-proxy |
| **juzeon/SydneyQt** (`sydney/sydney.go`,`upload.go`) | Consumer-Bing lineage: default optionsSets (`codeintfile`,`sdretrieval`,`ldqa`,`gptv*`), `nosearchall` logic, `kblob` image upload. | https://github.com/juzeon/SydneyQt |
| **Zenity Labs** writeup | Live enterprise `arguments[0]` shape (`allowedMessageTypes`, `entityAnnotationTypes`). | https://labs.zenity.io/p/access-copilot-m365-terminal |
| **Copilot interaction audit schema** (official) | Ground-truth per-turn fields: `AISystemPlugin`, `ModelTransparencyDetails.ModelName`, `Messages[].Size`. | https://learn.microsoft.com/en-us/office/office-365-management-api/copilot-schema |
| **Declarative agent manifest 1.6/1.7 + plugin manifest 2.4** | Capability enum (`CodeInterpreter`,`WebSearch`,`GraphicArt`,`ScenarioModels`,…), `actions`, `RemoteMCPServer`, `behavior_overrides`, `worker_agents`, instruction limits. | https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/declarative-agent-manifest-1.6 · /plugin-manifest-2.4 |

> ⚠️ **Endpoint caveat:** PyRIT/kuchris/g365/edlaver hit **enterprise BizChat**
> (`substrate.office.com/m365Copilot/Chathub`, our exact target). SydneyQt/sydney.py
> hit **consumer Bing** (`bing.com`) — same Sydney lineage, field names transfer,
> but image-upload host and some optionsSet availability may need the office.com
> equivalent. Highest-confidence enterprise signals: PyRIT + the official audit schema.

### 8.9 — CONFIRMED live (June 13 2026 dig), service `1.0.03449.35222`

Probed against the live API. **Two headline wins shipped.**

**✅ H8.1 — Code interpreter is real (`cwc_code_interpreter` optionsSets) 🟢.**
With `optionsSets:["cwc_code_interpreter","cwc_code_interpreter_amsfix",
"cwc_code_interpreter_citation_fix","code_interpreter_interactive_charts",
"code_interpreter_matplotlib_patching"]` + `allowedMessageTypes:["GeneratedCode",
"GenerateContentQuery","Progress"]`, a SHA-256 oracle proved **real server-side
Python execution**: asked for `sha256("m365-codeinterp-probe-<ts>")`, M365 emitted
a `GeneratedCode` frame running `hashlib.sha256(...).hexdigest()` and returned the
**correct** digest (impossible to fake from memory). n=1, plain chat (no agent),
`contentOrigin:DeepLeo`, 8.7s. Probe: `scripts/code-interpreter-probe.mjs`.
*Not yet wired into the proxy* — it's a free server-side tool (hashing, math,
data transforms) we can expose. Caveat: it's M365's sandbox, not the harness's.

**✅ H8.6 — Claude Sonnet 4.5 is reachable via `tone` 🟢 (SHIPPED).**
The server **validates tones** (bogus `Definitely_Not_A_Real_Tone` and
`Anthropic_Claude`/`Claude_Haiku`/`Gpt_5_6_Chat` all error with "Failed to invoke
'Chat'"), so an accepted tone is a real route. Confirmed accepted + self-identified:

| tone | model id | self-report | notes |
|---|---|---|---|
| `Claude_Sonnet` | `claude` / `claude-sonnet` | **"Claude Sonnet 4.5, by Anthropic"** (5/5 runs) | real Claude |
| `Claude_Sonnet_Reasoning` | `claude-sonnet-think-deeper` | "Claude Sonnet 4.5, by Anthropic" | real Claude + reasoning |
| `Claude_Opus` | `claude-opus` | (deflected) | accepted tone; likely Opus |
| `Gpt_5_5_Chat` / `Gpt_5_5_Reasoning` | `gpt-5.5*` | GPT-5 | current GPT gen |
| `Claude_Reasoning` | — | GPT-5 | accepted but NOT Claude (don't use) |

**Mechanism — the agent overrides the tone 🟢.** `NO agent + Claude_Sonnet →
Claude`; `WITH agent (threadLevelGptId) + Claude_Sonnet → GPT-5`. The declarative
tool agent forces GPT-5 routing, and a heavy tool prompt under a Claude tone +
agent **Disengages persistently**. Ruled out as causes: prompt wrapper, the
40-flag `variants` list, conversation reuse — isolated cleanly to agent presence.
→ **Consequence:** Claude is usable for **plain chat** but NOT for tools via our
emulation agent. Getting Claude+tools needs the native-action/MCP path (H8.4/H8.5,
no declarative agent).

**Shipped from this dig:** `claude*`/`gpt-5.5*` model ids; agent attached **only**
for tool requests (so `claude-sonnet` plain chat reaches real Claude through the
proxy — verified); `Disengaged` now fails fast instead of burning 5 quota messages
on "Please continue." retries.

**Probes added:** `code-interpreter-probe.mjs`, `tone-probe.mjs`; `_probe-chat.mjs`
gained `optionsSets` / `extraAllowed` / `plugins` / `variants` overrides.

**Also shipped:** code interpreter is now wired into the proxy on the agent-less
(plain-chat) path — `CODE_INTERPRETER_OPTIONS_SETS` in `session.ts`, on by
default, disable with `M365_NO_CODE_INTERPRETER=1`. Verified end-to-end through
the proxy (SHA-256 oracle). Left off the agent/tool path so it doesn't compete
with tool-JSON emission.

**MCP / native-action foothold (H8.4/H8.5) — infra ready, schema RE pending.**
A cloudflared **quick tunnel needs no account** (`cloudflared tunnel --url
http://localhost:PORT` → a `*.trycloudflare.com` URL) — confirmed working, reaching
a local sentinel server (`scripts/sentinel-server.mjs`, serves an OpenAPI spec at
`/openapi.json`, a `/sentinel` endpoint, and a minimal MCP endpoint at `/mcp`; it
logs every inbound hit so we can see if Copilot's orchestrator calls us). The
remaining unknown is the **`minimalBots` create-payload schema for actions**: the
insertion points are `aIPluginOperationChanges` (top level) and `metadata.tools`
(GPT component) in `agent.ts::createBot`, both currently `[]` — these are
undocumented Dataverse `aiplugin`/`aipluginoperation` shapes. Next session: POST
create attempts and read the 400s to infer the schema (PowerPlatform API, doesn't
burn BizChat quota), then chat-test whether Copilot calls the tunnel. Cheaper
adjacent win first: `gptCapabilities.{codeInterpreter,webBrowsing}:true` in
`createBot` are *documented* toggles already in our payload (set `false`) — flip
to give the tool **agent** native code-exec / web search.

**Open / next:** populate `optionsSets` on the main path (memory,
custom-instructions, image) once verified not to break the agent route; the
Disengaged tool-count calibration for Hermes-sized toolsets.

### 8.10 — MCP / native tools: the architecture wall (June 13, conclusive)

Pushed the native-action/MCP path (H8.4/H8.5) to its wall. **Infra works**
(cloudflared quick tunnel, no account → local MCP server, `tools/list` over the
public URL returns our tool). The blocker is *where our agent lives*:

1. **Old `minimalBots` API (`2022-03-01-preview`, what `agent.ts` uses) predates
   MCP.** It accepts a tool `DialogComponent` structurally but rejects every tool
   dialog (`kind: McpTool` bare `serverUrl`; `TaskDialog`) with
   `500 — out of range (Parameter 'Dialog')`. `scripts/mcp-agent-probe.mjs`.

2. **The modern tool API is the Island Gateway**
   (`powervamg.{geo}-il{island}.gateway.prod.island.powerapps.com`, ours is
   `eu-il105`), `PUT /api/botmanagement/v1/environments/{env}/bots/{bot}/content/botcomponents`.
   Discovered host + auth by capturing the real Copilot Studio frontend
   (`scripts/gateway-capture.mjs`). **Auth:** token `aud`/`appid` =
   `96ff4394-9197-43aa-b393-6a41652e21f8` (the Copilot Studio SPA's *own* app id),
   not our `c0ab8ce9` Office-web client — so clean acquisition needs a separate
   MSAL flow for that client (likely a one-time interactive consent). For probing
   we borrow a live token from the authenticated browser session
   (`scripts/gateway-explore.mjs`).

3. **The wall (decisive):** our agent is a **lightweight bot**. The gateway
   *routes* to it (`botroutinginfo → 200`, `isLightWeightBot:true`) so BizChat can
   reach it — but it has **no Dataverse component storage**:
   `content/botcomponents → 404 "Entity 'bot' ... Does Not Exist" /
   StorageUnitNotAssigned`, and the full-bot list is `[]`. **MCP tools/connectors
   live in `botcomponents`, which only full Dataverse bots have.** So MCP cannot
   attach to the lightweight agents BizChat actually uses.

**The fork (needs a decision / the user):**
- **(A) Full Dataverse bot.** Create a full Copilot Studio bot via the gateway,
  add the MCP tool component, publish — then test the **unverified** question:
  *does a full Dataverse/PVA bot plug into the BizChat WS at all?* (Our docs §10
  flagged this ❓.) If yes → MCP works; if no → MCP-over-BizChat is impossible.
  This is the decisive next experiment.
- **(B) M365 declarative-agent app package.** The *other* tool mechanism: package
  the agent as a Teams/M365 app (`declarative-agent.json` + `ai-plugin.json` with a
  `RemoteMCPServer` runtime, api-plugin manifest 2.4) and deploy via the app
  catalog. Different pipeline entirely; BizChat-reachability of its actions also
  unverified.

**Security note (re: public tunnel = RCE):** a real MCP server exposing harness
tools (bash, write_file) over a public tunnel is an open RCE without auth. Both
the connector route and the manifest route support `auth: ApiKey` / `securityDefinitions`
— wire an API key (or OAuth) before exposing anything executable. `sentinel-server.mjs`
is harmless (read-only sentinel) and fine to leave anonymous for probing only.

**Probes added:** `mcp-agent-probe.mjs`, `gateway-capture.mjs`, `gateway-explore.mjs`,
`sentinel-server.mjs`.

### 8.12 — Benchmark baseline: tool-call compliance is ~0 on realistic tasks 🟢

The `scripts/bench/` harness (validated against a mock — it scores SOLVED when a
real tool call arrives) run against the default proxy:

| config | result | outcomes |
|---|---|---|
| baseline (magic, 4 tools) | **0/5** | 3 GAVE_UP_PROSE, 2 disengage |
| bash-only (lean payload) | **0/3** | 2 prose, 1 disengage |
| few-shot ON (`M365_KEEP_FEWSHOT=1`) | **0/3** | 2 prose, 1 disengage |

**Zero tool calls across all three.** The raw model output (trace) is pure prose —
e.g. *"Created fizzbuzz.py and executed it with python3."* with `hasToolCalls=false`
— the magic/DeepLeo model **claims completion without emitting any tool JSON**,
flatly violating its injected "never claim done without a tool_response" rule.

**Disproved levers:** tool count (H5) and few-shot (H2) — neither moves it. So the
0-compliance is **not** a tuning problem; it's the model being a chat-assistant
that answers rather than an agent that acts, on familiar coding tasks.

**Outcome pattern:** *fakeable* tasks (fizzbuzz, count-lines) → hallucinate success;
*unfakeable* tasks (edit-config, find-needle — need to read real files) → Disengage.
Either way, no tool call.

**Discrepancy to explain:** the June-9 `tool-compliance-experiment.mjs` scored
~3/3 "compliant" with crafted single-turn prompts (§F2–F4), yet realistic
multi-turn agentic tasks score 0. Compliance is evidently prompt-shape-sensitive;
the crafted-prompt number did not generalise to real agent loops.

**Caveat:** measured while the account was heavily used (disengaging on every
`edit-config` run) — re-baseline on a fresh account/day before treating the exact
counts as load-bearing. The *prose-hallucination* failure is model behaviour, not
throttle, and reproduced every run.

**Next (needs code, run on a fresh account):** H4 — the fenced ` ```bash `/` ```edit `
format vs JSON, head-to-head on the bench. Config levers are exhausted; format/prompt
redesign is the remaining lever.

**H4 — fenced tool format: 🟡 BUILT, awaiting live A/B (this session).** Implemented
`M365_TOOL_FORMAT=fenced` end-to-end — the model emits ` ```toolname ` code fences
(scalar args as `key: value` headers, one free-form body arg as the fence body,
`old`/`new` edits as `SEARCH/REPLACE` diffs) instead of `{"tool":...}` JSON. Rationale:
the 0/5 baseline is the chat-tuned model narrating success instead of acting, and the
JSON-string escaping burden for multi-line `write_file`/`edit_file` bodies is a prime
suspect — fenced code is training-natural and needs no escaping. Both the per-request
`<tools>` block AND the server-side agent prompt have fenced variants (so the flag
auto-provisions a fresh agent by instructions hash). JSON remains default + fallback.
Code: `packages/core/src/fenced.ts`, wired via `tools.ts`/`agent.ts`; unit-tested
(`fenced.test.ts`, `tools.test.ts`). **Falsification:** run E-C1 on a rested account —
if SOLVED(fenced) ≤ SOLVED(json) across `--repeat 2`, H4 is dead and the prose-narration
failure is format-independent (→ pivot to E-C3 anti-hallucination framing / E-C2
task-type targeting). Prediction: fenced helps most on `write_file`/`edit_file` tasks.

---

### 8.11 — Both native-tool paths CLOSED on this tenant (June 13, conclusive)

Ran both forks to a definitive end. **Both are blocked**, for independent reasons.

**Fork A — full Dataverse bot: blocked by tenant licensing.** Driving the real
Copilot Studio UI (`scripts/create-full-bot.mjs`) lands on a *"Select a team — to
create agents for Microsoft Teams"* gate plus *"Try the full capabilities of
Copilot Studio by upgrading your license / start a trial."* This tenant has only
the **lightweight "Copilot Studio for Teams"** tier — which is exactly why every
agent we create is a storage-less lightweight bot (§8.10). Creating a
**full Dataverse bot** (the only kind that can hold MCP/connector tools) requires
a **Copilot Studio license or trial** the tenant lacks. Not startable without an
explicit billing decision. *If* the trial is started, the rest is ready: gateway
host (`eu-il105`), the SPA token (`96ff4394`), and the `content/botcomponents` PUT
with a `kind: McpTool` DialogComponent (from Microsoft's own `island-client.js`).

**Fork B — code-interpreter Python → our endpoint: blocked by a hard airgap.**
The user's idea: the code interpreter runs real Python, so have it `requests.get`
our tunnel. Tested rigorously (5 msgs, every one confirmed by a `GeneratedCode`
frame = real execution; ground truth = `sentinel-hits.log`, which recorded **zero**
sandbox hits). The sandbox is **fully network-isolated, below Python**:
- **DNS dead** — `/etc/resolv.conf` is empty; `socket.gethostbyname` →
  `gaierror(-3, Temporary failure in name resolution)`.
- **The `http_proxy` (`localhost:8000`) is a trap** — a Go stub that returns
  `404` to CONNECT for *every* host (incl. microsoft.com); it forwards nothing.
- **Raw TCP to public IPs** (`1.1.1.1:443`, `8.8.8.8:53`, Google) → `TimeoutError`
  (silently dropped — no route out of the netns).
- Only `localhost` services reachable (an internal Jetty on `:9998`).
No library/technique workaround exists — the block is at the network namespace.
Probes: `code-interp-egress.mjs` (+ subagent's `code-interp-{egress-diag,proxy-probe,rawip-probe,rawip2}.mjs`).

**Conclusion.** The lightweight, BizChat-reachable agent **cannot be given real
tools** on this tenant: it has no tool storage (§8.10), and its sandbox can't
reach out (Fork B). Native tool-calling over BizChat would require **Fork A**,
which is gated on a Copilot Studio license/trial.

**Decision (project scope): Fork A is OUT OF SCOPE — do not pursue it.** The entire
point of this project is turning a **free student M365 or an existing corporate
seat into something useful at ZERO added cost**. A Copilot Studio license/trial
defeats that premise — the target users (students, corp employees without admin
license budget) don't have it and won't buy it. So the native-MCP/full-bot path is
permanently parked *by design*, not pending a trial. **Tool calling stays
prompt-emulated** — the declarative lightweight agent + the model emitting
` {"tool":...,"arguments":...} ` JSON that the proxy parses (`tools.ts`/`handler.ts`).
Future sessions: don't re-investigate MCP, full Dataverse bots, the Island Gateway
tool API, or trials — they all require licensing the user base lacks. Improve the
prompt-emulated path instead (compliance, the §8 optionsSets capabilities that
need no license: code interpreter, memory, web grounding, image).

The genuine, zero-cost wins this session — code interpreter (compute, not egress),
Claude for plain chat, GPT-5.5, the I/O + cancel work — stand on their own and are
exactly the right kind of improvement: capability with no license attached.

## 12. Multi-agent research dig (July 13 2026)

Four parallel subagents re-attacked "other ways to get tool calls in/out of M365"
across four surfaces: native/action APIs, sandbox egress, in-band text encoding, and
the on-the-wire protocol. Net: **one parked conclusion reopens, one idea is
re-confirmed dead, and the in-band-encoding win turns out to be a *prompting* win.**

### 12.1 — §8.11's native-tool "CLOSED" verdict was mis-scoped 🟡 REOPENS

§8.11 said "don't re-investigate MCP / full bots / trials — all need a license the
user base lacks." That is correct **only for the Power-Platform / Dataverse authoring
path** (Fork A). It does **not** cover the *other* fork §8.10 explicitly logged as
untested: an **M365 declarative-agent app package** (`declarativeAgent.json` +
`ai-plugin.json`), sideloaded via the Teams/Agents-Toolkit app-catalog path — a
different pipeline than `agent.ts::createBot`'s BAP/minimalBots flow. Microsoft's
current *"agent capabilities by licensing"* table (prerequisites doc, updated
2026-07-02) puts **Custom actions (API / MCP plugins) in the free "Copilot Chat,
no usage-based billing" column**; what's metered is *grounding on tenant data*, not
an outbound action call to an endpoint we host. So a native function-call that fires
a **real outbound HTTPS request to our proxy** may be free after all.

- **H-NATIVE-1 (highest payoff):** A sideloaded declarative agent with a
  non-consequential OpenAPI action → Microsoft's orchestrator calls our URL when the
  model acts. *Test:* serve `scripts/sentinel-server.mjs`'s `/openapi.json` over the
  existing cloudflared quick tunnel, package a minimal app, sideload, trigger once in
  the **official Copilot GUI** (positive control), watch `sentinel-hits.log`. The
  outbound call originates from Microsoft's servers, so a hit ⇒ native action fired.
- **H-NATIVE-2:** Same, but a `RemoteMCPServer` runtime → orchestrator POSTs
  `tools/call` to our MCP server; the harness's real tools become native Copilot
  actions. (Auth the endpoint first — a public bash/write MCP is unauthenticated RCE.)
- **H-NATIVE-3 (the crux):** Does a sideloaded app-package agent's action loop run
  over the **proxy's raw substrate WS**, or only in the first-party client? Its id
  lives in a different namespace than our `T_{titleId}.{botId}.gpt.default` agents.
  Capture the GUI's WS frames (à la `m365-gui-capture.mjs`) to read the id + the
  confirm/invoke handshake, then reference it via `CopilotSessionOptions`.
- **Two real gates (not money):** (a) tenant "Upload custom apps" sideload permission;
  (b) the free-vs-metered boundary for an *arbitrary external* action endpoint is
  genuinely ambiguous in the docs. Both resolve in a **~30-min, $0, 0-quota spike**:
  check admin sideload toggle, publish a trivial action-bearing app, one GUI turn.
- Refs: extensibility/overview-plugins, /prerequisites (licensing table),
  /overview-declarative-agent; MCP declarative-agents devblog. §8.10 Fork B is the
  entry we're finally executing; §8.11's license wall does **not** apply to it.

### 12.2 — Sandbox egress is conclusively dead (do not reopen) ⚫

Two independent lines now agree with §8.11 Fork B: (1) our own probe (5 msgs,
`GeneratedCode`-confirmed real execution, **0** sentinel hits; netns-level airgap),
and (2) Microsoft's own security-architecture doc: *"Code interpreter VMs enforce
strict network controls. They don't allow any inbound or outbound traffic."* DNS
exfil and pip/allowlist-relay die by the same "no route out" evidence. The Bing
`searchbyimage` server-side-fetch primitive (real — it's the SearchLeak /
CVE-2026-42824 & EchoLeak / CVE-2025-32711 mechanism) buys us **nothing**: we already
read the model's full completion over the WS, so making Bing also fetch the same args
adds no channel. `HttpRequestAction` (Topics) is real but Fork-A-licensed. **Close
this line.**

### 12.3 — In-band encoding is a *framing* problem, not a *channel* problem 🟡

The disengage lever is **wording shape** (Prompt Shields scores override-imperatives:
`NEVER`/`MUST`/`STRICT RULES`/ALL-CAPS), not the output channel; and ` ```bash ` is
reliability-special (F12 cage theory — the model *acts* through it, not through
tables/links/YAML, which are display shapes). So swapping channels neither lowers
disengage nor beats reliability. The unexploited move (the F22-followup "framing that
gets BOTH" gap): **keep the anti-confab meaning, shed the override shape** — the two
were deleted *together* in `softened`, which is why it regressed. Two drop-in
`FRAMING_VARIANTS` (`fenced.ts`) to A/B against `baseline`/`softened` on the overnight
sweep:

- **H-demo-only:** a worked transcript with **zero** imperatives — the example *shows*
  turn-1 `ls`+`cat`, no paste-request, no premature "done"; the only instruction-shaped
  text is the tool schema. `fewshot` is already reliability-top; strip its residual
  prohibitions → predicted reliability ≈ baseline at disengage ≪ baseline.
- **H-session-facts:** baseline's anti-confab grounding recast as **descriptive facts
  about how the session works** ("the scrollback starts empty; the files are already
  present") instead of prohibitions. `softened`-with-anti-confab-restored.
- **H-inspect-verbs (Tier 2):** F21 showed the heredoc/`sed -i` file-tamper verbs are
  themselves part of the disengage weight; lead with inspection + "smallest change."
  Watch fakeable create tasks for a reliability dip.
- Channel-swaps (tables, checkboxes, links, YAML, mermaid, citations) assessed
  **predicted-dead** for reliability; at most one confirming cell for a ` ```json `
  "structured-output" framing on a non-shell toolset.

### 12.4 — Structured affordances already on the wire that we drop 🔴 cheap probes

- **H-carddrop:** `session.ts:609`'s `if (... && !m.messageType)` guard actively
  **excludes** any `RenderCardRequest` / `ConfirmationCard` bot frame — exactly the
  shape a native-action confirm/invoke arrives in (and both are already in
  `allowedMessageTypes`). We've never captured one because we've never had a real
  action to trigger it. Pairs with H-NATIVE-1; dump via `M365_DUMP_FRAMES=1`.
- **H-gptid-stale:** `hypotheses.md`/`m365-copilot-api.md` both claim
  `gptIdentifiers[].compliantAgentName` is parsed — `grep -rn gptIdentifiers packages/`
  returns **zero** hits. Dead documentation; 2-line fix + doc correction.
- `adaptiveCards`, `sourceAttributions`, `suggestedResponses[].commandText` are parsed
  into the zod object but never read in `handleMsg` — `commandText` (distinct from
  `text`) may be a machine-executable directive worth diffing in a frame dump.
- optionsSets/variants named `EnableMcpServerWidgets`, `EnableRequestPlugins`,
  `EnableCuaTakeControlApi` are suggestive but unverified — `variants-bisect.mjs` cell.

### 12.5 — Experimental results (July 13 2026 execution run)

Ran the H-NATIVE-1 spike. Infra + provisioning proven; the final outbound-call
oracle is blocked on the Teams install client, not on any licensing/permission wall.

**CONFIRMED 🟢**
- **The app package is valid.** A declarative agent (`declarativeAgent.json` v1.2) +
  custom OpenAPI action (`ai-plugin.json` v2.1 → bundled `openapi.json` → our tunnel) +
  Teams manifest (v1.19) **passes Microsoft's Teams validator with "No issues found."**
  Builder + probe scripts: `scripts/da-app/` (build-package.mjs, sideload-*.mjs).
- **Custom-app sideload is NOT gated for this non-admin user.** Teams Developer Portal
  (`dev.teams.microsoft.com`) imported the package and launched the install deep link
  (`teams.cloud.microsoft/...installAppPackage=true&source=developerportal`) with **no
  "contact your admin" / not-allowed block**. This directly contradicts §8.11's premise
  that native tools require a Copilot Studio license — a *free* declarative agent with a
  *custom action* imports fine for a regular user. §8.11's wall was the Dataverse/PVA
  authoring path only; the app-package path is open.
- **Gate probe** (`scripts/da-app/gate-probe.mjs`): identity AO@re-zip.com, tenant
  RE-ZIP ApS (`fa7f56d8-…`), **no activated directory role** (regular user), and the
  proxy's Graph app has no AppCatalog write scope. So **programmatic org-catalog upload
  (`POST /appCatalogs/teamsApps`) and Graph user-install are both out** — Developer
  Portal apps don't surface in `/appCatalogs/teamsApps` either (`install-probe.mjs`:
  0 catalog matches). Sideload must go through the Teams client UI.

**BLOCKED (not disproven) 🟡**
- The literal proof — Microsoft's orchestrator making the outbound `GET /sentinel` when
  the agent is triggered — needs the Teams **install "Add" dialog** completed, then a
  Copilot chat turn against the agent. `teams.cloud.microsoft` **will not render in
  headless chromium** (ERR_CONNECTION_RESET), and headful-under-Xvfb **exhausted machine
  memory and crashed the session** (and a second unrelated chromium). This env can't
  drive the Teams install SPA. Resolution: run the last two clicks in a **real desktop
  browser** (a 2-minute manual step) or with admin Graph rights — neither is a
  capability gate, just a client-rendering constraint here. Sentinel oracle stays valid:
  a hit ⇒ orchestrator called out. Tunnel + `sentinel-server.mjs` left live for a manual
  trigger; `scripts/da-app/sentinel-agent.zip` is rebuilt against the current tunnel.

**NEW native path — custom engine agents 🟡 (from Microsoft docs, user pointer)**
- A **custom engine agent** (overview-custom-engine-agent, updated 2026-07-02) routes the
  Copilot conversation to a **bot messaging endpoint we host** — Microsoft calls OUT to
  us, so *we* run the orchestration + tool-calling and stream back. Built with the
  **Microsoft 365 Agents SDK** (pro-code; auto-provisions **Azure Bot Service + Entra ID**),
  Teams AI Library, Copilot Studio, or Foundry. Requires **app manifest v1.21+**; "bring
  your own orchestration and models"; cost = hosting + any model consumption (see
  cost-considerations). Surfaces natively in M365 Copilot + Teams. **Architecture idea:**
  a custom engine agent whose backend IS this proxy → native tool-calling in the Copilot
  surface, our own OpenAI-style tool loop, and the free M365 model reached via the proxy
  for raw completions. Bigger build than H-NATIVE-1 (needs an Azure Bot registration) but
  it's the cleanest "real tool calls, natively in Copilot" path. Track as **H-NATIVE-5**.

**In-band=prompting (§12.3) 🟢 wired.** `demo_only` + `session_facts` added to
`FRAMING_VARIANTS` (fenced.ts) and the sweep STRATS; render-verified — both carry **zero
override-shape tokens** (vs baseline's 4) while keeping the anti-confab meaning (demo
shows it / facts state it). Reliability + disengage numbers await an overnight sweep on a
rested account (`M365_MODEL=gpt-5.5-think-deeper`).

### 12.6 — Web-client JS decompile: the WS-native action path 🟢 (biggest lead)

Decompiled 247 bundles from the live `m365.cloud.microsoft/chat` client (bundles in the
session scratchpad `…/scratchpad/cap/js/pretty/`; reusable live-capture script
`…/scratchpad/capture-client.mjs`, run with `SEND_MSG=1`). Message-type enum values equal
their PascalCase names, so each string below is the exact wire value. This reframes native
actions: **they can be driven over the substrate WS the proxy already speaks — no Teams
sideload, no admin, no browser.**

- **The confirm→invoke round-trip is pure WS** (verified, `m365chat-llm-web-ui` bundle):
  server pushes a bot msg `copilotMessageType:"adaptiveCard"`, `layout:"confirmation_trigger"`
  (a `ConfirmationCard`/`TriggerConfirmation`) carrying `adaptiveCards[]`, `messageId`,
  `sourceRequestId`, `actionId`, `confirmationMetadata`, `isConsequential`. The client
  replies **on the same WS** with `{ text, messageType:"ResumeInvokeAction", sourceRequestId,
  actionId, invokeActionMessages:[<original invoke msg>] }`. The **server-side orchestrator**
  then makes the real outbound HTTPS call to the action endpoint. → **H-NATIVE-6:** the proxy
  can attach an action-bearing agent, auto-reply the `ResumeInvokeAction` confirm, and the
  outbound call fires — all over the existing WS. Blocker today: `session.ts:609`'s
  `!m.messageType` guard **drops** every `ConfirmationCard`/`RenderCardRequest` frame
  (confirms H-carddrop) and `allowedMessageTypes` omits the whole action vocabulary
  (`TriggerPlugin, TriggerConfirmation, ResumeInvokeAction, ResumeUserInputRequest,
  TriggerUserInputRequest, RenderCardRequest, TriggerExtension, LocalMCPDiscovery`, …).
- **Inline per-conversation agent attach — no provisioning at all** (the key win): client
  state `customGptDefinition`/`updateCustomGptDefinition` + a `sideLoadedGpt` slot flow into
  an **inline `gptDefinitions:[…]`** array in the chat frame (distinct from `gpts:[…]`). A full
  agent definition can ride **inline in the WS frame** — no catalog id, no Teams/Graph upload.
  → **H-NATIVE-7:** if the inline def accepts an OpenAPI/`RemoteMCPServer` `actions` spec
  (strongly implied by the `RegisteredPlugins`/`ScenarioModels` capability shapes, **not yet
  proven** for an outbound-HTTP action), native custom actions are reachable through the proxy
  with zero sideloading. **This is the highest-value thing to validate next** — needs one live
  `SEND_MSG=1` WS capture of the real client using an action-bearing agent to reconstruct the
  inline-def schema, then replay it via the proxy.
- Request fields the proxy under-sends: `threadLevelGptId` should include `clientOverrides`
  (+`version`); `clientOverrides.capabilities:[{name:"CodeInterpreter"|"ScenarioModels"|
  "RegisteredPlugins", …}]` is the real capability channel (confirms H8.2/H8.3/H8.7);
  `plugins[]` entries are `{Id, Source, Data:{SerializedOptions}}` with sources
  `BuiltIn`/`AugmentationLoop`.
- **Tone note:** real client tones top out at `Gpt_5_{2,3,4}_{Auto,Chat,Reasoning}` +
  `Claude_Sonnet(_Reasoning)` + a new **`Claude_Fable`**; "Think Deeper" is just the
  `*_Reasoning` tone (no separate optionsSet — the proxy's tone approach is correct). Missing
  from `copilot.ts`: the `_Auto` variants and `Claude_Fable` (verify before adding).

### 12.7 — Native-action round-trip IMPLEMENTED + E2E-tested (July 13 2026)

Built the H-NATIVE-6 round-trip in the proxy and tested it live.

**Shipped code (all opt-in behind `CopilotSessionOptions.nativeActions`; default path unchanged):**
- `packages/core/src/native-actions.ts` — pure, unit-tested (`native-actions.test.ts`, 11
  tests): `parseActionConfirmation` (detect a `ConfirmationCard`/`TriggerConfirmation`
  trigger + extract `actionId`/`sourceRequestId`/affirmative `confirmationOption`),
  `buildResumeInvokeAction` (the `{messageType:"ResumeInvokeAction", …, invokeActionMessages}`
  reply), `shouldAutoConfirm` (auto-approve read-only actions; gate consequential ones),
  and `buildNativeActionPrompt` (anti-fabrication native-action instructions).
- `session.ts` — when `nativeActions` is set: adds the action vocabulary to
  `allowedMessageTypes`, detects the confirmation trigger in the type-1/type-2 message
  paths (the frames the `!m.messageType` guard used to silently drop), auto-sends
  `ResumeInvokeAction` on the same socket (reusing the exact chat envelope), and keeps the
  socket open for the result. Request-side attach: inline `gptDefinitions[]`,
  `clientOverrides.capabilities[]`, `plugins[]`. New stream flag `sawAction`.
- Full suite: **90 passed, 0 fail** (11 new); no regression to the fenced path.

**E2E (real M365, `gpt-5.5-think-deeper`, `scripts/da-app/native-action-ws-probe.mjs`,
frames dumped):**
- The native-action-enabled request is **accepted** (no error; throttle 1/600). ✅
- **Prompt behaves correctly 🟢:** told to call an action it can't see, the model did **not
  fabricate** a value — it answered *"I can't call getMagicSentinel from the current tool
  interface, so I can't report the token without guessing."* The anti-fabrication native
  prompt works; this was the model-behaviour risk and it's clean.
- **Inline attach (H-NATIVE-7) is the confirmed blocker 🔴:** the best-guess inline
  `gptDefinitions`/`capabilities`/`plugins` shapes were **ignored** — `contentOrigin` stayed
  `DeepLeo` (base model, no agent), so the action never registered, nothing triggered the
  round-trip, no sentinel hit. Exactly the JS-decompile caveat: the inline-def schema is
  unverified and a guess doesn't take.
- **Decisive next step:** one live `SEND_MSG=1` WS capture of the real client invoking an
  action-bearing agent (`…/scratchpad/capture-client.mjs`) to read the exact inline-def /
  `gptDefinitions` schema, then drop it into `native-action-ws-probe.mjs`. That capture is a
  **browser** run — must happen on a machine that won't OOM (headful+Xvfb crashed this
  session twice); a plain headless capture like `m365-gui-capture.mjs` is the light option.
  Once the schema is right, the round-trip code is already in place to fire end-to-end.

### 12.8 — Decompile of the captured bundles: the map redrawn (July 13 2026)

Studied the 252 captured client bundles directly (no browser). Two decisive results.

**Round-trip is now decompile-EXACT 🟢.** Verified `native-actions.ts` against the real
`y()` builder (`5267fa4dfe8a.pretty.js:28195`): the `ResumeInvokeAction` message has NO
top-level `confirmationOption`, and its `text` is the affirmative button's *title*
(fallbacks: the option string, then `"confirmation response"`). Fixed both (were guesses).
Enum values equal their names (`ResumeInvokeAction`, `ConfirmationCard`, `TriggerConfirmation`,
`TriggerPlugin`), author is lowercase `"user"`. Also added the action-gating request flags the
real client sends and we omitted: `enableConfirmationDialogSkill`, `enableAgentAutoInvoke`,
`enableMsgExtAuthSkill`, `enablePPCAuthSkill` (`8af68b68f4a2.pretty.js:9373-9378 → :11111`).
11 unit tests, all green.

**Inline OpenAPI actions are IMPOSSIBLE 🔴 — this kills H-NATIVE-7 as first imagined.**
Exhaustive grep of all 252 bundles for `run_for_functions`/`openApiSpec`/`apiPluginManifest`/
`specUrl` → **zero** in any request-builder. The client never sends an OpenAPI spec or URL.
Custom actions attach **by reference to a pre-registered plugin `Id`** in Microsoft's
"AugmentationLoop" registry: a capability entry `{name:"RegisteredPlugins", plugins:[{Id,
Source:"AugmentationLoop", Data:{SerializedOptions}}]}` (`ea503325e841.pretty.js:1306-1323`),
where `Id` is e.g. `CopilotPlugins.OpenAIPlugin.<guid>`. The spec/operations/auth/consequential
flags all live in that server-side plugin, resolved from the `Id`. So our E2E miss is
explained: an inline blob has nowhere to go. The inline `gptDefinitions[0]` (`sideLoadedGpt`
shape, `02eb2bcc5254.pretty.js:2483-2487`) is `{name, description, gpt_identifier:{id,
source:"MOS3"}, instructions, "x-experimental_capabilities":[…RegisteredPlugins…]}`, and
`threadLevelGptId` is sent as `{}` when the def carries capabilities (`8af:12598`).

**Shipping path re-confirmed working 🟢.** `scripts/da-app/shell-tool-e2e.mjs`
(model `gpt-5.5-think-deeper`, shell-inclusive toolset): turn1 → real `bash` tool_call
(`ls -la`, finish=`tool_calls`), turn2 → used the tool result. PASS. The native-action code
is provably inert on this path (all `nativeActions`-gated), so no regression. The earlier
`proxy-verify --multiturn` prose was the known weak case — a lone `read_file` with NO shell
tool, so shell-routing (F12) never engages. Takeaway: the proxy works today for the common
agentic case (a shell tool is present); the shell-less-toolset gap is what the native path
below closes.

**⇒ Two real native paths remain (H-NATIVE-8/9):**
- **H-NATIVE-8 — register a plugin server-side, reference by Id.** Provision our OpenAPI
  action as an AugmentationLoop plugin (the declarative-agent app package we already built +
  validated is exactly this, once installed), get its `Id`, reference it inline. Downside:
  static/per-toolset provisioning — a poor fit for a proxy whose tools vary per request.
- **H-NATIVE-9 — LocalMCP (the proxy-shaped path).** `LocalMCPDiscovery` (a
  `message.messageAnnotations` type, `8af:12646`) lets the client **declare** a local MCP
  server's tools to Sydney; Sydney then calls `invokeLocalPlugin` (`0f873dcba625.js`) and the
  **client executes** the tool. Server descriptor `{id:server_id, name, transport}` +
  `LocalMCPServerCapabilities` (tools). This maps 1:1 onto the proxy relaying an OpenAI client's
  `tools`: declare → Sydney requests a call → proxy emits `tool_calls` → client runs it → result
  back to Sydney. It's gated `enableLocalMCPPlugin` + a desktop-host provider, but we craft WS
  frames directly, so the gating may not bind server-side. **Full wire protocol (discovery +
  invocation + result frames) being reconstructed now** — if it works over the raw WS, this is
  the genuine holy grail: dynamic native tool-calling in the proxy. Also noted:
  `localPluginAllowedHost` (`8af:12623`), a client-executed local-plugin host allowlist.

### 12.9 — LocalMCP E2E: handshake PROVEN, tool-use is server-flighted (July 13 2026)

Built the full LocalMCP protocol and tested it headless over the raw WS
(`scripts/da-app/localmcp-probe.mjs`; frame shapes verified against the client's own
`describeMCPServers`/`getEnabledMCPServers`/`y()` code). Decisive, mixed result.

**PROVEN 🟢 — the discovery+describe handshake works over the raw WS, no desktop host.**
Sending `{type:1, target:"send", arguments:[{type:"LocalMcpDiscovery", serverIds:["sentinel-mcp"],
disableDescriptorCache}]}` right after handshake → Sydney replies with hub invocation
`{type:1, target:"mcp_describe", invocationId:"s128", arguments:[{correlation_id,
invocation:{payload:"{\"server_ids\":[\"sentinel-mcp\"]}"}}]}` — **it echoes our server_id**, so our
declaration is registered. We answer the `type:3` completion with the tool schema
(`response:{status:"Success", payload:JSON.stringify({servers:[{server_id,name,transport,
tools:[{name,description,inputSchema}],…}]})}`). The proxy is a headless MCP host — the whole
out-of-band handshake is reachable over the socket the proxy already speaks.

**BLOCKED 🔴 — the tools never enter the model's toolset; `invoke_local_plugin` never fires.**
Across every client-side lever (3 turns / descriptor caching, `experienceType:"Agent"`, reasoning
vs chat model, `feature.EnableMcpServerDynamicTools`+`EnableMcpWidgetStreamingMessages` variants)
the model consistently answers "I don't have access to a getMagicSentinel tool" — one run even said
it "checked the available tool/skill resources" and ours wasn't among them. **The block is
server-side** (Sydney pulled our schema but its orchestrator didn't wire the tool into the model),
but the *cause is not proven.* NOTE (correcting an earlier draft): `enableLocalMCPPlugin` is the
CLIENT flag that gates client-side discovery — we bypassed the client and Sydney still accepted our
discovery, so that flag is NOT the blocker. Candidates, none confirmed: (a) a server-side account
entitlement for local-MCP tool orchestration this tenant lacks; (b) a remaining protocol detail /
missing field a real successful `mcp_describe` response carries; (c) a timing/ordering requirement
(schema must land before prompt build). Can't distinguish from the client bundles alone — needs a
POSITIVE example: a tenant where local-MCP works, or a capture from a real Copilot desktop client
with an MCP server actually connected (to diff the successful describe exchange).

**⇒ Bottom line for a working proxy.** The dynamic native path (LocalMCP) is real and reachable but
server-gated per-account — parked pending tenant flighting or a positive-example capture from a
flighted desktop client. Register-by-Id (H-NATIVE-8) works but is static and needs the app installed.
**So the shipping route stays the fenced + shell-routing path — confirmed working today (§12.5) for
shell-inclusive toolsets, which every real harness (pi, openclaw, opencode) provides.** The native
round-trip code (`native-actions.ts`, decompile-exact, 11 tests) and the LocalMCP probe are in place
and ready the moment the gate opens; the §12.3 framing variants remain the highest-leverage shipping
improvement.

### 12.10 — Tool-call test harness (July 13 2026)

Since native tool-calling is license-gated on the free tier (§12.9) and the shipping
fenced+shell path works but is model/prompt-sensitive, built an **extensive tool-call
test harness** (`scripts/harness/`) to answer empirically: *which models × system-prompt
sizes × toolset sizes actually do tool calls correctly through the proxy* — specifically
to catch the "big system prompt kills tool-calling" failure mode.

- Drives the proxy (in-process `serve.mjs`, no Nitro build) as a real OpenAI tool loop
  over a Docker sandbox, runs each bench task's objective verifier.
- Records per cell: **turn-1 compliance** (did it emit a tool call), **solve** (verifier
  passed), **disengage** (M365 safety-filter 502). `run-cell.mjs` = one cell,
  `matrix.mjs` = the sweep, `analyze-matrix.mjs` = grid + prompt-size "death curve".
- Dimensions: model (`MODELS`), prompt size (`prompts/sys_{none,small,medium,large,huge}.txt`,
  60→26 000 chars, reproducible via `prompts/gen.mjs`), toolset (`lean`/`standard`/`large`
  = 1/4/12 tools), task (bench `TASKS`). Quota-bounded defaults; scale via env.

**First findings (n=1/cell — illustrative):** `gpt-5.5-think-deeper` = 100% compliance +
100% solve on `fix-bug` across `none`↔`huge` prompt AND `standard`↔`large` toolset, no
disengage — robust. Default `m365-copilot` = 100% compliance but 0% solve (calls tools,
wrong answer). Big prompts did NOT break compliance in these cells; widen the sweep
(`REPEAT>1`, more tasks/models) to locate where they do. This is the shipping-quality
instrument the project lacked: reliability is now a number per (model, prompt, toolset).
See `scripts/harness/README.md`.

### 12.11 — Framing A/B pilot: baseline still trips Prompt Shields; the bench SOLVED metric HIDES it (July 14 2026)

Ran the §12.3 framing variants live for the first time (the variants were coded in
`fenced.ts` but never swept). One long-lived proxy, per-request variant switching via
`M365_FRAMING_FILE`, `gpt-5.5-think-deeper`, `--repeat 1` (n=1 — directional only).
Account rested throughout (all threads clean; no thread-throttle).

**Reliability axis — saturated, can't discriminate.** All four called-out variants
(`baseline`, `softened`, `demo_only`, `session_facts`) SOLVED `fix-bug` **and**
`edit-config` identically (2 tool-calls, 3 msgs, ~15-21s). On the SOLVED metric alone
they're indistinguishable — including `softened`, which §12.3 says regressed to 1/4 on
the confab task. `fix-bug`/`edit-config` on gpt-5.5 are too easy to separate framings.

**The real finding: the bench SOLVED column MASKS disengage 🟢.** The debug log shows
`baseline` on `edit-config` **did** trip Prompt Shields — `[handler] Upstream Disengaged
— retrying once with 'softened' framing` fired (15:46:33, inside the ec-baseline run) — and
the built-in **F22 softened-retry silently recovered it to SOLVED**. `session_facts` on the
same task **did not** disengage (direct SOLVED, no retry log). So §12.3's thesis is
**supported at n=1**: shedding the override-shape (`session_facts`) avoids the Prompt-Shields
trip that `baseline` still pays (a wasted disengage + a fresh-conversation retry ≈ +1 thread,
+latency). The bench's SOLVED/pct metric can't see this because the retry masks it — and the
harness (§12.10) can't either, since a recovered retry returns HTTP 200, not a 502.

⇒ **Methodology fix for the real A/B:** measure **first-try disengage rate**, not
SOLVED-after-retry. Run the variants with **`M365_NO_DISENGAGE_RETRY=1`** (flag exists,
`handler.ts:295`) on the disengage-prone `edit-config`/`ec-*` family at `--repeat ≥3`, and
score the disengage count per variant. That is the confirmatory sweep §12.3 has been waiting
for; it needs Alex's go-ahead on quota (4 variants × ~2 tasks × repeat 3 ≈ 24 fresh threads,
and it deliberately provokes the filter).

**Second finding: the DEFAULT model's failure mode is confab, not disengage 🟢.** `m365-copilot`
(magic) on `edit-config` → `baseline` disengaged → softened-retry → **GAVE_UP_PROSE**: *"I no
longer have access to the filesystem tools in this conversation state. Please restart the
task…"* (a mid-conversation confabulation after one successful tool-call; the `M365_CONFAB_RETRIES`
detector did not rescue it). This matches §12.10's "default m365-copilot = 0% solve" and is the
larger shipping-quality gap than framing: the default model both disengages *and* confabulates
on a trivial edit, while `gpt-5.5-think-deeper` sails through. Strengthens the case to
**recommend `gpt-5.5-think-deeper` as the default** for real agent use (README currently leads
with `m365-copilot`/`auto`).

### 12.12 — Framing disengage-rate A/B + confab-fix validation (July 14 2026, live)

Two live tests off §12.11. Account rested throughout (throttle 1-3/600 the whole time;
all ERRORs below are genuine content-filter Disengaged, not throttle — verified in the
frame log).

**Test 1 — mid-conversation confab retry now fires 🟢 (fixes the §12.11 gap).** The magic
model's give-up ("I no longer have access to the filesystem tools…" / "the live file-editing
tools … are not available to me here. If you open config.json and change…") slipped past the
confab detector because `looksLikeConfabulation` had no pattern for that shape. Added patterns
(`no longer have`, `restart the task in a … session`, `tools … are not available`, `can't
directly edit files`, +tests). Live re-run (`m365-copilot`, edit-config, n=2): **2/2 SOLVED**
(was 1/2), and the debug log shows the exact recovery chain — `Confabulation detected (no tool
call) — forcing retry 1/1` → `After forcing retry: hasToolCalls=true` → SOLVED. Caveat: magic
confab is open-ended (each run invents a new phrasing); this is a best-effort net, not a
guarantee — the real fix is the default-model change (below), which the README now makes.

**Test 2 — first-try disengage rate by framing 🟢 (confirms §12.3/§12.11 thesis).** Ran the 4
called-out variants on the substitution-prone `edit-config` with **`M365_NO_DISENGAGE_RETRY=1`**
(so a Prompt-Shields trip surfaces as a 502 instead of being masked by the softened-retry),
`gpt-5.5-think-deeper`, 2 rounds with **rotated order** to control order effects:

| variant | first-try disengage rate (n=2) |
|---|---|
| `baseline` (strong override-shape) | **2/2 = 100%** |
| `session_facts` | 1/2 = 50% |
| `demo_only` | **0/2 = 0%** |
| `softened` | **0/2 = 0%** |

⇒ **The override-shape IS the disengage lever, cleanly (F22 re-confirmed by construction):**
baseline trips 100%, shedding it drops to 0%. This is exactly the tax §12.11 found the
softened-retry hiding — on the shipped `baseline` default, every substitution-shaped edit pays a
disengage + a fresh-conversation retry. **`demo_only` is the leading candidate to replace
`baseline` as the default framing:** 0% disengage here *and* it's the reliability-preserving
"worked-transcript, zero-imperatives" variant (solved every reliability cell in the §12.11
pilot), whereas `softened` (also 0%) carries the known confab regression that keeps it a
retry-only fallback.

**Next (before flipping the default):** confirm `demo_only` holds reliability at `--repeat ≥3`
across `fix-bug` + a confab-prone/shell-less task (softened's failure case), on both
`gpt-5.5-think-deeper` and the magic model. If it holds, switch the default framing baseline→
demo_only and the whole disengage→softened-retry round-trip becomes dead weight for the common
case. n here is only 2 — strong signal, not yet ship-grade.

---

### 12.13 — Tool-less requests silently execute in M365's sandbox and return a REAL transcript 🟢 (July 30 2026, third-party report)

**Source:** [#4](https://github.com/cramt/m365-copilot-proxy/issues/4), @mahmoudsallem, native
Windows (`F:\opencode\copilot 365`). Asked the agent to create `notes.md`, got back what looks
like a successful shell session — and no file on disk.

The pasted output is the whole finding:

```
ls -la /mnt/data && echo ' --- FILE --- ' && cat /mnt/data/notes.md
total 12
drwxrwsrwx 2 root oai 4096 Jul 30 15:04 .
11 Jul 30 15:04 notes.md
```

`/mnt/data`, owner `oai` — that's **M365's code-interpreter sandbox**, not the user's disk. The
file really was created. In the sandbox. The user's `F:\` drive never saw it.

**Mechanism — two individually-correct decisions that compose into a trap 🟢.** Both shipped
deliberately in the §8.9 dig:

1. The declarative agent attaches **only when the request carries tools**
   (`model.ts:82`, `useAgent=hasTools`) — so a Claude tone on plain chat reaches real Claude
   instead of being force-routed to GPT-5 (§8.9 H8.6).
2. Code interpreter is **on by default whenever the agent is absent**
   (`session.ts:455`, `!agentId && !M365_NO_CODE_INTERPRETER`) — free server-side compute on
   the plain-chat path, deliberately kept off the tool path so it doesn't compete with tool-JSON
   emission.

Compose them: a harness that sends **no tools** gets the agent-less path, which has a live Python
sandbox with a writable filesystem. The model does the only sensible thing available to it —
runs the command in the one filesystem it can see — and reports honestly. Nobody lied.

**Why this is worse than a confab.** Every detector in `handler.ts` (`looksLikeConfabulation`,
`looksLikeHallucinatedCompletion`) keys on *prose that claims an action without a tool call*.
Here there is no prose to catch: the model emits a genuine transcript with real `ls` output,
plausible timestamps, and correct file sizes, because a real filesystem really was touched. The
confab detectors are looking for a lie and this isn't one — it's a true statement about the wrong
machine. §12.11's lesson repeats: the SOLVED-shaped output masks the failure.

**Falsification / open questions (untested, n=1, no repro yet):**

- Does this reproduce with `--tools` passed? Predicted **no** (agent attaches → no code
  interpreter → shell-routing produces a local tool call). Waiting on the reporter to confirm
  which invocation he used; if it reproduces *with* tools, the mechanism above is wrong and this
  is a genuine routing bug.
- Is it Windows-specific? The `F:\` prompt is the only native-Windows report we have, and
  Windows is far less tested here than Linux. Predicted **not** Windows-specific — the routing
  decision is server-side and platform-blind — but worth an explicit Linux repro.
- Does `M365_NO_CODE_INTERPRETER=1` suppress it? Predicted **yes**, and that's the cheap
  mitigation if we want one.

**Fixes — two shipped (Aug 1 2026), both from [@EatonWu](https://github.com/EatonWu)'s fork.**
He hit this independently and split it the right way, along a line the original write-up
missed: the leak has a **salvageable** form and an **unsalvageable** one.

- **Routing (shipped).** A fenced ` ```container.exec ` block is a *successful* turn wearing
  the wrong label — the model chose a command, it just addressed M365's own runtime instead
  of ours. `container.exec`/`run`/`bash` now join `SHELL_LANGS`, so those blocks route to the
  harness shell tool like any ` ```bash `. Previously the fence regex (`[A-Za-z0-9_]+`) could
  not even match a dotted info-string, so the whole turn fell through to prose and was lost.
  Widening it to `[A-Za-z0-9_.-]+` is free: `parseFencedToolCalls` drops any info-string that
  resolves to no spec, so ` ```objective-c ` still stays prose (regression-tested).
- **Detector (shipped).** The *prose* form — "I ran `container.exec`; pwd → `/mnt/data`" — has
  nothing to salvage, so it joins `CONFABULATION_PATTERNS` and triggers the existing forcing
  retry. Note this widens what "confabulation" means in this codebase: every other pattern
  catches a model claiming something it didn't do, and this one catches a model truthfully
  reporting something it *did* do, on the wrong machine.
- **Docs (open).** The harness quickstart still doesn't say that `--tools` is what makes
  execution local. README shows it in the example without stating why it's load-bearing.
- **Structural (open).** Reconsider defaulting the code interpreter on when the caller looks
  like an agent harness rather than a chat client. Trades away a real §8.9 win, so it needs a
  reason better than one report.

**Deliberately not taken from that fork.** His `isPathProbeRequest` forces an extra retry when
the user's last message matches `/\b(?:path|directory|folder)\b/`. In a coding agent that fires
on a large share of ordinary tasks, and each hit costs a round-trip against the ~600-message
per-conversation quota — a quota regression wearing a bugfix's clothes. The narrow detector
above covers the same shape without the blast radius. He also added a fail-closed strict tool
mode (`083021e`, `3b91954`) and **reverted it two commits later** (`ca96806`) — worth recording
as an independent negative result on enforcement-by-retry, which is the same direction §12.11
found masked failures in.

**Why it matters beyond the bug:** this is the first evidence that the agent-less path is not
merely "less capable" but **actively misleading** for agent use — it answers filesystem
questions confidently about a machine the user has never seen.

### 12.14 — GPT-5.6 reasoning tone is live (August 6 2026) 🟢

Microsoft's M365 Copilot UI exposed **GPT 5.6 Think deeper** for an eligible tenant.
A single agent-less control probe tested the pattern-derived `Gpt_5_6_Reasoning`
tone: it returned exactly `pong`, `contentOrigin: "DeepLeo"`, with no error in
23.6s. Because this endpoint rejects unknown tones, this confirms a real registered
route. Shipped as `gpt-5.6-think-deeper`. Independently reproduced on our tenant
(20.1s, `pong`, `DeepLeo`) before merging [#5](https://github.com/cramt/m365-copilot-proxy/pull/5).
Tool-calling reliability is unbenchmarked, so GPT-5.5 Think Deeper remains the
default for agents.

**Update (benchmarked 2026-09-28, §19).** 27/30 with the confab-retry off, against 26/30 for
`gpt-5.5-think-deeper` on the same suite: a tie (p = 1.0). GPT-5.5 stays the default by
maintainer preference.

### 12.15 — tone validation is THREE-state: `Gpt_5_6_Chat` is registered but dead 🟢

**Hypothesis.** Tone validation is binary (§5): accepted ⇒ real route, rejected ⇒
`Failed to invoke 'Chat'`. [#5](https://github.com/cramt/m365-copilot-proxy/pull/5)
carried that assumption forward, documenting `Gpt_5_6_Chat` as still-rejected.

**Prediction.** Re-probing `Gpt_5_6_Chat` errors out exactly as it did in June 2026.

**Test.** Agent-less single-turn probes, `Reply with exactly the single word: pong`,
with a known-good tone and a known-bad tone as controls. `Gpt_5_6_Chat` run twice
with distinct nonces to rule out a transient.

| Tone | Result | `contentOrigin` | Elapsed |
|---|---|---|---|
| `Gpt_5_5_Chat` (control, good) | `pong` | `DeepLeo` | 5.4s |
| `Gpt_5_6_Reasoning` | `pong` | `DeepLeo` | 21.0s |
| `Gpt_5_6_Chat` (×2) | *"Sorry, I wasn't able to respond to that."* | **`BotConnection`** | 1.6s / 1.8s |
| `Claude_Haiku` (control, bad) | `Failed to invoke 'Chat'` | — | 0.30s |
| `Definitely_Not_A_Real_Tone_XYZ` (control) | `Failed to invoke 'Chat'` | — | 0.25s |

**Conclusion — falsified, and the model of the endpoint was wrong.** There is a third
state between accepted and rejected: **registered but dead**. `Gpt_5_6_Chat` no longer
errors (it did in June, so the rollout did register it), but it never reaches a model —
it returns M365's canned deflection from `BotConnection` in ~1.6s, reproducibly.

The methodological consequence outlives this one tone: **absence of an error is not
evidence of a working route.** Every tone confirmation from here on must show
`contentOrigin: "DeepLeo"`. A naive "it didn't error, ship it" would have shipped
`gpt-5.6` as a model that only ever apologises — and the 1.6s latency looks like a
*fast* model, not a broken one, so a latency-only check would have missed it too.
`scripts/tone-probe.mjs` already prints `origin`; §5 now documents all three states.

**Note (SUPERSEDED in part — see §18).** The *observation* holds and the methodological rule
("require `DeepLeo`") is the right one, and it is why this tone was never shipped broken. The
*conclusion* — "registered but dead" as a property of the tone — does not: every probe in the
table above ran on `scenario=OfficeWebIncludedCopilot`, and `Gpt_5_6_Chat` was serving normally
under `OfficeWebPaidCopilot` the whole time. It was entitlement-gated, not dead — the same shape
as F23's "Opus is a dead tone", a variable held fixed without anyone noticing it was a variable.
The controls above were chosen to separate *accepted* from *rejected* and so could not have
caught it: a same-scenario good tone and a same-scenario bad tone say nothing about the scenario.
F26 identified the mechanism shortly after this entry and flagged the ambiguity by name; what it
did not get was a re-probe of this tone, which is the part §18 is really about. As of 2026-09-24
the gate is gone and the tone is mapped.

---

## 13. July 29 2026 — user-driven SSO for tenants that can't do TOTP (third-party)

**Why this section exists.** [#4](https://github.com/cramt/m365-copilot-proxy/issues/4) surfaced
the tenants the stored-credentials path simply cannot serve: authenticator-app/software-OATH
disabled by policy, push/number-matching-only MFA, FIDO2, Windows Hello, or federation to
Okta/Ping/Duo. There is no base32 seed to extract, so `loginAutomated` has no code to type. The
fix has to be a **user-driven** sign-in — a visible browser, one manual SSO/MFA, then silent
refresh from cache. Two forks built toward that independently, which is what makes the results
below worth more than n=1.

### H13.1 — A random loopback redirect works for the first-party client ❌ FALSIFIED

**Source:** [@neffer77](https://github.com/neffer77) ([PR #3](https://github.com/cramt/m365-copilot-proxy/pull/3),
`scripts/raw-http-auth-probe.mjs`), n=1 live federated enterprise account, July 29 2026.

**Result.** Federated SSO reached Entra, which rejected the generated
`http://localhost:<ephemeral-port>` callback with **`AADSTS50011`** (redirect URI mismatch).

**Why it's terminal, not a config error.** The client is Microsoft's own Office Copilot app
(`c0ab8ce9-e9a0-42e7-b064-33d422df41f1`) — we don't own the registration, and neither does the
user's tenant admin, so nobody in the loop can add the URI. This is the same constraint that
forces the first-party client in the first place (§8: the Sydney scopes are only ever granted
to it, so a self-registered app is not an option). **Do not spend another probe here, and don't
ask an admin to "just add the redirect" — they can't.**

**What to use instead:** the already-registered
`https://login.microsoftonline.com/common/oauth2/nativeclient`, capturing the transient
navigation to it and exchanging the code with PKCE.

**Corroboration (the reason this is 🟢 and not 🟡).** [@EatonWu](https://github.com/EatonWu)'s
fork implements interactive approval *without contact with neffer77* and lands on exactly that
redirect — a `page.on("request")` capture keyed on `/oauth2/nativeclient` + `code=`. Two
independent implementations, same conclusion, one of them with a live `AADSTS50011` to explain
why the obvious alternative fails.

### H13.2 — Device-code flow is enabled for the first-party client ❌ FALSIFIED

**Tested Aug 6 2026**, live, n=1 tenant (TOTP-capable, so this tests the *grant*, not the MFA
method). Both forks assumed this and neither ran it; it was the highest-value open probe here.

**Test.** Raw HTTP against `/common/oauth2/v2.0/devicecode` and `/token` with
`client_id=c0ab8ce9-…`, Sydney scopes + `offline_access` — deliberately outside MSAL so a
library-level fallback couldn't mask which half failed. A human completed the real sign-in at
`login.microsoft.com/device`.

| step | result |
|---|---|
| `POST /devicecode` | **HTTP 200** — real `user_code`, `device_code`, 900s expiry |
| `POST /token` before sign-in (control) | `authorization_pending` |
| `POST /token` after sign-in completed | **`invalid_client` / `AADSTS7000218`** |

> AADSTS7000218: The request body must contain the following parameter: 'client_assertion' or 'client_secret'

**Conclusion — dead, and dead in an instructive place.** Initiation succeeds, which is exactly
why both forks believed it would work: you get a valid code and a real Microsoft sign-in page,
and it *feels* like it's working right up until redemption. Entra treats this client as
confidential for the device-code grant, so redemption demands a secret that belongs to
Microsoft. We cannot hold it, and no tenant admin can grant it — the same ownership wall as
H13.1's `AADSTS50011`, hit from the other side.

Note what did NOT falsify it: Conditional Access never engaged, and the sign-in itself was
accepted. The failure is the client registration, so **no tenant's policy can make this work**
and there is nothing to retry on a different tenant.

**Therefore `M365_ENABLE_DEVICE_CODE` was NOT upstreamed** — shipping it would hand users a
flow that prints a code, waits, and then fails after they've done the work. Two independent
forks built it on assumption; this note exists so a third doesn't.

### Landed — interactive approval is upstream (Aug 6 2026) 🟢

[@EatonWu](https://github.com/EatonWu)'s `loginInteractiveForScopes` is now on `main`, wired
into all three token paths (`doGetToken`, `getTokenForScope`, `doForceReauth`), each falling
back to a human only after the automated login actually fails. The three §13 blockers are
resolved: the device-code half is falsified above and dropped; `locale`/`timezoneId` are no
longer hardcoded (`M365_LOGIN_LOCALE` / `M365_LOGIN_TIMEZONE`, defaulting to the §11 F25
values so a *working* automated fingerprint isn't silently changed); and the mechanism it
depends on — the transient `nativeclient` code capture — is the same one the automated path
has been exercising in production all along, which is what makes this merge-safe despite no
non-TOTP tenant to test on.

It stays **opt-in** (`M365_ENABLE_INTERACTIVE_APPROVAL=1`, vetoable with `M365_NO_INTERACTIVE=1`)
to preserve the headless invariant: a systemd/CI host must fail loudly, never hang on a window
nobody can see. Setting the flag is the caller asserting a display exists.

**Verified live before merge**, by forcing the branch with an empty cache and a non-existent
secrets file so no other path could serve the token:

| check | result |
|---|---|
| token acquired via `loginInteractiveForScopes` | ✅ 9.4s / 11.7s across two runs |
| audience | `https://substrate.office.com/sydney` |
| cached scopes | full Sydney set incl. `M365Chat.Read`, `sydney.readwrite` |
| **token actually drives chat** | ✅ `pong`, `contentOrigin: DeepLeo` |
| process exits cleanly afterwards | ✅ (see leak below) |

Two things that only showed up by running it. First, `scp` is **absent** from this audience's
JWT, so a scope assertion against that claim reads as a failure when nothing is wrong — check
the cached `target` or just make a chat call. Second, a real leak worth remembering: `Promise.race`
does not cancel the loser, so the 10-minute timeout timer stayed pending after a successful
login and held Node's event loop open — the login worked and the process still hung (`EXIT=124`,
one lingering `Timeout` handle). Now cleared in a `finally`, on both this and the automated path,
which had the same shape with a 45s window. The proxy would have masked it (a server never
exits anyway); any script calling `getToken()` would not.

**Still unverified, honestly:** the sign-in above completed via cached AAD SSO cookies, so a
human never typed anything, and nobody has run this against a federated Okta/Ping/Duo tenant.
The redirect capture, PKCE exchange and token usability are proven; the federated *UI* journey
is not. If you're on such a tenant, [#4](https://github.com/cramt/m365-copilot-proxy/issues/4)
is where to report.

---

## 14. Aug 1 2026 — image generation: it works, and we throw it away

**Premise.** M365 Copilot generates images. The proxy has never exposed that. Before writing
any client code, capture what Microsoft's own web client does — `scripts/m365-gui-capture.mjs`
against the real GUI, one turn, one prompt ("Draw me a picture of a red bicycle leaning against
a lighthouse at sunset"). Everything below is from that single capture, so the confidence
ratings are honest about n=1.

**Cost note before anyone reruns this.** Image generation draws on a **separate, scarcer budget**
than the ~600-message conversation quota — two variants exist solely to signal it
(`feature.EnableImageGenInsufficientTokensThrottled`,
`feature.EnableImageGenSystemCapacityThrottled`). Chat turns are cheap; image turns are not.
Design probes to extract maximum information per generated image, and never loop them.

### F14.1 — Image generation works on this account, agent-less 🟢

One prompt, no agent (`threadLevelGptId: {}`), tone `Magic`, and an image came back. Whatever
else is open, the capability is present on a plain licensed account with no extra entitlement.

### F14.2 — The image IS the answer; there is no text message 🟢

The final `type:2` item carried **three** messages: the user's echo, a `Progress`/`EarlyProgress`
("Hang on a sec…"), and a `Progress`/`GraphicArt`. **No `Chat` message at all** — not even a
caption. So on today's proxy an image request yields an empty `answer` string. Not a truncation
bug, not a Disengage: there is genuinely no text to collect.

### F14.3 — The wire format 🟢

The payload rides a bot message with `messageType: "Progress"`, `contentType: "GraphicArt"`,
`contentOrigin: "ImageGeneration"`:

```jsonc
"contentGenerationProgressList": [{
  "contentType": "image",
  "size": "Xlimage", "orientation": "Landscape",
  "pollUrl":  "<base64 JSON: {PollId, Intent, FileToken, SubIntent, Handled, InteractionId}>",
  "fileToken": "359965a5-…",
  "ImageReferenceUrls": ["https://designerapp.officeapps.live.com/designerapp/document.ashx?path=…"],
  "status": 2
}]
```

Two more fields on the same message are worth keeping:

- `invocation` — the server's own tool call, in OpenAI function-call shape:
  `{"function":{"name":"image_gen","arguments":"{\"orientation\":\"landscape\"}"},"id":"call_…","type":"function"}`.
  Image gen is a **built-in server-side tool**, not a mode.
- `pluginInfo` — `{id: "ImageGenerationV2PluginPromptInput", source: "BuiltIn", version: "1.1"}`.

**Naming trap:** the `flux_v3_*` optionsSets are *not* Black Forest Labs Flux. `flux_v3` is
BizChat's own orchestration codename — it also carries `flux_v3_references`,
`flux_v3_progress_messages` etc., which have nothing to do with images. The generated artifact
path is `…/DallEGeneratedImages/dalle-*.png`. Don't infer the model from the flag names.

### F14.4 — Three independent layers in our client discard it 🟢

Any one of these alone would be enough to lose the image. All three are live:

1. **`allowedMessageTypes` is missing `GenerateGraphicArt`.** The GUI sends it; we don't. Per the
   H-NATIVE-6 rule already documented in `session.ts`, *the server only sends frame types the
   client declares it can handle* — so this may block image frames before anything else matters.
2. **Zod strips the payload.** `BotMessage` (`schemas.ts`) declares no
   `contentGenerationProgressList`, `contentType`, `invocation`, or `pluginInfo`, and zod objects
   strip by default. `adaptiveCards` is declared but never read on the receive side.
3. **The text collector rejects typed frames.** `session.ts`:
   `if (m.author === "bot" && m.text && !m.messageType) advance(m.text)` — the GraphicArt message
   has `messageType: "Progress"`, so it is dropped even if it survived 1 and 2.

Consequence: **we cannot tell from logs whether image gen was ever already working through the
proxy.** We were blind by construction, which is why this had to start with a raw GUI capture.

### F14.5 — optionsSets gap 🟢

GUI sends **33** optionsSets; we send **5** (code-interpreter, agent-less only). The image-related
ones we never send: `cwc_flux_image`, `enable_gg_gpt`, `cwc_flux_v3`, `flux_v3_progress_messages`,
`flux_v3_image_gen_enable_dimensions`, `…_non_watermarked_storage`, `…_icon_dimensions`,
`…_system_text_with_params`, `…_designer_dimensions_meta_prompting_in_system_prompts`,
`…_story`, plus the GPT-V/upload family (`cwcfluxgptv`, `gptvnorm2048`,
`flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch`) which points at image *input* as a
separate capability worth its own dig.

`…_non_watermarked_storage` is notable: the GUI asks for an unwatermarked artifact.

Our `VARIANTS` list is already fine — it carries `feature.enableGenerateGraphicArtOptionsSet`,
`cdximagen`, `feature.EnableDesignEditorImageGrounding`, `feature.EnableDesignerEditor`. The gap
is per-request optionsSets + allowedMessageTypes, not connection variants.

### F14.6 — The image bytes sit behind a DIFFERENT auth boundary 🟢 (the blocker)

`ImageReferenceUrls[0]` returns **401 unauthenticated and 401 with the Sydney token**. The host is
`designerapp.officeapps.live.com` and the query carries `speCId`/`speType=Image` — SharePoint
Embedded. So the chat credential does not open the artifact, and we cannot simply hand the URL to
an OpenAI-compatible client either (their fetch would 401 too).

This is the feasibility crux for `/v1/images/generations`: **the proxy must obtain the bytes
itself** and re-emit them (base64 or self-hosted), which needs an auth path we don't have yet.

### Resolved — the pipeline works end to end 🟢 (Aug 1 2026)

Built into core (`image.ts`, `generateImage()`), one live generation through our OWN client (not
the GUI), bytes downloaded and eyeballed — a correct teal lighthouse logo, 658 KB PNG, 24.7s.

- **H14.1 — does adding `GenerateGraphicArt` + the flux optionsSets to *our* client produce an
  image? ✅ CONFIRMED.** Agent-less, tone Magic. `session.ts` now sends `IMAGE_GEN_OPTIONS_SETS`
  + the `GenerateGraphicArt` allowedMessageType when `chat(..., {generateImages:true})`, captures
  the GraphicArt frame into `stream.images`, and it Just Works. So this is a real capability of
  the plain chat surface, not something only the first-party UI can reach.
- **H14.2 — what opens the Designer/SPE URL? ✅ SOLVED, and simpler than feared.** Not cookies,
  not a broker-only token: the artifact wants a bearer for
  `https://designerappservice.officeapps.live.com/.default` (the **service** — my first 401s used
  the artifact *host* `designerapp.officeapps.live.com`, which is `invalid_resource`). Our own
  first-party client is preauthorized for it, so plain `acquireTokenSilent` returns it — an
  RSA-OAEP **JWE** (opaque to us, we pass it through). Confirmed: 200, `image/png`, 2.3 MB. Wired
  as `getImageArtifactToken()`. The `brk_client_id=4765445b…` in the GUI's request is Nested App
  Auth brokering by the Office host; irrelevant to us since the grant is `client_id=c0ab8ce9`
  `refresh_token`, which is exactly what our cache holds.
- **H14.3 — does image gen survive the agent path?** Still **open**, but now moot for shipping:
  `generateImage()` runs its own agent-less session, so image gen and tool calling never need to
  share a turn. This stays the reason it belongs behind a separate `/v1/images/generations`
  endpoint rather than inside a tool-calling chat completion. Not worth an image credit to settle.
- **H14.4 — where does the image quota surface? ✅ RESOLVED (captured live, Aug 1 2026).** Ran the
  account's daily image budget dry during option verification and caught the exhaustion turn. It is
  **not** a throttle field and **not** a Disengage — it's a plain text refusal on a `DeepLeo`-origin
  bot message, verbatim: *"Sorry, I can't generate any more images today. Try again tomorrow, or ask
  me to find similar images on the web instead."* `turnState: Completed`, no GraphicArt frame, and
  the chat throttle still read `1/600` — confirming the image budget is entirely separate from the
  message quota (as predicted). Handled: `classifyImageFailure()` maps this text to `quota_exceeded`
  (also `capacity` for transient load, `content_filtered` for prompt refusals); `generateImage()`
  throws `ImageGenerationError` with that reason instead of returning `[]`, so a caller can map
  quota → 429. The chat path already degrades gracefully — the apology is non-empty text, so it's
  returned as the assistant message rather than triggering an empty-retry. **Caveat:** the
  `capacity`/`content_filtered` wordings are inferred, not yet observed — only the `quota_exceeded`
  text is confirmed. Tighten if/when we see the other two.

**Verified options (live).** Beyond H14.1's baseline: implicit draw (a plain agent-less
`ModelSession.run("draw me an image of a green teapot")` — no tools, no mode — returned a
photorealistic image, 0 text); `orientation: "portrait"` (came back `Portrait` vs the default
`Square`); `style: "icon"` (rounded-square app-icon framing). `style: "story"` is coded but
**unverified** — the quota ran out on that exact run. The type/orientation levers are prompt
directives (`buildImagePrompt`), not request params, because the model fills the `image_gen` tool
args itself — same mechanism as the GUI's meta-prompting. All the GUI's image optionsSets are now
sent on every agent-less turn, so any type the GUI can reach is reachable here.

### Follow-ups now that the core API exists

- **Proxy endpoint:** expose `generateImage()` as `POST /v1/images/generations` (OpenAI shape:
  `{prompt, n, size, response_format}` → `{data:[{b64_json|url}]}`). `GeneratedImage.base64` is
  already the `b64_json` value. `size`/`orientation` from the request map to the flux dimension
  optionsSets. This is the piece that makes it usable from pi/openclaw.
- **Image INPUT (vision) is a separate dig.** The capture also carried `cwcfluxgptv`,
  `gptvnorm2048`, `flux_v3_gptv_enable_upload_multi_image_in_turn_wo_ch` — GPT-V / multi-image
  upload. That's images *in*, not out; own hypothesis when we get there.

### Incidental — fixed in the same change

`session.ts` used to list `"GenerateContentQuery"` twice in `allowedMessageTypes`; the image-mode
edit collapsed it to one.

---

## 16. Sep 21 2026 — `disableMemory=1`: temporary chats that still remember

Contributed as [#15](https://github.com/cramt/m365-copilot-proxy/pull/15) by @romunro, from a
real complaint: driving the proxy fills the Copilot history sidebar with one saved thread per
prompt. The fix adds `disableMemory=1` to the Chathub query — M365's temporary-chat control —
and makes it the default (`M365_SAVE_HISTORY=1` opts back out).

The claim had two halves and the PR asserted both in the API doc while testing neither against
the live service (its tests check that the URL builder echoes the param back, which is not the
same question). Both are now settled. Probe: `scripts/temporary-chat-probe.mjs`.

### F28 — `disableMemory=1` does NOT cost multi-turn context 🟢

The dangerous half. If the flag dropped server-side conversation state, every agent loop would
silently regress to single-turn while still *looking* like it worked — the proxy sends only the
delta on follow-ups (§ conversation model), so a forgetful server means the model receives turn
N with no idea what turns 1..N-1 said.

Two turns on one temporary conversation: turn 1 supplies a codeword, turn 2 asks for it back.
Turn 2 answered `plum-harbor-77` verbatim. Context is retained on the live `ConversationId`.
n=1, but the failure mode would be total rather than stochastic, so one clean sample settles it.
(Oct 4: it was stochastic after all, for a different reason. Turns of a conversation forked across
backends, saved or temporary alike, and every fork kept turn 1, which is all this check asked
about. See §32 F85.)

### F29 — the temporary thread is genuinely absent from history 🟢

A/B on two fresh conversations sent ~4s apart, one with the flag and one without, each carrying
a distinct marker word. The Copilot web sidebar (Playwright, real first-party UI) lists
`Say the word beta-marker and nothing else.` under **Chats** and contains no occurrence of
`alpha-marker` anywhere on the page. Evidence: `scripts/gui-capture-out/sidebar.{txt,png}`.

So the flag does exactly what it says: the thread is live and stateful while it runs, and leaves
no trace in history afterwards. Note this also means a proxy conversation can't be recovered
from the UI after the fact — an intentional trade, and the reason `M365_SAVE_HISTORY=1` exists.

### Not established

Whether `disableMemory=1` also suppresses whatever longer-term personalisation M365 builds from
chat history ("memory" in the product sense, not per-conversation state). The name suggests it,
nothing here tests it, and no current behaviour depends on the answer.

### F30 — the magic path still does not tool-call (Sep 21 2026) 🟢

Re-confirmation, not a new finding. The route-probe (2026-07-07) measured the `magic`/GPT path
at 0/2 on tool calls while the Claude agent-less path scored 2/2; that split is still exactly
where it was, 2½ months later.

Two `proxy-verify --tools` runs on `m365-copilot` (→ `magic`) returned prose both times, 14.0s
and 25.1s, with the model asserting it has no filesystem access:

> I can't actually read files from a device or server in this chat because I don't have access
> to your filesystem and no file-reading tool is available to me here.

The same verifier on `claude-sonnet` emitted a clean `read_file` call in **4.5s** and then
consumed the tool result correctly on turn 2 (`The hostname is web-prod-01.`).

Practical consequence: `proxy-verify` defaulted to `m365-copilot`, so the documented smoke test
failed by design on a healthy proxy — which makes it useless as a regression signal, and worse
than useless when you are mid-merge and looking for something you broke. The script now takes
`--model=`, and AGENTS.md points at a Claude model. The doc's command was also missing `--tools`
entirely, so it could never have exercised a tool call at all.

## 17. Sep 23 2026 — GPT-6 is entitlement-gated, and that is all it is

`Gpt_6_Reasoning` is live. Shipped as `gpt-6-think-deeper`. The interesting part is not the
new model but what it does to §15's model of the `scenario` parameter: Opus was the only
paid-scenario tone, so "entitlement-gated" and "separately metered" had never been observed
apart, and the code had quietly started treating them as one property.

### F31 — the paid scenario is an entitlement gate, not a metering signal 🟢

**Claim.** `Gpt_6_Reasoning` serves only under `scenario=OfficeWebPaidCopilot` — on the
default included scenario it deflects with the canned BotConnection apology, exactly like
`Claude_Opus` (F26). It carries **no priority-access budget** and is throttled by the ordinary
per-conversation cap (§7) and thread-rate governor (F13) like every other tone.

**Why it matters more than one more model in the table.** F26/F27 landed together, so
`PAID_SCENARIO_TONES` had exactly one member and that member was scarce. Reading the set as
"the expensive models" was indistinguishable from reading it as "the gated models", and either
reading predicted the same behaviour. GPT-6 breaks the tie, and the two properties have to be
kept apart in code, not just in prose:

- **Metering** stays content-detected. `parsePriorityAccessExhaustion()` keys on the refusal
  text, not on the tone, so it simply never fires for GPT-6. Had it been gated on "is this a
  paid-scenario tone", GPT-6 would now be one bad regex away from 429-ing on a real answer.
- **Framing** stays per-tone. Opus takes `minimal` because its budget is the scarce thing
  (H15.1); GPT-6 keeps `baseline`, which is the right default twice over — nothing to conserve,
  and it drives M365's GPT path, which is what `baseline`'s anti-narration cage was tuned for.
  A `defaultFramingForTone` keyed on the paid scenario would have silently handed the GPT path
  the variant built for a model that doesn't need convincing.
  (Both later moved to `relay`, for unrelated reasons: GPT-6 in §22 F47, Opus in §24 F56.)
  **Superseded 2026-10-01 (§22 F45, F47):** GPT-6 never ran on the GPT agent path. Its tool
  requests now go agent-less and default to `relay` (30/30 vs baseline 0/30). The principle
  stands: the framing is still chosen per tone, not keyed on the paid scenario.

Both are now asserted by unit test rather than left as a reading of the comments.

**Confidence.** High on the gate (same deterministic shape as F26: one tone, two scenarios,
two outcomes). High on the absence of a priority-access budget as *reported* — but note this
is an absence, and absences are weaker evidence than the verbatim refusal strings that
established F27. The falsifier is cheap and will arrive on its own: a GPT-6 turn that comes
back as a successful turn whose text refuses on quota grounds. If that ever appears, the
detector already catches it — the wording is model-agnostic — and only this note is wrong.

### F32 — `Gpt_6_Chat` is REJECTED, where `Gpt_5_6_Chat` is registered-but-dead 🟢

Both generations ship reasoning without a chat variant, and the two absences look identical
from a "did the request fail?" distance while being different wire states (§12.15):
`Gpt_5_6_Chat` is accepted and deflects via `BotConnection`; `Gpt_6_Chat` errors outright with
`Failed to invoke 'Chat'`.

Neither is mapped, so the practical consequence is nil today — but the pair is the cleanest
illustration yet of why §12.15's rule is phrased as *require `DeepLeo`* rather than *check for
an error*. A tone table built by probing for errors would have caught `Gpt_6_Chat` and shipped
`Gpt_5_6_Chat`. `scripts/tone-probe.mjs` now carries both, plus GPT-6 on **both** scenarios, so
the gate is measured in a routine sweep instead of assumed from this note.

### Bench: 24/30, and why that doesn't make it the default

**Ran agent-less** (user, 2026-10-01). With the tool agent attached GPT-6 is a dead route, so the
shipped proxy, which attaches it to non-Claude tool requests, does not reproduce this score — §22 F45.

Tool calling scores **24/30**, with all six non-passing runs being prose give-ups — the model
narrating instead of acting — rather than Disengaged or malformed fences. That is the
failure shape `looksLikeConfabulation` + the confab-retry already target (F16), so the
recoverable-looking number may be better than 24/30 in practice. **Unmeasured:** how many of
the six the retry actually salvages. Worth a `--repeat` sweep with `M365_NO_CONFAB_RETRY=1` as
the control, which is the same methodology §12.11 needed to stop the retry from masking the
thing being measured.

`gpt-5.5-think-deeper` stays the recommended default and the no-model fallback: it benchmarks
higher (§12.10/§12.11) and needs no entitlement, so defaulting to GPT-6 would trade reliability
for a model most seats cannot reach at all.

---

## 18. Sep 24 2026 — `Gpt_5_6_Chat` was gated, not dead, and is now ungated

Shipped as `gpt-5.6` / `gpt-5.6-quick`. The tone itself is unremarkable; what it costs us is
§12.15's central example, and the reason it does is worth more than the model.

### F33 — the "registered but dead" state was an entitlement gate all along 🟢

**Claim.** `Gpt_5_6_Chat` has never been a dead route. Through the period §12.15 recorded it as
"registered but dead", it returned the canned `BotConnection` apology on
`OfficeWebIncludedCopilot` **and `DeepLeo` on `OfficeWebPaidCopilot`** — the exact two-scenario
signature F26 later established for `Claude_Opus`. As of 2026-09-24 it returns `DeepLeo` on the
included scenario too, so the gate has lifted and it needs no scenario override.

**Why the original probe couldn't have caught it.** §12.15 (Aug 6) predates F26, so this is not
a case of ignoring a known confound. Its controls were a known-good tone and a known-bad tone
**on the same scenario** — perfect for separating accepted from rejected, and structurally blind
to entitlement. The run came back clean, internally consistent, and wrong, because *a control
only rules out the alternative it varies.* The `BotConnection` apology was never a tone-level
fact: it is what this endpoint says when *this connection* may not have *that model*, and it
takes a second connection to interpret.

**Why it survived after F26, which is the part worth fixing.** F26 named this exact failure
mode — "**entitlement-gated**, indistinguishable at the wire from 'registered but dead' unless
you change scenario and re-probe" — and its own next-step (a) was *"probe the rest of the tone
table under the paid scenario."* That sweep was never run against `Gpt_5_6_Chat`. The evidence
is still sitting in `scripts/tone-probe.mjs`: F26 added scenario-paired cells for Opus, then
§17 added them for GPT-6, and §15 added them for `Claude_Fable` — every tone anyone was
actively unsure about — while the one tone already carrying a written verdict kept its single
included-scenario cell and a note that repeated the verdict. **A conclusion in the docs stops
being probed precisely because it is in the docs**, and a stale one is more expensive than an
open question: an open question invites a cheap probe, a verdict deters one. When a finding is
overturned by a later mechanism (F26), the cheap move is to re-run the new probe against
everything the old model classified — not only against the tones still under suspicion.

**Therefore "dead" is not a terminal state and must not be recorded as one.** The three-state
model (§5) describes wire signatures, not tone lifecycles. Of the two non-serving signatures,
only one can come good: `Gpt_6_Chat`'s validator error means the string does not exist, while a
`BotConnection` deflection means a route exists that this connection can't reach — which an
entitlement change, or Microsoft's rollout, can flip later. F32 read those two as a matched
pair illustrating one rule; they are better read as different-lifetime states, and this tone
is the proof.

**Shipped.** Mapped in `MODEL_TONES` and deliberately **absent** from `PAID_SCENARIO_TONES`
(unit-tested): requesting the paid scenario for a tone that serves on the included one would
be an entitlement request we don't need, and would misrepresent what the tone costs.
`scripts/tone-probe.mjs` now probes it on both scenarios so a re-gating shows up in a routine
sweep rather than as a mystery outage.

**Confidence.** High on the current state (deterministic: same tone, same account, both
scenarios `DeepLeo`). Medium on *when* the gate lifted — we have the before and after, not the
transition, so "since 2026-09-24" is when it was observed, not when it changed.
**Falsification.** An included-scenario probe that returns `BotConnection` again, which would
mean the gate is being rolled rather than removed; the paired probe cells are there to catch it.

### Bench: 10/30, and why a higher version number bought nothing

These are confab-retry-**on** runs from Sep 24–25. §19 re-ran both with the retry off: 16/30 vs
7/30, same order.

| tone | solved | M365 messages | messages per solve |
|---|---|---|---|
| `Gpt_5_5_Chat` | **25/30** | 73 | 2.9 |
| `Gpt_5_6_Chat` | **10/30** | 50 | 5.0 |

The newer chat tone solves **less than half** of what its predecessor does. Note the shape of
the message count before reading it as efficiency: spending *fewer total* messages while
solving *fewer tasks* is what giving up early looks like on this harness, since a prose
give-up ends the loop where a working loop keeps calling tools. The per-solve column is the
one that isn't flattering. **We have not separated "quits sooner" from "needs fewer turns
when it works"** — the outcome mix would settle it (a prose-give-up count per task, as §17 did
for GPT-6), and until someone runs that, the 50 is uninterpreted rather than good.

**Update (§19).** Settled by a confab-retry-off re-run, which scores 16/30 vs 7/30: it quits
sooner. 22 of `Gpt_5_6_Chat`'s 23 give-ups came before any tool call.

Both tones also self-identify as "the GPT-5 chat model", so self-report cannot tell them apart
and is not evidence about which generation is answering — the same caution `Claude_Fable`
earned in §15, one notch weaker: there the model lied about its family, here two genuinely
different routes give the same honest-but-useless answer.

**Consequence for defaults: none.** `gpt-5.5-think-deeper` remains the recommended default and
the no-model fallback. `gpt-5.6` is advertised because it is a real, reachable, entitlement-free
route and some users want the newest chat model for chat — not because it is a better agent.

---

## 19. Sep 28 2026 (UTC) — the `*_Quick` tones are retired; `*_Chat` replaced them

### F34 — `Gpt_Quick` and `Gpt_5_{2,3,4}_Quick` are REJECTED; each generation's `*_Chat` serves 🟢

**Claim.** Microsoft retired the `*_Quick` tones. `Gpt_Quick`, `Gpt_5_2_Quick`, `Gpt_5_3_Quick`
and `Gpt_5_4_Quick` now fail validation with `Failed to invoke 'Chat'`, just like the invalid-tone
control, while `Gpt_5_2_Chat`, `Gpt_5_3_Chat` and `Gpt_5_4_Chat` serve. With 5.5 and 5.6 already
on `*_Chat`, every generation from 5.2 to 5.6 is now a `*_Chat` + `*_Reasoning` pair. There is no
unversioned replacement: `Gpt_Chat` is rejected, and so is `Gpt_Reasoning`, which `think-deeper`
had mapped to since the first commit.

**Evidence.** `scripts/tone-probe.mjs`, three back-to-back sweeps, agent-less, `pong` prompt,
n=3 per cell (`scripts/tone-out/2026-09-28T02-26-58-952Z`, `…T02-29-57-569Z`, `…T02-32-48-953Z`):

| tones | verdict | `contentOrigin` | elapsed |
|---|---|---|---|
| `Gpt_Quick`, `Gpt_5_{2,3,4}_Quick` | REJECTED, 3/3 each | — | 1.3–1.6s |
| `Gpt_Chat`, `Gpt_Reasoning` | REJECTED, 3/3 each | — | 1.3–1.6s |
| `Definitely_Not_A_Real_Tone_XYZ` (control) | REJECTED, 3/3 | — | 1.3–1.6s |
| `Gpt_5_{2,3,4}_Chat` | LIVE, 3/3 each, `pong` | `DeepLeo` | 4.1–5.1s |
| `Gpt_5_{2,3,4}_Reasoning` | LIVE, 3/3 each | `DeepLeo` | 4.1–7.9s |
| `magic`, `Gpt_5_{5,6}_{Chat,Reasoning}` | LIVE, 3/3 each | `DeepLeo` | 4.1–8.1s |

Reproduced along the way, 3/3 each: F31 (`Gpt_6_Reasoning` is `BotConnection` on included,
`DeepLeo` on paid), F32 (`Gpt_6_Chat` rejected), and F33 (`Gpt_5_6_Chat` live on included).
Service version was not captured; tone-probe does not record it.

**What it broke.** Seven model IDs resolved to rejected tones: `quick`, `think-deeper`,
`gpt-5.4-quick`, `gpt-5.3`, `gpt-5.3-quick`, `gpt-5.2`, `gpt-5.2-quick`. A rejected tone surfaces
through the proxy as an **instant 502**: the `type:3` completion error rejects the stream and
`handler.ts` returns `upstream_error` without retrying. So each of those IDs could only fail,
while `copilot.ts` stated that "every entry here has been confirmed accepted against the live
API".

**Why nothing noticed.** No `*_Quick` tone has ever had a cell in `tone-probe.mjs`
(`git log -S _Quick -- scripts/tone-probe.mjs` is empty), so no routine sweep could see the
retirement. This is §18's lesson one level down. There, a verdict in the docs discouraged a
re-probe. Here, an entry in the mapping table did, because a mapped tone reads as settled.
**When** it happened is unknown for the versioned tones. For `Gpt_Quick` there are earlier
hints: §9 (June 14) logged "`quick` instant-502s with the agent", and F24's correction (July 7)
logged "`quick`/`Gpt_Quick` returned instant 502s (dead tone or throttle-onset)". An instant 502
is exactly what a rejection looks like, so `Gpt_Quick` was plausibly already gone in June. That
can't be re-measured now; it is the likelier reading, not a result.

**Correction to §18.** §18 argued that of the two non-serving states only `BotConnection` "can
come good", because a validator error means "the string does not exist". Its own case study
contradicts that: `Gpt_5_6_Chat` was *rejected* in June (§12.15's premise) before it was
registered. This entry is the same transition running the other way, live → rejected. The
narrower claim holds: no *entitlement* change makes a rejected tone serve, so there is nothing
to vary today. A rollout can still move a tone in either direction. The three states describe
what one connection sees now, not what a tone will do later.

**Shipped.** Seven `MODEL_TONES` values re-pointed. All 26 keys are kept, so no client config
changes.
- `gpt-5.4-quick` → `Gpt_5_4_Chat`, `gpt-5.3`/`gpt-5.3-quick` → `Gpt_5_3_Chat`,
  `gpt-5.2`/`gpt-5.2-quick` → `Gpt_5_2_Chat`. Same generation, chat for chat.
- `quick` → `Gpt_5_5_Chat`, `think-deeper` → `Gpt_5_5_Reasoning`. With no unversioned tone
  left, these had to pin a generation. They pin GPT-5.5 by maintainer preference over GPT-5.6:
  5.5 wins the chat half and the reasoning half is a tie (next subsection), so nothing argues
  for moving them.
- Unit tests (`copilot.test.ts`): no advertised ID resolves to a rejected tone or to any
  `*_Quick` tone, and all seven legacy IDs stay advertised. Run against the old table, 4 of
  them fail, as they should.
- `tone-probe.mjs` gained cells for `Gpt_5_{2,3,4}_{Chat,Reasoning}` and
  `Claude_Sonnet_Reasoning`. It now ends with a `MAPPED:` line that checks every tone
  `MODEL_TONES` maps against its cell on the scenario the proxy routes it to, and prints
  `MAPPED BUT NOT LIVE` / `MAPPED BUT UNPROBED` for any that fail. Replayed offline against these
  sweeps, the old table scores 9/17 LIVE and names all seven broken IDs. The new table scores
  12/15; the three Claude tones are unprobed because these sweeps had no Claude cells. No
  `*_Quick` cells were added: the Chat tones replaced them permanently, so there is nothing to
  probe them for.

**Confidence.** High on the current state: deterministic across three sweeps, and the retired
tones are indistinguishable from the invalid-tone control. **Not measured:** tool-calling on
the re-pointed IDs. `Gpt_5_{2,3,4}_Chat` have not been benchmarked. `quick` now simply is
`gpt-5.5` (16/30 with the confab-retry off, next subsection).
**Falsification.** A re-pointed tone going non-LIVE in a later sweep. The `MAPPED:` line names
it.

### Bench: GPT-5.5 wins the chat half; the reasoning half is a tie

Four runs on 2026-09-28 with the confab-retry **off** (`M365_NO_CONFAB_RETRY=1`), so every
first-try give-up counts. Same 10 tasks × 3 reps and system prompt throughout
(`scripts/bench/out/*-no-confab-2026-09-28T*`):

| model ID | tone | solved | prose give-ups (before any tool call) | errors | M365 msgs | s per msg |
|---|---|---|---|---|---|---|
| `gpt-5.5-think-deeper` | `Gpt_5_5_Reasoning` | **26/30** | 4 (4) | 0 | 72 | 16 |
| `gpt-5.6-think-deeper` | `Gpt_5_6_Reasoning` | **27/30** | 2 (1) | 1 | 68 | 20 |
| `gpt-5.5-quick` | `Gpt_5_5_Chat` | **16/30** | 14 (8) | 0 | 69 | 21 |
| `gpt-5.6-quick` | `Gpt_5_6_Chat` | **7/30** | 23 (22) | 0 | 39 | 25 |

**Reading it.** The chat gap holds: 16 vs 7 gives a two-sided Fisher exact p ≈ 0.03, and the
earlier retry-on pair (Sep 24–25, §18) had the same order, 25 vs 10. The reasoning half is a
tie: 26 vs 27 gives p = 1.0, and the earlier retry-on pair (Sep 23) had it the other way round,
30 vs 28. An order that flips between runs is what a tie looks like, so the reasoning bench
gives no reason to prefer either generation. Both aliases and the recommended default stay on
GPT-5.5 by maintainer preference, which keeps them on the generation that wins the chat half.
This also closes §12.14's open question: at 27/30, GPT-5.6's reasoning tone is as strong as
5.5's. Its deficit is in the chat tone, so "GPT-5.6 is worse at agentic work" (§18) is true of
`Gpt_5_6_Chat`, not of GPT-5.6 as a whole.

**It answers §18's open question too.** §18 couldn't tell whether GPT-5.6 Chat's low message
count meant it quits sooner or needs fewer turns when it works. It quits sooner: 22 of its 23
give-ups came before any tool call. On the tasks it did solve it used 2.1 messages against
GPT-5.5 Chat's 2.9, so it is slightly leaner when it works, but its low total mostly reflects
the 22 tasks that ended at turn 1.

**Caveats.** One run per arm, and the order wasn't rotated: both 5.6 arms ran before either
5.5 arm. The one error is a real `Disengaged` (the handler only emits that 502 on
`messageType: "Disengaged"`): 5.6-think-deeper on `edit-config`, rep 0, at turn 1. That is the
substitution-shaped task Prompt Shields is known to trip on (F17/F22).

**Open lead: the confab detector sees about two-thirds of real give-ups.** With the retry off,
all 43 prose give-ups are visible, and `looksLikeConfabulation` flags 27 of them. The retry's
two other detectors (remote-artifact, and hallucinated-completion before any tool call) catch
none of the rest, so the handler's full retry trigger also stands at 27. That was tested
offline on the text the bench records (the first 120 chars, `run.mjs:180`), so it's a lower
bound: up to 16 give-ups would get no retry even with it on. 13 of the 16 misses are vocabulary
gaps in patterns that already cover the idea:
- the can't-access pattern has no optional `directly` ("I can’t directly access or modify files");
- the can't-edit pattern needs `file(s)` right after the verb, so it misses a backticked
  filename (``modify `settings.txt` ``), an adjective ("edit local files") and paired verbs
  ("create or modify files"), and its verb list lacks `generate` ("I can’t generate a file");
- the tools-unavailable pattern misses a leading negation ("no filesystem or shell tool is
  available") and the phrase "no longer available".

The other 3 are a different class. Two are GPT-5.5 Chat refusing `find-needle` as a request to
"disclose secret values, credentials, access codes". The task asks for a `SECRET_CODE=` value,
so those two rows measure the model's refusal to disclose a "secret", not its tool use. The
third is advise-instead-of-act ("The bug is in `calc.py` … It should be:"). One hunch is
**falsified**: M365's U+2019 apostrophes don't break the patterns. All 8 apostrophe-bearing
positive unit cases still match with U+2019, because the patterns spell it `can.?t`. Widening
the patterns is a separate change and needs false-positive tests ("Replaced X with Y in
calc.py" is a genuine completion). Afterwards, re-run with the retry on and compare against
this table to measure what it recovers.

### Side observations (uninterpreted, n=3 each)

- **Latency signatures drifted.** Rejections took 1.3–1.6s and the `BotConnection` deflection
  took 2.5–3.1s, against the ~0.25–0.3s and ~1.6s given in §5 and §12.15. The ordering holds
  (rejected < deflected < live), and tone-probe classifies on error / `contentOrigin`, not
  latency, so nothing breaks. Both states shifted by roughly a second, which looks like
  per-connection overhead: `_probe-chat.mjs` starts its clock at socket creation, so `elapsedMs`
  includes connect + handshake from this host. §12.15 doesn't record how it timed. Untested;
  timing from the chat-frame send would settle it.
- **Reasoning tones answered fast.** Every `*_Reasoning` tone answered `pong` in 4–8s, level
  with the chat tones. §12.14/§12.15 timed `Gpt_5_6_Reasoning` at 20–24s on the same prompt, and
  §5 says 10–30s. Either reasoning got faster on trivial input, or those tones now send trivial
  input down a fast path. Latency can't separate the two; a prompt that needs reasoning would.
  Connection overhead can't explain it either, since that would make today's numbers *slower*.
  The bench points the same way at task scale. Per M365 message, the 5.5/5.6 reasoning tones
  took 16s/20s against 21s/25s for the chat tones (table above). That's a different workload,
  so it corroborates this rather than confirms it.

---

## 20. Sep 28 2026 — Claude bench forensics: proxy bugs found in the frame dumps

Found while working out why Claude Sonnet scored low on the bench. Each finding below is a
deterministic proxy bug, fixed and unit-tested; the evidence is the 2026-09-28 frame dumps.

### F38 — Multi-message turns lost the head of every message after the first 🟢 (#29)

A turn can carry several bot messages (distinct `messageId`s). Each message's first token arrives
only as a snapshot (with a `cursor` naming it); its `writeAtCursor` deltas carry no id. The
single-string fold ignored the second message's head (shorter than the accumulated answer) and
glued its deltas onto the first: `"…to find the SECRET_CODE.bash\ngrep -r …"` — the fence's
opening backticks were the dropped head, so a real tool call became GAVE_UP_PROSE (live, Claude
Sonnet 4.6, bench `find-needle`). Offline replay of every frame dump from that day: **every**
multi-message turn was corrupted (Sonnet 4.6: 9/9; Claude on the paid scenario: 4/4), usually as
garbled prose ("Let me fix that now.python\` tool runs…"). Affects every model's answers.
**Shipped:** `TurnTextComposer` (`session.ts`) assembles text per message, routing deltas by the
last cursor and snapshots by `messageId`; unit-tested on the verbatim live frame sequence.
Checked: all 5,971 deltas in the day's dumps follow a cursor naming a *content* message — none a
`Progress`/chain-of-thought one — so routing by cursor can't fold reasoning into the answer.

### F39 — Sonnet 4.6 writes its own `<tool_response>` in about half its turns 🟢 (#31)
**38 of 80** turns in one Claude Sonnet 4.6 bench run (`claude-sonnet`, included scenario)
contain a model-written `<tool_response>`, 36 of them right after a real fence; the same tone on
the paid scenario: 0 of 154. The model writes its call and keeps going, inventing the result it
expects and acting on it. The invented results pile up extra fences and prose, the document
guard returns the turn as text (13 turns in that run; at least 7 provably fabricated — the log
truncates at 1 kB), and the real first action is lost.
**Shipped (1): a stop sequence.** `truncateAtFabricatedToolResponse` cuts at the first
self-written tag when a real call to one of the request's tools precedes it. It fired 11× in a
single later 4.6 run.
**Shipped (2): a note.** Cutting isn't enough. M365's server-side history still holds the whole
reply, so the model believes its invented results happened and reads the real one as stale: 4 of
one run's 10 tasks ended "It looks like this tool response came in out of context — there's no
active task" / "the task is already complete!" after only its `cat` ran. So when the proxy runs
less than the model wrote (a cut invented result, or batched calls dropped by one-call-per-turn),
the next tool result is prefixed with `executedOnlyFirstNote`: "(Note: only the first tool call in
your previous reply was actually run. Everything you wrote after it, including the
`<tool_response>` you wrote yourself, did not happen. Here is the real output…)". One turn only.
**Result.** Counting that failure shape directly, across both framings under test and excluding
throttled rows: **9 of 56** Sonnet 4.6 runs ended with the model believing its invented tail had
happened before the note, **0 of 70** after it (p = 5×10⁻⁴). GPT-5.5-think-deeper on the same
build: 9/10, no regression.

### F41 — The document guard was mostly discarding correct first actions 🟢 (#33)
`isProseDocument` (F15) judged the WHOLE reply: 2+ tool fences plus 300+ chars of prose, or a
heading, or 4+ fences → "a written document, don't execute". Sonnet 4.6 routinely opens with the
right action and keeps writing — a second fence, a change of heart ("I'm Microsoft Copilot, I don't
have a shell"), a markdown answer with `## Expected Output` — so the tail made the whole reply look
like a document and the correct first action was thrown away. Across every debug log from Sep 28
on three accounts, **34 of 42** guard verdicts were replies whose text before the first tool fence
was empty or a one-liner. None of the 42 was a real document (every bench task demands an action).
**Shipped:** a reply that *opens* with a tool call (preamble under 200 chars, no heading, no code
fence before it) is an action; its tail is speculation, dropped by one-call-per-turn and flagged
to the model by the F39 note (which now also fires on a tail of 120+ chars after the call).
Anything else falls through to the old rule unchanged, so the F15 README fixtures (a heading
before the first fence) still come back as text. Unit-tested on the live shapes.
**Live result:** on the build with this change, three Sonnet 4.6 bench runs across two accounts
(30 tasks) produced **0** guard verdicts, the note fired 18 times, and 26 of 30 tasks were solved.

### F40 — M365 says when it throttles: `result.value = "Throttled"`, `errorCode = "PerUserThrottled"` 🟢 (#35)
F13 treated thread-rate throttle as silent ("empty 503s, no Disengaged"). It isn't: the final
`type:2` item carries `result: {value:"Throttled", errorCode:"PerUserThrottled", message:"We're
temporarily unable to respond to this volume of requests. Please try again later."}` and a
`BotConnection` bot message with that text, after an EarlyProgress frame and ~26 s of silence. 41
such turns on Sep 28, all after ~190 fresh threads on the premium account (182 with frame dumps)
and ~60 on a second account (which throttled independently — hence *per user*); none in any
earlier dump. The proxy ignored `item.result`, so each throttled request burned **3 upstream
attempts** (two "quick retries" into the throttle) and ended in a 502 blaming a content filter.
**Shipped:** `stream.result`; the handler returns **429** `code: "m365_throttled"` (`param:
"PerUserThrottled"`) after one attempt and feeds the degradation backoff. It is checked before
the content check, so a throttle apology can never pass for an answer. Verified live: a throttled
premium account answered 429 in ~27 s, one attempt. Recovery time is still unmeasured.

---

## 21. Sep 28 2026 — Claude Sonnet 5: its own sandbox, a `<system>`-tag injection defense, and the `relay` framing (#37)

**Premise (user).** `Claude_Sonnet` moved from Sonnet 4.5 to **4.6** on the included scenario, and
under `OfficeWebPaidCopilot` the same tone is **Sonnet 5**. Sonnet 5 scored **5/30** on the bench
(confab-retry off) while working fine in the user's own pi session.

All bench numbers below: 10 tasks × n reps, `M365_NO_CONFAB_RETRY=1`, service `1.0.0355x`.
Raw data (local to the machine that ran them, not in the repo): `~/.config/opencode-m365/s5-sweep/`
(per-arm debug logs + frame dumps) and `scripts/bench/out/s5a-*`, `s5b-*`, `s46*-*`. The proxy bugs
these runs surfaced are in §20 (#29, #31, #33, #35).

### F35 — One tone, two models 🟢
`Claude_Sonnet` self-IDs as "Claude Sonnet 4.6; Anthropic; 2025-08" on the included scenario and
"Claude Sonnet 5; …; 2026-01" on the paid one (user's tone-probe ×3; reproduced through the proxy
as "Microsoft (based on Claude Sonnet 5 by Anthropic); 2026-01"). Both read LIVE (`DeepLeo`), so
§12.15's liveness rule can't see this — a scenario can change *which model a tone is*, not only
*whether it serves*. **Shipped:** `claude-sonnet-5` (+ `claude-sonnet-4.6`) model IDs;
`PAID_SCENARIO_MODELS` / `getScenarioForModel` so the scenario follows the **model ID**
(`PAID_SCENARIO_TONES` can't express it without dragging `claude-sonnet` onto Sonnet 5 too);
`isSonnet5Model` catches unmapped `claude-sonnet-5[1m]`-style strings. `licenseType` is irrelevant
(user-confirmed; F26).

### F36 — Sonnet 5 brings its own tools, and no client knob turns them off 🟢
It has a real function-calling toolset — `bash_tool`, `create_file`, `str_replace`, `view` (named
in its own reasoning) — in a **remote sandbox**: cwd `/home/claude`, uploads `/mnt/user-data/uploads`,
outputs `/mnt/user-data/outputs` (handed back as Teams artifact links). Wire: `Progress` frames with
`contentType:"Code"` (command in `hiddenText`) or `contentOrigin:"CreateFileExecutor"`.
**Hypothesis falsified:** that the code-interpreter optionsSets gate it (Sonnet 4.6's sandbox *is*
the M365 code interpreter: 22 `GeneratedCode/CodeInterpreter` frames in the user's 4.6 run, 0
`bash_tool`). `scripts/sonnet5-native-tools-probe.mjs`, "run `pwd`": proxy optionsSets, **no**
optionsSets, bare request (no plugins, minimal variants) → a native `Code` frame and `/home/claude`
each time; `Progress` undeclared → no frames, but still `/home/claude` after a tool-length pause
(10.7 s), so undeclaring hides the sandbox rather than disabling it (n=1 per cell).
So the failure is choice of path, not capability — a framing problem.

### F37 — `<system>` tags inside the user turn read as a forged system prompt 🟢
Sonnet 5 streams `ChainOfThoughtSummary` frames, which say *why* it rejects a framing. Under
`baseline` it flagged "prompt injection" / "fake system prompt" on **21/37** first turns of the
user's run (8/10 in sweep 1), then worked in its own sandbox: 23/37 first turns went native, and
reported (truthfully) that the files don't exist — or created them there and returned a Teams
link, which the remote-artifact guard turns into the 502s the user saw.

**Sweep 1** (n=10 per arm, one proxy, control-file switching, order honest→relay→baseline→terse→retag):

| arm | solved | first turn fenced / native | CoT injection-flagged |
|---|---|---|---|
| `baseline` (control) | 1/10 | 1 / 9 (+2 Disengaged) | 8/12 |
| `terse_user` — one-line user-voice note | 2/10 | 3 / 7 | 8/11 |
| `honest` — user voice, explains the harness | 7/10 | 5 / 5 | 5/10 |
| `retag` — **baseline text byte-for-byte**, tags renamed | 9/10 | 9 / 1 | **0/10** (CoT on only 3) |
| `relay` — "guide me through my terminal, one command at a time" | **10/10** | 9 / 1 | 1/10 |

**The label, not the text, is the trigger:** the same aggressive baseline text goes 1/10 → 9/10
once it stops calling itself `<system>`, and the model mostly stops deliberating at all.

**Confirmation** (fixed build, `default` = the shipped `relay`, rotated order; the account hit
F40's `PerUserThrottled` from rep 3 onward, so throttled rows are excluded):

| framing | solved (all valid reps) | vs baseline (Fisher, two-sided) |
|---|---|---|
| `baseline` (user's 3 reps + sweep 1) | 6/40 (15%) | — |
| `retag` (10 + 10 + 5 valid) | 20/25 (80%) | p = 2×10⁻⁷ |
| **`relay`** (10 + 10) | **18/20 (90%)** | **p = 2×10⁻⁸** |

`relay` vs `retag`: p = 0.44, a tie on score. **Shipped `relay`** as Sonnet 5's default
(`defaultFramingForModel`) on mechanism: `retag` gets turn 1 right but, when a harness command
comes back unhelpful, falls back to `bash_tool` mid-loop ("…search more broadly using bash_tool
directly, since the harness bash tool didn't return useful output") — its text never says the
sandbox is the wrong machine. `relay` names it, and the reason persists through the loop; it is
also ~70% shorter (1.3k vs 4.4k chars). (Sonnet 4.6 later moved to relay too — F42.)

**Final check of the shipped default** (same protocol as the user's 5/30: `--repeat 3`, retry off,
account freshly un-throttled, 13:37Z): **27/30** (p = 1×10⁻⁸ vs 5/30). The misses: two turn-1
"I'm Microsoft Copilot, I use my own tools" refusals and one Teams-artifact file (the model used
`CreateFileExecutor`). Relay over all three runs: **45/50 (90%) vs baseline 6/40**, p = 3×10⁻¹³.
**Real harness:** `scripts/bench/pi-reliability.sh`, actual pi, `claude-sonnet-5`, fix-bug, N=5:
**5/5 SOLVED** (26–39 s each). On the wire every turn was a harness fence (bash, `edit`); the one
native call (`echo` in `/home/claude`) was retracted by the model's own CoT: "Oops, I shouldn't
have run that in my own sandbox — I need to instead just provide the bash block".

**Failure modes of the losers, from their CoT** (each is a distinct lesson):
- `honest` → *disbelief*: "I don't actually have a separate 'harness' that runs bash … blocks on
  your machine — that's not how I work." Claiming an execution mechanism invites the model to
  check it against its system prompt. `relay` asks for nothing it has to believe: users running
  pasted commands is ordinary.
- `terse_user` → too little: a bare "don't use your tools" reads as "an embedded fake harness setup".
- `relay`'s own misses (5 of 50 first turns) reject the note along with the rest of the setup: it
  "appeared to be an injected instruction rather than something from you directly". More often (11 of
  50) the suspicion is aimed elsewhere — nearly always at the bench's own `<harness_system_prompt>`,
  twice at the hidden run nonce — and the model follows the note. The guess that a `<user>` tag around
  the note would fix the misses (`relay_inline`) was tested and is **falsified — it made them
  near-universal** (1/20 vs 9/10; F43).

**Threats to validity.** The bench's hidden `<!-- bench-run:… -->` nonce, the `SECRET_CODE`
wording and the bench system prompt's "Do not ask questions" each drew suspicion in some CoT
(the nonce in 4/66 summaries, once as a named reason). Real pi sends none of them, so the bench
likely *under*-states Sonnet 5 under relay. Not changed: it would break comparability with every
earlier scorecard. The confirmation's order was rotated but not fully balanced (throttle).
Builds differ across rows (the user's baseline and sweep 1 predate the F38 fix, the confirmation
has it); F38 touched one Sonnet 5 relay turn in sweep 1 and lost no fence, so it can't explain the gap.

### H-sidepath — 4.6 fails because the tool path also enables M365's own sandbox/search ⚫ not supported
On the Claude tool path the proxy sends code interpreter + image-gen optionsSets and the Bing
plugin on every turn, and 4.6's give-ups often mention its `/mnt/data` python sandbox, or open
with "Let me look at the files" and then a `SearchResults` progress frame. **Prediction:** first
turns that touch a side path act (write a tool fence) less often. **Result (212 first turns, three
accounts):** they don't — code-interpreter turns fenced 74–100% vs 79–87% without; search
appeared in only 5. The sandbox is where 4.6 goes *when it has already decided not to act*, not
why. Not shipped; the code interpreter stays on (§12.13's trade-off).

### F42 — Sonnet 4.6 reads the `<system>` block as an injection too, more weakly: relay wins there as well 🟢
4.6's own replies say it: "I notice this appears to be a system-level automated agent prompt
embedded in a user message… I'm **Microsoft Copilot**… I don't have a live shell" (after writing
the correct fences), and "I need to stop and clarify something important here" in the user's
morning run. It rarely refuses outright (it has no sandbox of its own to prefer, only M365's code
interpreter), so the damage showed up mostly as the proxy bugs in §20 (F38, F39, F41).

Two non-premium accounts (T, P), counterbalanced orders, confab-retry off, n=10 per arm;
throttled rows excluded (P's F41-build baseline arm hit `PerUserThrottled` and is dropped):

| build | `relay` | `baseline` |
|---|---|---|
| F38 composer | 17/20 | 13/20 |
| + F39 stop sequence | 23/30 | 13/26 |
| + F39 note | **20/20** | 13/20 |
| + F41 guard (final) | 18/20 | 8/10 |
| **all builds** | **78/90 (87%)** | **47/76 (62%)** |

Decision rule, fixed before the final-build runs: switch 4.6 only if relay ≥ baseline on the
final build **and** the pooled comparison stays at p < 0.05. Both hold (18/20 vs 8/10; pooled
p = 3×10⁻⁴; relay ≥ baseline within every build and on both accounts). **Shipped:**
`defaultFramingForTone("Claude_Sonnet") = "relay"`, so 4.6, Sonnet 5 and unmapped `claude-*`
strings all default to it. Against the user's morning 4.6 run (15/30) that is p = 9×10⁻⁵.
**Real harness:** pi, `claude-sonnet`, fix-bug, final build: **3/3 SOLVED** (52–60 s).
`claude-sonnet-think-deeper` and Opus are unmeasured under relay and keep their defaults.

**Open leads.** (a) Relay names *Sonnet 5's* sandbox (`bash_tool`, `/home/claude`); 4.6's is the
python code interpreter (`/mnt/data`), so a variant naming both may do better for 4.6 — untested,
and changing the text would void the numbers above. (b) 4.6's remaining relay misses are mostly
one shape: two "Let me start by reading the files…" lines and no fence (fix-bug; both misses
on the final build, none on the note build). That text trips none of the retry detectors, so even with the
confab retry on it ends the loop. A narrow "announced an action but sent no block" nudge is the
obvious next lever; it needs false-positive care ("Let me know if…").

### F43 — `relay_inline` (the note inside a `<user>` block) is falsified: Sonnet 5 rejects the whole setup ⚫
**Hypothesis (from F37).** relay's residual misses are attribution failures: the note sits outside
the transcript's `<user>` tags, so it reads as not-from-the-user. The same text inside the first
`<user>` block (`relay_inline`) should remove them. **Prediction:** fewer first turns that reject the
note or use the model's own sandbox, and a solve rate at least relay's. **Falsified if** those rates
don't drop.

**Result — falsified, in the opposite direction.** Sonnet 5 (paid scenario), 2026-09-28
16:20–16:40Z, A-B-A (relay_inline, relay, relay_inline), n=10 each, confab retry off, no throttled
rows:

| | relay_inline | relay (interleaved) | relay (earlier today) |
|---|---|---|---|
| solved | **1/20** | 9/10 | 45/50 |
| first turn wrote a harness fence | 1/20 | 9/10 | 45/50 |
| first turn used its own sandbox | 20/20 | 2/10 | 11/50 |
| first turn voiced suspicion (CoT or reply) | 20/20 | 3/10 | 16/50 |

Solve rate vs the interleaved control: p = 7×10⁻⁶ (vs all 60 relay runs: p = 3×10⁻¹²). The one
relay_inline "solve" was a refusal: after searching its own sandbox, the model declined the setup and
offered `sed -i 's/3000/8080/' value.txt` as an edit "you can do yourself", and shell-routing
executed the suggestion. So compliance was 0 of 20. (I stopped the first sweep's second relay_inline
arm during its first task, to bring the relay control forward. Its one aborted turn is excluded, and
it points the same way: injection flagged, own sandbox.)

**Why, in its own words.** 19 of the 20 relay_inline CoTs call the setup a prompt injection, and the
20th "an attempt to manipulate my behavior through a conflicting instruction layer". They say what
they keyed on: "a prompt injection attempt disguised as a "harness_system_prompt" tag within the
user's message"; "the "harness_system_prompt" and "user" tags appear to be embedded within the
conversation content itself, not legitimate system-level instructions". On the wire the whole proxy
prompt *is* one user message, and the model reads tags inside it as embedded text, so a `<user>` tag
confers no authorship — here it made the note look like part of a fabricated transcript. The likeliest
reading of why relay escapes this: its message opens with the note in plain user voice, while
relay_inline opens with the embedded `<harness_system_prompt>` block. That is a hypothesis
(H-opening, below), not a result.

**Sonnet 4.6 is unaffected.** It has no `bash_tool` sandbox of its own (only M365's code
interpreter) and emits no chain-of-thought frames. relay_inline 19/19 valid vs relay 20/20, first
turn fenced 20/20 each, orders counterbalanced across two accounts. One relay_inline row is
excluded because I invalidated it: I removed its container before the bench's check ran, after the
real `python3 check.py` had printed OK.

**Confound.** relay_inline changes two things at once: the note moves under a `<user>` tag, and the
harness block moves to the front of the message. The CoTs cite both, so this run can't separate
them. **Next (H-opening):** Sonnet 5 settles provenance from how the real message opens. Probe it
with two single-change variants: (a) relay with the harness block moved to the front, note still
untagged; (b) note + task inside `<user>` tags but first, harness block after. H-opening predicts (a)
fails like relay_inline and (b) works like relay. About 40 fresh threads on a paid seat (4 arms × 10
tasks, alternating with relay controls).

**Removed:** relay stays the default, and relay_inline was deleted after this test. It was the only
variant with its own code path in `formatMessages`, and it never landed on `main`. Setting
`M365_FRAMING_VARIANT=relay_inline` now silently renders `baseline`, so rerunning F43 means
re-adding a variant that emits this layout, which differs from relay only in where the note and
the harness block sit:

```
relay                                   relay_inline
─────                                   ────────────
{relay note}                            <harness_system_prompt>
<tools>…</tools>                        {harness system message}
<harness_system_prompt>                 </harness_system_prompt>
{harness system message}                <user>
</harness_system_prompt>                {relay note}
<user>                                  <tools>…</tools>
{task}                                  {task}
</user>                                 </user>
```

Raw data (local, not in the repo):
`~/.config/opencode-m365/s5-sweep/inl5-1-*` and `inl5b-*` (Sonnet 5), `inl46T-*` and `inl46P-*` on
the two other accounts, bench JSON under each checkout's `scripts/bench/out/inl5*` / `inl46*`.

---

## 22. Oct 1 2026 — which tones the tool agent honours (`agent-tone-probe.mjs`)

**Question.** §5's warning ("the declarative agent overrides the tone and forces GPT-5", June 2026,
H8.6) is why the proxy keeps Claude tool requests agent-less (`handler.ts`, `useToolAgent`). Is it
still true, and what does the agent do to the tones that *do* take it?

**Method.** `scripts/agent-tone-probe.mjs`: one fresh thread per cell, agent attached exactly as
`session.ts` attaches it (`threadLevelGptId` + `gpts[]`), a self-ID prompt instead of `pong`, and
`gptIdentifiers[].compliantAgentName` checked so a reply the agent didn't handle can't count.
`--baseline` repeats each cell agent-less. Service `1.0.03559.55742`. Two accounts in one tenant:

- **Premium**: two runs (05:53Z, 12 cells; 05:56Z, 3 cells × `--baseline`).
- **Non-premium**: two runs by the user (08:12Z and 08:47Z, 12 cells each, agent `T_9cc0f1d6…`).
  The two runs agree cell for cell.

No throttling. Raw data (local, not in the repo): `scripts/agent-tone-out/<timestamp>/` in each
account's checkout.

| tone @ scenario | premium, agent | non-premium, agent | premium, agent-less |
|---|---|---|---|
| `magic`, `Gpt_5_5_Chat`, `Gpt_5_6_Chat` @ included | GPT-5 chat model | GPT-5 chat model | — |
| `Gpt_5_5_Reasoning`, `Gpt_5_6_Reasoning` | GPT-5 reasoning model | GPT-5 reasoning model | — |
| `Gpt_5_6_Chat` @ paid | GPT-5 chat model | **unlicensed** (2/2) | — |
| `Gpt_6_Reasoning` @ paid | **dead: BotConnection, `InternalError`** (2/2) | **dead: BotConnection, `InternalError`** (2/2) — not unlicensed, see F46 | "GPT-6 reasoning model" (1/1) |
| `Claude_Sonnet` @ included | **"Claude Sonnet 4.6"** (2/2) | **dead: BotConnection, `InternalError`** (2/2) | "Claude Sonnet 4.6" (1/1) |
| `Claude_Sonnet` @ paid | **"Claude Sonnet 5"** (1/1) | **unlicensed** (2/2) | — |
| `Claude_Opus` @ paid | **"Claude Opus 5.5"** (1/1) | **unlicensed** (2/2) | — |
| invalid-tone control | rejected | rejected | — |

"Unlicensed" = `result: ForbiddenRequest`, `errorCode: InvalidCopilotLicense` (F46). Every answered
agent cell carried `compliantAgentName: 3PDeclarativeAgent`, and the control was rejected on both
accounts, so the agent path still validates `tone` and the rows are about the tone.

### F44 — whether the agent lets Claude through depends on the account 🟡
**Premium:** with the agent attached, `Claude_Sonnet` self-IDs as Sonnet 4.6 (included, 2/2) and
Sonnet 5 (paid, 1/1), and `Claude_Opus` as Opus (1/1). The Claude replies also open differently from
the GPT ones ("Microsoft Enterprise Copilot, based on…" vs "M365 Copilot, based on the GPT-5 chat
model"), which is hard to explain with a GPT model claiming to be Claude.
**Non-premium:** `Claude_Sonnet` on the included scenario is a dead route with the agent attached
(BotConnection apology, `result: InternalError`, 2/2). The paid cells can't be read: the account has
no paid licence (F46).
Neither account reproduces June's *silent* switch to GPT-5: premium gets Claude, non-premium gets
nothing.
**Consequence for the proxy:** Claude tool requests stay agent-less. On non-premium accounts it is
the only path that reaches Claude: F42's non-premium bench numbers (relay 78/90) are agent-less.
**Not tested:** whether Claude tool-calls better or worse *with* the agent on a premium account
(bench A/B, `M365_FORCE_AGENT=1` vs default).
**Confidence:** 🟡. Premium: 4 Claude cells. Non-premium: 2 readable Claude cells. Self-ID only, one
service build.

### F45 — `Gpt_6_Reasoning` has never worked with the agent 🟢
Agent attached → dead route (BotConnection apology, `result: InternalError`) on both accounts (4/4).
Agent-less → DeepLeo, "GPT-6 reasoning model" (1/1). This is not a regression: GPT-6 has never served
with the agent, and §17's 24/30 bench ran agent-less (user, 2026-10-01).
The shipped proxy, though, attaches the agent to every tool request on a non-Claude tone
(`handler.ts` `useToolAgent`; `SessionPool` defaults to `useAgent`). So `gpt-6-think-deeper` tool
requests hit the dead route. Reproduced on the premium account (`proxy-verify.mjs --agent --tools
--model=gpt-6-think-deeper`, 06:21Z): `InternalError` on the first try and on both "Please
continue." retries, then a 502. The 24/30 suggests the fix: route GPT-6 tool requests agent-less, as
Claude's already are (#41).
**Shipped (#41):** `toneUsesToolAgent()` / `AGENTLESS_TOOL_TONES` in `copilot.ts` decide which tool
requests carry the agent: not Claude tones, not `Gpt_6_Reasoning`. `M365_FORCE_AGENT=1` still
overrides. Routing alone wasn't enough, though: see F47.

### F46 — the paid scenario on a non-premium account: `ForbiddenRequest` / `InvalidCopilotLicense` 🟢
On the non-premium account, `Gpt_5_6_Chat`, `Claude_Sonnet` and `Claude_Opus` on the paid scenario
(6/6 across two runs, agent attached) returned `result.value: "ForbiddenRequest"`,
`errorCode: "InvalidCopilotLicense"`, a BotConnection reply "It looks like you don't have a valid
licence. To get access, please check with your administrator…", in ~2.5 s. This is distinct on the
wire from the dead route (`InternalError` + "Sorry, I wasn't able to respond to that"), and it is
about the account, not the tone or the agent: `Gpt_5_6_Chat` serves on the same account under the
included scenario. The probe classifies it as `UNLICENSED`.
**Exception: `Gpt_6_Reasoning`.** On the same account and scenario it returns its dead-route
`InternalError` instead (2/2). With the agent attached, GPT-6's dead route answers before any licence
check does, so an `InternalError` on the paid scenario doesn't mean the account is licensed.
**Open:** (a) agent-less on the same account — expected identical, since it is the scenario that's
refused, but unmeasured; (b) what the proxy does with it. It only special-cases `Throttled`
(`handler.ts`), and this refusal carries reply text, so `claude-sonnet-5` / `claude-opus` /
`gpt-6-think-deeper` on a non-premium account probably return the licence message to the client as
a 200 "answer". That's the same failure class as the Opus quota refusal (F27). Untested.

### F47 — agent-less GPT-6 needs `relay`: baseline 0/30, relay 30/30 🟢
**Trigger.** With the #41 routing in place, `proxy-verify.mjs --tools --multiturn
--model=gpt-6-think-deeper` on the default `baseline` framing returned no tool call. GPT-6 had run
`cat /etc/hostname` itself, in M365's code interpreter, and answered "The hostname is
`SandboxHost-639264422355109436`". Re-run with `M365_FRAMING_VARIANT=relay`: tool call, PASS. The user's
Sep 30 bench had already scored relay + no agent at 30/30
(`scripts/bench/out/gpt-6-think-deeper-relay-no-agent-no-confab-*`).

**Sweep.** `scripts/bench/sonnet5-sweep.sh`, `MODEL=gpt-6-think-deeper`, one proxy with the #41 build,
`M365_NO_CONFAB_RETRY=1`, 10 tasks × 6 arms in the order default, baseline, baseline, default,
default, baseline (`default` = the new shipped default, i.e. relay), 60 s between arms, premium
account, 09:16–10:07Z. No throttled rows.

| | `relay` (default) | `baseline` |
|---|---|---|
| solved | **30/30** | **0/30** |
| outcomes | SOLVED 30 | GAVE_UP_PROSE 18, ERROR 12 |
| first turn wrote a harness fence | 30/30 | 0/42 requests |
| first turn worked in the code interpreter | 0 | 30 |
| Disengaged (JailBreak Classifier) | 0 | 12/30 first turns |

Fisher two-sided: p = 1.5×10⁻¹⁴. The 42 baseline first-turn requests are the 30 tasks plus the 12
Disengaged ones re-sent by the F22 retry with `softened` in a fresh conversation. 11 of the 12 ERRORs
are the remote-artifact guard (the model wrote the file to `/mnt/data` and offered it back), and 1 is
a bench client timeout. The prose give-ups are the model reporting, truthfully, on its own sandbox:
"I couldn't find `config.json` in the working directory, so no changes were made. Upload the file…".

**What the sandbox is.** M365's code interpreter, which the proxy enables on the agent-less path
(`CODE_INTERPRETER_OPTIONS_SETS`): Progress frames with `contentOrigin: CodeGenerator` running
`bash -lc pwd; ls -la; …` / `find / -name config.json …`, and Python writing to `/mnt/data/…`. Not a
Sonnet-5-style `bash_tool` / `/home/claude` toolset (F36). relay's note names Sonnet 5's tools and
paths, not `/mnt/data`, and works anyway.

**Shipped:** `defaultFramingForTone("Gpt_6_Reasoning") = "relay"`. This supersedes §17's "GPT-6 keeps
`baseline`", which assumed GPT-6 ran on the GPT agent path that baseline was tuned for.

**The Sep 22–23 runs failed differently.** Their give-ups were "I can't run shell commands or access a
real filesystem in this chat" and secret-refusals on find-needle. None mentions a working directory,
and 24/30 solved. Today's baseline give-ups describe a filesystem the model searched. So either GPT-6
has started using the code interpreter since then, or something else changed between the builds (the
Sep runs probably had the confab retry on). 🟡, not separated.

**Real harness: 5/5 SOLVED.** `scripts/bench/pi-reliability.sh`, actual pi, `gpt-6-think-deeper`, shipped
defaults (no framing or agent overrides), fix-bug, N=5, 60 s cooldown, 10:06–10:16Z: 5/5 SOLVED in
39–72 s. On the wire, every one of the 25 turns (5 per run, streaming) went agent-less, every first
turn used `relay`, and there were no Throttled, Disengaged or remote-artifact turns. No frame in the
run came from the code interpreter or the jailbreak classifier.

**Open.** Would `M365_NO_CODE_INTERPRETER=1` alone rescue baseline? Untested; relay already scores
30/30. (Untested for GPT-6 itself; for GPT-6 Sol the answer is no — its sandbox runs without the
code-interpreter optionsSets, 0/20, §23 F50.)

## 23. Oct 2 2026 — GPT-6 Sol (`Gpt_6_Sol_Reasoning`, #23): ungated, the agent only on premium, a sandbox of its own, and `relay`

**Question.** #23 reports a new tone, `Gpt_6_Sol_Reasoning` ("GPT 6.0 Sol" in the web client, which
doesn't call it Think Deeper). Is it real, which accounts and scenarios serve it, does it take the
tool agent, and which framing makes it drive a coding loop? Shipped as `gpt-6-sol`.

**Raw data** (local, not in the repo): the user's probe runs in `scripts/tone-out/` and
`scripts/agent-tone-out/` (2026-10-02T10-36…10-44Z) in the premium account's checkout and one
non-premium account's checkout, re-read from disk against the pasted logs before use (they match,
including the raw `result` items in the frames). Sweeps: `~/.config/opencode-m365/g6sol-sweep/` in
each of the three checkouts (bench text, debug log and frames per arm). Service `1.0.03560.56027`.

### F48 — live on the included scenario on every account; `Gpt_6_Sol_Chat` is the GPT-5 chat model 🟢
`tone-probe` (agent-less): `Gpt_6_Sol_Reasoning` → `DeepLeo`, "M365 Copilot (GPT-6 reasoning model)",
premium 4/4 (2 runs × included/paid), non-premium 2/2 (included). So unlike `Gpt_6_Reasoning` (F31)
it is **not** entitlement-gated and stays out of `PAID_SCENARIO_TONES`.
`Gpt_6_Sol_Chat` is accepted and live too, but self-IDs as "GPT-5 chat" / "GPT-5.5" / "GPT-5" in
6/6 agent-less and 6/6 agent-attached turns across both accounts. Same shape as `Claude_Fable`
(accepted, answers as something else), so it is not mapped; `tone-probe.mjs` keeps a cell for it.
**Uninterpreted:** the self-reported knowledge cutoff splits by path: premium agent-less "2025-12"
(4/4); premium with the agent and non-premium agent-less "2024-06" (4/4, 2/2). A self-reported cutoff
is weak evidence (a different system prompt would do it), but it is consistent within each cell.
Probe idea: ask about a dated 2025 event with web grounding off, per cell.

### F49 — with the agent: premium serves it, non-premium gets the dead route 🟢
`agent-tone-probe`: premium `SUPPORTED` 4/4 (both scenarios, `3PDeclarativeAgent`, self-ID GPT-6);
non-premium `REGISTERED_BUT_DEAD` 2/2 (BotConnection apology, final `result: InternalError`,
~2.85 s). A third pattern next to F44/F45: GPT-6 is dead with the agent everywhere, Claude Sonnet
and GPT-6 Sol split by account.
**Nothing on the token tells the accounts apart.** The substrate access tokens of the two accounts
carry the same claim set (scopes, `acrs`, `xms_*`), no licence or SKU claim. So the proxy finds out
by trying (`PREMIUM_ONLY_AGENT_TONES`, handler fallback): the first tool request on the tone carries
the agent; an `InternalError` with no content marks the route dead for the process and the whole
request is re-sent agent-less in a fresh conversation. Live: non-premium `proxy-verify --agent
--tools`: dead route detected in 2.9 s, re-sent agent-less. Over the sweeps the fallback fired once
per proxy process on the non-premium accounts (4 processes, 4 fallbacks, every later request went
agent-less from the start) and never on the premium one (agent on all 132 turns of its 6 agent arms).
`M365_FORCE_AGENT=0` (new) skips the probe turn; `=1` disables the fallback.

### F50 — agent-less, GPT-6 Sol has a sandbox of its own, and `M365_NO_CODE_INTERPRETER` doesn't remove it 🟢
Agent-less turns show `Progress` frames "Coding and executing" whose `hiddenText` is the command:
`bash -lc find /mnt/data /home/oai -name check.py -o -name calc.py …`, `bash -lc pwd; ls -la; cat
calc.py …`. Files it creates come back as Teams `asyncgw` links ("Created [fizzbuzz.py](…) and ran
it with `python3`"), which the proxy's remote-artifact guard fails closed (the bench's `ERROR`s).

| arm | sandbox turns / turns |
|---|---|
| agent attached (premium), all 6 framings | **0 / 132** |
| agent-less, every non-relay framing (10 arms, 2 accounts) | 10–11 per 10-task arm (of 11–19 turns) |
| agent-less, `baseline` + `M365_NO_CODE_INTERPRETER=1` (2 arms) | 10 / 14, 10 / 14 |
| agent-less, `relay` (3 arms, incl. premium with `M365_FORCE_AGENT=0`) | 0 / 32, 4 / 31, 2 / 33 |

The `@noci` arms had no `cwc_code_interpreter*` optionsSets on the wire, and the sandbox ran anyway,
so it isn't the code interpreter the proxy enables (F47's reading for GPT-6), or at least not only
it. Forensics note: most of these turns carry **no** `contentOrigin: CodeGenerator`; counting that
origin finds ~1 per arm. Count `"Coding and executing"` Progress frames instead.

### F51 — framing sweep: `relay` wins on both paths 🟢
`M365_NO_CONFAB_RETRY=1`, 10 tasks per arm, 60 s between arms, one account per column, run in
parallel across accounts (sequential within each), 11:43–13:05Z. No `Throttled` turns.

| framing | premium, agent | non-premium A, agent-less | non-premium B, agent-less |
|---|---|---|---|
| `relay` | **10/10** | **10/10** | **10/10** |
| `demo_only` | 9/10 | 3/10 | 6/10 |
| `minimal` | 7/10 | 0/10 | 0/10 |
| `session_facts` | 6/10 | 0/10 | 0/10 |
| `baseline` | 3/10 | 0/10 | 0/10 |
| `react` | 3/10 | 0/10 | 0/10 |
| `baseline` + no code interpreter | — | 0/10 | 0/10 |
| `relay`, premium, `M365_FORCE_AGENT=0` | 10/10 | | |

B ran the arms in the reverse order of A. Agent-less: relay 30/30 vs the best other arm (demo_only)
9/20, Fisher p = 4.5×10⁻⁶; vs everything else 9/120, p = 7×10⁻²⁴. With the agent: relay 10/10 vs
the rest pooled 28/50, p = 0.0095, but vs demo_only alone p = 1.0 at n = 10 — hence the
confirmation below.
**How the others fail.** With the agent there is no sandbox; every non-relay failure is the old
confabulation, "I can't access the working directory from this chat", 3 of them *after* a
successful `cat` ("I can see `config.json` has `"port": 3000`, but I can't edit the working
directory"), plus 1–4 JailBreak-Classifier Disengages per arm (0 under relay). Agent-less the
failures are the sandbox (F50): "`config.json` isn't available in the working directory. Please
upload the file", or a Teams link to a file it made there. relay sidesteps both: the user runs the
commands, so the model needs no belief about its own access, and the note names "your own sandbox
tools" as the wrong machine.
**Agent or not, on premium?** Both 10/10 under relay, so the agent isn't a measured win at the
default. It stays on for premium because it removes the sandbox entirely (0 vs 2 of 33 turns), and
because every other framing degrades far less with it (3–9/10 vs 0–6/10), which matters to anyone
who overrides the framing.
**Shipped:** `defaultFramingForTone("Gpt_6_Sol_Reasoning") = "relay"`, one default for both paths
(since §28 F71: `relay_batch`, the same user voice in fewer turns).

### F52 — the premium account produces the dead route's exact wire state too, as a one-off 🟢 (fixed)
In the confirmation round (`g6s-paid2`, premium, agent attached, `demo_only` arm 2, 13:32Z) one
mid-conversation turn (turn 1, after the agent had answered turn 0 with a tool call) came back as
BotConnection "Sorry, I wasn't able to respond to that", `result: InternalError`, no content —
byte-for-byte the non-premium dead route (F49). The F49 fallback read it as "not premium", switched
the process agent-less, and the rest of that arm ran agent-less into the sandbox (2 remote-artifact
ERRORs). One in ~250 premium agent turns that day; never seen in the user's probes or the first sweep
(0 in 132 agent turns).
**Fix:** `noteAgentRouteAlive` — the first answered agent turn on a tone marks its route alive for
the process, and from then on an `InternalError` is a transient and goes through the ordinary
empty-reply retry, like on any other agent tone. A non-premium account never sees an answered agent
turn for this tone, so its fallback is unchanged. Remaining exposure: a transient on a premium
account's *first* agent turn still flips that process agent-less; it then runs `relay` agent-less,
which scored 10/10 on the premium account (F51), so it degrades to the other working path rather
than failing.

### Confirmation round + real pi (13:13–14:25Z, 3 accounts in parallel, sequential within each)
The machine lost connectivity from ~13:34 to ~13:42Z. Everything in that window is excluded
(`WS error: connection failed` on every attempt, nothing reached M365): a whole premium `default`
arm (0/10, all ERROR), premium pi fix-bug run 1, and non-premium pi multi runs 2–5. Those cells were
re-run at 14:10–14:25Z on a build with the F52 fix (the "re-run" column).

| | premium, agent | premium, agent (re-run) | non-premium A | non-premium A (re-run) | non-premium B |
|---|---|---|---|---|---|
| `default` (= `relay`) bench | 10/10 | 10/10 | 10/10 | | 10/10, 10/10 |
| `demo_only` bench | 8/10; 4/6 before F52 cut in | | | | |
| real pi, fix-bug | 4/4 | 1/1 | 5/5 | | |
| real pi, multi (2-file bug) | 5/5 | | 1/1 | 5/5 | |

On the wire: premium `default` 60 agent turns over the two arms, 0 agent-less, 0 sandbox, 0
Disengaged, 0 `InternalError`; premium pi 59 turns, all with the agent. Non-premium: one dead-route
fallback per proxy process (5 processes, 5 fallbacks), every later request agent-less from the start;
1 sandbox turn in 94 bench turns under relay, 0 in pi; 0 Disengaged. No `Throttled` turn anywhere.

**Totals for the shipped default (`relay`), both rounds:**
- Agent-less bench: 50/50 on the non-premium accounts, plus 10/10 on the premium account with
  `M365_FORCE_AGENT=0` — 60/60 vs `demo_only` 9/20, p = 1.6×10⁻⁸ (and 0/10 for everything else).
- Agent (premium) bench: 30/30 vs `demo_only` 21/26 (the clean 6 of the cut arm counted), p = 0.017.
  demo_only's failures are the same "I can't edit the working directory from here" confabulation as
  in F51.
- **Real pi: 21/21** — premium (agent) fix-bug 5/5, multi 5/5; non-premium (agent-less, via the
  fallback) fix-bug 5/5, multi 6/6. 39–153 s per run.

**Re-derived with `scripts/bench/analyze-arms.mjs`** over the three archives (it maps each task to
its conversation and drops tasks lost to the network): agent 30/30 vs `demo_only` 21/26 (p =
0.017) and the per-arm sandbox counts of F50 reproduce exactly, as does every exclusion above. One
difference: it counts the premium `demo_only` arm's post-F52 tail (4 tasks, 1 solved) under
agent-less, since that is the path that served them, so agent-less `demo_only` is 10/24 and the
comparison p = 6×10⁻¹⁰ (relay 60/60 either way).

## 24. Oct 4 2026 — Claude Opus 4.5: `Claude_Opus` on the included scenario, through the tool agent only

**Question.** The user's probes on the premium account (2026-10-02/04) show `Claude_Opus` answering
on the *included* scenario when the tool agent is attached — and identifying as Claude Opus 4.5, not
the paid scenario's Opus 5.5. Is it a usable second Opus, which accounts serve it, does it draw on the
priority-access budget, and which framing makes it drive a coding loop? Shipped as `claude-opus-4.5`;
`claude-opus` (Opus 5.5, paid) moves onto the agent and the same framing with it.

**Raw data** (local, not in the repo): the user's runs in `scripts/agent-tone-out/` and
`scripts/tone-out/` (2026-10-01…10-04) in the premium account's checkout and one non-premium account's
checkout, re-read from disk (results and frames) against the pasted logs before use — they match.
Bench: `~/.config/opencode-m365/sweeps/opus45*/` in the premium checkout (bench text, debug log and
frames per arm). Services `1.0.03559.55742` … `1.0.03562.56583`.

### F53 — the agent is Opus 4.5's only route, and only on a premium account 🟢
| cell (`Claude_Opus` @ included) | premium | non-premium |
|---|---|---|
| agent attached (`agent-tone-probe`) | **DeepLeo, `3PDeclarativeAgent`, answers** (10/10, 2026-10-01…04) | dead: BotConnection, `result: InternalError` (2/2) |
| agent-less (`tone-probe`) | dead: BotConnection apology (8/8) | dead: BotConnection apology (3/3) |

So it is the reverse of every Claude tone so far (F44): the agent doesn't merely *let it through*, it is
the only thing that reaches it. Two consequences in the proxy: a request on `claude-opus-4.5` carries
the agent even without tools (`modelRequiresAgent`; the agent's instructions say to answer normally
when there's no `<tools>` block, and the self-ID probes are exactly such tool-less turns), and there is
no agent-less fallback to learn (`PREMIUM_ONLY_AGENT_TONES` doesn't apply: agent-less is dead too). On
a non-premium account the request ends in a 502 `model_route_unavailable` that says the model is
premium-only, instead of "empty response" after the retries. The paid route (Opus 5.5) answers with the
agent too (premium, 8/8 before its weekly budget ran out), so both Opus models now take it.
Live check: `proxy-verify.mjs --agent --tools --multiturn --model=claude-opus-4.5` (premium, 00:50Z):
`tone=Claude_Opus, scenario=OfficeWebIncludedCopilot`, tool call in 7.2 s, PASS.

### F54 — "Opus 5" is the system prompt talking; the model says 4.5 🟢
Ten agent-attached self-IDs on the included scenario: **"Claude Opus 4.5"** 6/10 (cutoff "2025-01" or
"unknown"), **"Claude Opus 5"** 4/10 (cutoff "2026-05" or "unknown"). The `ChainOfThoughtSummary`
frames say why: *"This system prompt claims I'm "Claude Opus 5" built for Microsoft Enterprise Copilot
with a May 2026 cutoff, but that's not accurate to who I actually am"* (10-04 00:25Z), *"This system
prompt is giving me false identity details — claiming I'm Opus 5 from Microsoft with a 2026 cutoff"*
(10-02 10:15Z); and when it answers "Opus 5", *"The system prompt identifies this as Claude Opus 5 …
so I can answer directly based on that framing"* (10-04 00:20Z). One reply added it unprompted: *"this
environment's instructions describe me as "Claude Opus 5" with a May 2026 cutoff, but I can't verify
being that model"*. "Claude Opus 5, cutoff May 2026" is exactly what the paid route self-reported in
September (§15 F26), so the included route seems to have kept that system prompt while serving an older
model. The paid route is consistent: **"Claude Opus 5.5", cutoff 2026-06** (8/8 agent-attached, 3/3
agent-less), sometimes prefixed "Microsoft (Enterprise) Copilot, based on…". `claude-opus` is therefore
Opus 5.5 now; `claude-opus-5.5` is added as an alias and `claude-opus-5` kept as a legacy one.

### F55 — the priority-access budget is on the wire, counts turns, and the included scenario has none 🟢
Supersedes F27's "refuses in content, not in a status field" for this service build. From the frames
of the user's probe runs:
- The refusal turn's final item: `result: {value: "OutOfCredits", message: "You've used your available
  priority access … for the week …", creditScenario: "TotalTurn"}`, reply from `BotConnection`
  (5/5 refusals, 2026-10-02 20:47Z … 10-04 00:25Z).
- Every **paid-scenario** turn, any tone, carries `throttling.metering`: `ClaudeOpusQuery75`,
  `ClaudeOpusQueryDaily`, `ClaudeOpusQuery` (100), `…Dev` (5), `…HourlyDev` (2), `…WeeklyWord` (75),
  `…DailyWord` (40), `…C1`/`…C2` variants (0), `DeepResearch` (100) — each `{remainingAllowance: n}`.
- Each paid Opus turn, agent or not, lowers **`ClaudeOpusQuery75` and `ClaudeOpusQueryDaily` by exactly
  1** (read after the turn); Sonnet 5 turns on the same scenario lower neither. On 10-02 the probes
  took `ClaudeOpusQuery75` from 8 (10:15Z) to 0 (20:45Z) and `ClaudeOpusQueryDaily` from 40 to 32 —
  8 Opus turns: 5 agent-attached cells with frames, and one gap of exactly 1 for each of the 3
  agent-less tone-probe runs in between (tone-probe keeps no frames). The next Opus turn got the
  **"for the week"** refusal: `ClaudeOpusQuery75` is the weekly allowance. `ClaudeOpusQueryDaily` was
  back at 40 on 10-04 (UTC): the daily one, 40 per day. Refused turns lower neither counter.
- **The weekly allowance is 75**, as its name says: the first Opus turn after the Monday reset
  (2026-10-05 00:01Z, the smoke test below) read `ClaudeOpusQuery75` 74 and `ClaudeOpusQueryDaily`
  39, the second 73 and 38.
  Earlier in the week `ClaudeOpusQuery75` stood at 19 (10-01 05:53Z), and it dropped by more than the
  probes account for between 10-01 08:13Z and 10-02 10:15Z: other Opus use on the account.
- **Included-scenario turns carry no `metering` object at all** (every `Claude_Opus` @ included cell,
  every `Claude_Sonnet` @ included cell), consistent with the user's report that Opus 4.5 has no daily
  or weekly limit.

**H15.1 settled: the budget is per turn.** One unit per turn regardless of prompt size, and the server
calls the scenario `TotalTurn`. So `minimal`'s 82% smaller prompt could never have saved quota — which
is what the user observed ("`minimal` was ineffective at addressing Opus's daily and weekly limit").
The only quota lever is fewer turns, i.e. a framing that finishes tasks in fewer round trips, or
`claude-opus-4.5` where it is good enough.
**Done (2026-10-05, F59):** the proxy now keys on `result.value === "OutOfCredits"` and
`result.message`, and surfaces the two allowances in `usage`. That turned out to be a bug fix, not
hardening: the daily refusal is never streamed, so the text-only detector never fired on the live
wire (F59).

### F56 — framing sweep: solve rate at ceiling, the jailbreak classifier decides → `relay` 🟢
`phase-sweep.sh`, `MODEL=claude-opus-4.5`, premium account, agent attached on every turn
(`3PDeclarativeAgent`), `M365_DEBUG=1 M365_DUMP_FRAMES=1 M365_NO_CONFAB_RETRY=1`, 10 tasks per arm.
Five sweeps, four of them cut short by the thread-rate throttle (F58), so arms ran in several
orders: `opus45` (00:51–01:12Z), `opus45-r2` (02:18–02:52Z), `opus45-r3` (03:58–05:01Z, 300 s
between arms), `opus45-r4` (06:46–07:00Z), and the confirmation round `opus45-r5`, in mirrored order
retag, relay, softened, softened, relay, retag (`TASK_GAP=30`, 120 s between arms, the first F57
parser fix in). r5 stopped at the throttle in its 4th arm (07:56Z) and was finished from where it
stopped, with the same settings: `opus45-r5b` (that arm's 4 untried tasks, 09:50Z) and `opus45-r5c`
(relay, retag, 09:54–10:13Z). Pooled with `analyze-arms.mjs`; throttled tasks excluded.

| arm | solved | tasks with a Disengaged turn | failed on it | M365 turns / task | fresh conversations / task |
|---|---|---|---|---|---|
| `minimal` (old default) | 30/30 | **12/30** | 0 | 3.43 | 1.40 |
| `baseline` | 30/30 | **8/30** | 0 | 3.43 | 1.27 |
| **`relay`** | 47/50 | **0/50** | 0 | 3.56 | 1.00 |
| `softened` | 30/30 | **0/30** | 0 | 3.40 | 1.00 |
| `demo_only` | 17/17 | 2/17 | 0 | 3.41 | 1.12 |
| `retag` | 29/30 | 1/30 | **1** | 2.87 | 1.07 |
| `terse_user` | 13/16 | 3/16 | **3** | 3.06 | 1.38 |

- **Opus 4.5 solves almost everything under any framing**, so the bench can't rank framings by
  solve rate. No sandbox turns anywhere (0/~600 turns): with the agent attached there is no code
  interpreter.
- **What separates them is the JailBreak Classifier** (every Disengaged turn came from it). The two
  `<system>`-tagged rule framings 20/60 vs relay + softened 0/80 (p = 5.1×10⁻⁹). The F22 retry
  rescued those 20 (no solves lost), but each costs a dead turn and a second fresh conversation
  (1.27–1.40 conversations per task instead of 1.00) — the budget F58 runs out of — and on Opus 5.5
  maybe a priority-access unit too (unknown whether a Disengaged turn counts).
- **A framing without `<system>` tags has no escape hatch.** The retry swaps a `<system>`-tagged
  framing for `softened` but keeps any other one, so `terse_user` (3/3) and `retag` (1/1, r5
  edit-config) disengaged twice and failed with a 502. relay never got there (0/50).
- **Which tasks:** the classifier fires on find-needle, edit-config and ec-notes — "find the secret" /
  "edit the config" prompts under rule-heavy framing.
- **F22's additive shape again:** `retag` (baseline's text in `<harness_instructions>`) 1/20 vs
  baseline 8/30; `softened` (`<system>` tags, no override language) 0/26.
- **relay's three failures were all F57 parser misses**, all on count-lines (round 1, r2, r5c); the
  current parser turns all three into the tool call Opus meant. Relay is also the arm that left the
  fence unclosed most often (3 of its 5 count-lines runs; 0 of softened's 3), so it's the arm most
  exposed if Opus finds yet another way to end a call.
- **The full confirmation round (r5 + r5b + r5c, mirrored order):** relay 19/20, retag 19/20,
  softened 20/20. Disengaged: relay 0, softened 0, retag 1 (failed).

**Shipped then: `defaultFramingForTone("Claude_Opus") = "relay"`, for both Opus models** (since
replaced by `relay_batch`, F60). relay vs softened
is a tie on this bench (47/50 vs 30/30, p = 0.29, both 0 Disengaged; softened is the fallback if that
changes); relay because it has no `<system>` tags,
which Sonnet 5 reads as an injection (§21) — and Opus 5.5, which takes this default too, couldn't be
benched then (weekly budget spent; F55; 10/10 after the reset, F59). It is also the default of every other Claude and GPT-6 model now.

**Opus 5.5 with the agent and relay: smoke test passed** (2026-10-05 00:01Z, right after the weekly
reset; `proxy-verify.mjs --agent --tools --multiturn --model=claude-opus`, debug log + frames). Turn 1:
`tone=Claude_Opus, scenario=OfficeWebPaidCopilot`, agent attached (`3PDeclarativeAgent`), relay note,
no `<system>` tag → a clean ```` ```read_file ```` call in 6.9 s. Turn 2: the tool result used,
"The hostname is **web-prod-01**." (8.2 s). `result: Success` both turns, no Disengaged, no native
markup. Its chain of thought on turn 2 checked the result's provenance: *"This tool result came from
the user turn, so it's fine to use."* — the question relay's user-voice framing is built to answer.
Cost: 2 priority-access units (weekly 75 → 73, daily 40 → 38). n = 1 conversation; not benched.
Archive: `sweeps/opus55-smoke/`.
`minimal` existed to save priority access by being short (H15.1), which F55 shows it can't.

**Real pi with the shipped default: 10/10.** `opus45-pi` (09:12–09:26Z), `pi-reliability.sh` through
`phase-sweep.sh`, no framing override: fix-bug 5/5, multi (2-file bug) 5/5, 29–32 s per run. On the
wire: 60 streaming turns, every one `Claude_Opus` on the included scenario with the agent, relay on
every first turn, no `<system>` tag, 0 Disengaged, 0 throttled, no `</invoke>` leak.


### F57 — Opus ends some fenced calls with its native call markup (`</invoke>`, `</parameter>`) 🟢 (fixed)
11 raw replies across the Opus 4.5 sweeps, all on the count-lines task, in relay, baseline,
demo_only and retag arms (0 in the 60 real-pi turns). Opus ends a fenced call the way its native
function-calling format ends one. Five shapes, verbatim tails:
````
```write_file              ```write_file              ```bash
path: count.sh             path: count.sh             cat > count.sh <<'EOF'
                                                      …
#!/bin/bash                #!/bin/bash                cat -A count.txt
wc -l < data.txt | … > …   wc -l < data.txt | … > …   </parameter>
</invoke>                  </invoke>                  </invoke>
∂   (or U+200C, or none)   <parameter name="path">count.sh</parameter>
```   (sometimes missing)                             </function_calls>
````
— plus the same with `</write_file>` (the tool's own name) or a bare `</parameter>` as the closer.
**What it cost:** with the closing fence present, the markup became the file's last line or the
command's last line (a bash syntax error after the real work had run, so the bench still scored it
SOLVED; in a real repo it's a corrupted file). In r3's relay arm Opus noticed: *"The write picked up a
stray line — fixing it:"* — and wrote `</parameter>` into the file again. Without the closing fence
(4 of 11, three of them under relay) there was no closed fence, the reply went back as prose, and the
task failed (relay's 3 failures).
**Fix** (`fenced.ts`, `stripNativeCloser` / `findUnclosedToolFence`): a body whose trailing lines are
all native markup (`<parameter …>`, `</parameter>`, `<invoke …>`, `</invoke>`, `</function_calls>`,
`</TOOLNAME>`) or short junk, and include a closer, has them dropped, and an unclosed fence that ends
that way is accepted as a call. An unclosed fence with no such ending is still rejected (it could be
a truncated reply), and markup followed by real content stays in the content. The first version (after
round 1) handled only a closer on the last line; r5c showed two more shapes, one of which it accepted
but left `</parameter>` in the command. Replaying all 11 replies through the current parser with the
bench's tool definitions: 11 calls, no markup left in any argument. Unit tests use the replies verbatim.
Not seen in any Sonnet or GPT sweep log.

### F58 — four throttles in one day on the premium account; a fixed "N per 30 min" doesn't fit, a per-turn bucket might 🟡
Every fresh conversation and every turn the proxy (and the user's probes) sent on the premium account
on 2026-10-04, against the first `Turn result: Throttled (PerUserThrottled)` of each episode:

| onset | fresh conversations in the preceding 15 / 30 / 60 min | turns in the preceding 30 / 60 min | throttle seen until |
|---|---|---|---|
| 01:10Z | 32 / 47 / 78 | 133 / 164 | 01:11Z (sweep stopped) |
| 02:35Z | 38 / 45 / 45 | 127 / 127 | 02:52Z (user stopped it) |
| 04:35Z | 20 / 42 / 55 | 126 / 159 | 05:01Z (the sweep kept going, every task throttled) |
| 07:56Z | 16 / **31** / 47 | 106 / 148 | 07:56Z (sweep stopped itself, `TASK_GAP=30`) |

It lifted within ~1 h of the last throttled turn every time, kept firing for as long as requests
kept coming (26 min in r3), and the 07:56Z onset hit a turn in the middle of a conversation, not a
fresh one.

**No fixed window explains it.** The first three onsets looked like "~45 conversations per 30 min",
but r5 tripped at 31 while running at half the pace, and other stretches of the same day reached 46 in
30 min without a throttle. The same holds for every window from 30 to 180 min, counting either
conversations or turns: some clean stretch always matches or beats an onset.

**A token bucket over turns fits all four onsets.** Model: the account holds a bucket of C turns
that refills at r per minute; each turn (fresh or not, Disengaged included) takes one; a throttle
starts when it's empty. A grid fit over the day's events puts every predicted onset within a minute
of the real one, with no throttle predicted anywhere else: **C ≈ 100 turns, r ≈ 1.6/min (~100/h)**.
Counted in conversations instead, the best fit misses by 97 minutes in total. That's 2 parameters
fitted to 4 onsets, so this is a hypothesis, not a finding.
**Out of sample** (the same C and r, earlier sweeps on the same account, which never ran this hot for
this long): GPT-6 Sol 10-02 (165 turns in 51 min, bucket bottoms out at 18) and GPT-6 10-01 —
predicted no throttle, none happened; Sonnet 09-28 — predicted a marginal dip below zero (−5) at
~12:28–12:44Z; the log has one isolated throttled turn at 13:22Z. Not refuted, not confirmed.

**This also undercuts the "Opus-only" reading** of the first three onsets (those other sweeps did reach
~50 fresh conversations in 30 min, but never drained a 100-turn bucket), so the model-specific
explanation is now one candidate of several: (a) a per-turn bucket on the account, as above; (b) a
budget specific to `Claude_Opus` or its route; (c) weighting by model cost; (d) a limit that moved
between 10-02 and 10-04. Other use of the account outside these logs would bias everything here.

**Probe that separates them (cheap in threads): one conversation, many turns.** On a rested account,
send short turns in a SINGLE conversation at a fixed 4 turns/min with GPT-5.5. Under (a) it throttles
at ~40 min (~160 turns: 100 + 1.6·t = 4·t); under F13's "conversations, not messages" it never does.
Then, after a rest, the same with `claude-opus-4.5`: an earlier onset means (b)/(c). Needs a new
sequential single-thread script; `throttle-probe.mjs` opens a fresh conversation per turn and fires
them concurrently. If (a) holds it matters for real use: a long pi session at a turn every ~10 s
would drain the bucket in ~25 min. Until one of these runs, none of it goes into AGENTS.md.

**Predictions, written down before the runs.**
- `opus45-pi` (09:12–09:26Z, written after, so not a test): 60 turns in 14 min from a full bucket;
  the model has it bottom out at ~63. No throttle happened.
- Finishing r5 (`opus45-r5b` + `opus45-r5c`, from 09:50Z, ~84 turns at r5's ~3.5 turns/min plus two
  2-min cooldowns, starting from a bucket the model puts at 100): bottom at ~60, **no throttle**.
  A throttle during it falsifies C ≈ 100 / r ≈ 1.6 as fitted, or the per-turn model itself.
  **Outcome: held.** 75 turns 09:50–10:13Z (3.2/min), the model's bucket bottomed at 63, no throttled
  turn. Weak evidence, though: the run also stayed under every conversation count that tripped
  before (~25 fresh conversations in 30 min vs 31 at r5's onset), so a conversation-count rule
  predicted the same. The single-conversation probe above is still what would tell them apart.

**Out of sample on two NON-premium accounts (2026-10-05, parameters NOT refitted).** Replaying
C = 100, r = 1.6 over every turn in each account's debug logs from a framing sweep (bench at
`TASK_GAP=30`, then real pi at a 60 s cooldown, ~260 turns in ~100 min each):
- account T: the model empties the bucket at 08:12:06Z (turn 259); the first `Throttled` turn was
  08:12:38Z (turn 260).
- account P: the model bottoms out at **5.9** at 08:06Z and never quite empties; the first
  `Throttled` turn was 08:07:42Z (turn 244).
Both onsets land within a few turns of the premium account's fit, on accounts it was never fitted
to. A conversation count does worse: the pi arms that tripped it opened conversations *more slowly*
(one per ~100 s) than the bench arms before them (one per ~70 s). Still a model with 2 parameters, now
6 onsets; it says the limit is the same on premium and non-premium accounts.
**Prediction, written 08:35Z before it resolved:** the premium account's bucket was at 7.7 at 08:28Z,
and the two remaining arms of its sweep (`rb-g6s-prem`, GPT-6 Sol) add ~50 turns in ~25 min against
~40 refilled — the model says about −2: a throttle **likely near the end of arm A-4** (≈ 08:55–09:00Z).
No throttle through the end of that arm counts against it (weakly — the margin is a few turns).
**Outcome: held on the arm, early on the clock.** The throttle came at 08:45:47Z, on the third task
of A-4, ~10 min before the window, with the model's bucket at **3.5**. So all three of that day's
onsets came with the model at +3.5, +5.9 and −1.3: about right, a few turns optimistic. Either the
bucket holds ~95 rather than 100, or a few turns a day are invisible to the logs.

**Shipped (bench only, opt-in): pacing.** With `M365_AVOID_THROTTLING=1`,
`scripts/bench/turn-budget.mjs` replays every recent proxy debug log on the account (`[session] Chat
turn` and `Turn result: Throttled` lines) through this bucket, and `run.mjs` / `pi-reliability.sh`
wait before each task until it covers a whole task (12 turns) plus a reserve of 20, and for an hour
of quiet after a throttled turn. Off by default; the `M365_BUDGET_*` variables tune the model.
Replayed over the premium account's 2026-10-05 logs, the gate closes at ~07:40Z (bucket 31), an hour
before the 08:45Z onset. pi arms now stop on a throttle too, as bench arms already did. Nothing in the
proxy changed: a real pi session still isn't paced.

**The hour's hold was too short once: the throttle isn't the bucket.** The premium account sent nothing
after its 08:45:47Z throttled turn (all logs checked), the pacer resumed at 09:45:47Z with the bucket
modeled at ~96, and the first turn was throttled again (09:45:50Z). The non-premium accounts were
served again 56.6 min (T) and 60.1 min (P) after their last throttled turns, 74 and 83 min after their
onsets. So the throttle is a state with its own clock, not an empty bucket: lifting 60–74 min after the
*onset* fits all three; a fixed time after the *last* throttled turn doesn't (T ≤ 57, premium > 60)
unless it differs per account. The hold default is now 75 min. Next check: whether the premium account
serves at 11:00:50Z (75 min after 09:45:50).
**It did:** the first turn at 11:00:50.8Z was served (GPT-6, relay_batch pi run 1, solved). So on the
premium account the throttle lifted between 60.05 and 75 min after its last throttled turn, with
nothing sent in between.

**Bench changes (useful whatever the limit is):** `run.mjs --task-gap S` (phase-sweep `TASK_GAP`)
paces tasks, and both now stop at the first throttled task instead of burning the rest of the sweep
(`[bench] THROTTLED`, exit 3; phase-sweep writes `FAILED`).

**Contamination, excluded (round 1):** a `pnpm test` run during the first relay arm inherited
`M365_DEBUG=1` and wrote the unit tests' scripted throttles/dead routes into that arm's debug log
(00:59:55–01:00:06Z). The archived log has those lines removed; the original sits next to it as
`*.with-unit-test-noise.log.orig`. Don't run the unit tests with `M365_DEBUG` set during a sweep.

### F59 — Opus 5.5 with the agent and relay; the daily wall; what issue #18 was 🟢
**Opus 5.5 test run** (`opus55-r1`, 2026-10-05 00:13–00:29Z, right after the weekly reset, premium
account, shipped defaults: agent + relay; `M365_DEBUG`, `M365_DUMP_FRAMES`, `M365_NO_CONFAB_RETRY`):
- **Bench: 10/10**, 33 M365 turns (3.3 per task; Opus 4.5 under relay 3.56), every turn `Claude_Opus`
  on the paid scenario with `3PDeclarativeAgent`, relay on every first turn, no `<system>` tag,
  0 Disengaged, 0 sandbox turns, 0 native-markup leaks (F57), 3 replies with a short lead-in sentence
  before the call (stripped as usual).
- **Real pi fix-bug: 1/1 before the wall**, then 4 runs lost to it (`analyze-arms` now counts those as
  `INVALID(quota)`, like a throttle). Plus the smoke test: 2/2 turns (F56).

**The metering, turn by turn** (`throttling.metering` of every frame): each of the 40 served turns
lowered `ClaudeOpusQueryDaily` and `ClaudeOpusQuery75` by exactly 1 — first turns carrying the
~2.5 kB framing and 100-byte `<tool_response>` follow-ups alike. **40 turns from the reset to the
wall**, as `ClaudeOpusQueryDaily` = 40 said (2 smoke + 33 bench + 5 pi). The 41st turn, mid-conversation
in pi run 2 (00:24:51Z), was refused; weekly stood at 35. **Refused turns cost nothing** (15 of them:
daily stays 0, weekly stays 35).

**The refusal is not content.** On the refused turn nothing is streamed: the only text is a BotConnection
message inside the final `type:2` item, plus `result: {value: "OutOfCredits", message: <the same
text>}`. `session.ts` builds the reply from the streamed updates only, so the handler saw an EMPTY
turn — and the text-only detector (`parsePriorityAccessExhaustion(fullText)`, F27) never fired. The
handler retried twice with "Please continue." (2 more refused turns) and returned a 502 "M365 Copilot
returned an empty response". Every exhausted request cost 3 M365 turns and told the client the wrong
thing. The probes saw the text because `_probe-chat` reads the `type:2` item. The weekly refusal
(10-02/10-04 probe frames) has the same shape. **Fixed:** `priorityAccessExhaustionOf()` reads
`result.value === "OutOfCredits"` / `result.message` as well as the text. Live (00:31–00:32Z, daily
wall): the first `claude-opus` request → 429 `priority_access_exhausted`, `param: day`, `Retry-After`
to midnight UTC, after **1** M365 turn; the next ones, streaming or not → the same 429 after **0**
turns (`activePriorityAccessExhaustion`, kept until the reset); `claude-opus-4.5` unaffected.

**Issue #18** ("the daily Opus priority access budget is exhausted after only 11 bench tests";
hypothesis: the framing size). What the wire shows:
1. **Size is irrelevant**: one unit per turn (`creditScenario: "TotalTurn"`, Δ = 1 on every turn above,
   whatever its size). A shorter framing can't help — the issue's suggestion, and `minimal`'s premise.
2. **The budget is 40 turns a day and 75 a week**, per account, and a turn is one M365 request: every
   tool call in an agent loop is one. A person in the web UI rarely sends 40 messages to Opus in a
   day; one bench run sends ~33.
3. **The proxy spent turns the bench never saw.** Its "M365 messages spent" counts client requests,
   but the proxy adds its own: the Disengage retry (fresh conversation; `minimal` Disengaged on 40%
   of Opus 4.5 tasks, F56), the confab retry (on by default, so in the issue's runs), and at the wall
   2 "Please continue." retries per request. The issue's numbers fit that: 29 answered client
   requests in the first bench and 4 in the second (33), then 502s that are exactly the "empty
   response" above; ~7 hidden retry turns (the second bench's 29 s prose give-up alone looks like a
   confab retry) would make 40. Not provable from the issue's data (no debug log, and the budget on
   2026-09-22 is unknown), but consistent with a 40-turn daily budget.

**What resolves it, in the proxy** (all shipped, unit-tested, and live-tested except where noted):
- relay (F56): no Disengage retries on Opus (0/50 vs `minimal` 12/30) → 1.00 conversations/task.
- the wall is detected on the first refused turn, remembered until the reset, and answered as a
  429 with the reset time — 0 turns wasted afterwards.
- `usage.x_m365_opus_daily_remaining` / `x_m365_opus_weekly_remaining` on every paid-scenario turn,
  so a client sees it coming.
- **`M365_OPUS_FALLBACK_MODEL=claude-opus-4.5`** (opt-in): once Opus 5.5 is exhausted, a
  `claude-opus` request is re-sent, whole, to Opus 4.5 in a fresh conversation — unmetered, same
  agent + relay path, premium accounts only — and later requests go straight there until the reset.
  The response's `model` names the model that answered. A conversation that was on Opus 5.5 continues
  on 4.5 in a fresh M365 conversation with the full history (unit-tested; not yet seen live, because
  the wall had already been hit). Live (00:32Z): refused once → served by 4.5 with a tool call; then
  straight to 4.5, streaming and tool-less included. **Real pi through it: 10/10** (`opus55-fallback-pi`,
  `MODEL=claude-opus`, `M365_OPUS_FALLBACK_MODEL=claude-opus-4.5`, 00:33–00:48Z): fix-bug 5/5, multi
  5/5, all streaming. 62 M365 turns: 1 refused (`OutOfCredits`, the first request), re-sent once to
  Opus 4.5, then 60 served there directly; 0 Disengaged, 0 throttled, no native markup.
- `claude-opus-4.5` directly, which has no budget at all.
Not resolvable: the allowance itself is Microsoft's (and the `…Dev`, `…Word`, `…C1/C2` budgets in
the map suggest other clients get other ones).

### F60 — `relay_batch` cuts Opus 4.5's turns per task by 37% (bench) and 42% (real pi) at no cost → the Opus default 🟢
Opus 5.5's budget counts turns (F59), so turns per task is the lever left. A new user-voice relay
(`fenced.ts`): `relay_batch` = relay asking for as much as fits in each block ("Each round trip takes
me a while, so put as much as you can into one block: a script can look at the files, make the change
and check the result all at once"). `opus45-turns`, `claude-opus-4.5` (unmetered), mirrored order
relay, batch, batch, relay, `TASK_GAP=60`, 01:18–02:45Z, premium account.

| arm | solved | M365 turns / task (sd) | Disengaged | tasks with fewer turns than relay |
|---|---|---|---|---|
| `relay` (shipped) | 20/20 | 3.65 (1.11) | 0/20 | — |
| **`relay_batch`** | 20/20 | **2.30** (0.56) | 0/20 | 8 of 10 (0 more, 2 same) |

relay − batch = 1.35 turns/task (task-stratified permutation p < 10⁻⁴). 2.30 is
close to the floor of 2 (one block, one closing sentence): fizzbuzz written and run in one block,
fix-bug read-then-fix in 2 blocks instead of 5, edits with before/after output and a JSON validity
check in the same block. Every closing claim matched output it had seen. **The risk** is acting before
looking: on ec-plain/ec-nonport it overwrote `value.txt` in the same block that first printed it —
licensed here ("The file value.txt contains the number 3000"), and multi-field files got in-place
`sed`/`perl` edits, but on real code a batched block runs on assumptions. On Opus 5.5 that would be
~17 tasks a day instead of ~11. **Not yet:** real pi with `relay_batch` (below), and Opus 5.5 itself
(after the 2026-10-06 00:00Z daily reset). The default stays `relay` until both are in.
F58 check: pre-registered "no throttle, bottom ~22" at relay's rate; 189 turns, model bottom 41
(fewer turns than assumed), no throttle — held (but a ~21-conversations-per-30-min run doesn't
discriminate from a conversation-count rule either).

**Real pi with `relay_batch` (Opus 4.5): 10/10, 3.5 turns per run vs relay's 6.0** (`opus45-batch-pi`,
`M365_FRAMING_VARIANT=relay_batch`, 02:59–03:11Z, streaming):

| | relay (`opus45-pi`, `opus55-fallback-pi`) | `relay_batch` |
|---|---|---|
| fix-bug | 10/10, 6.0 turns, 29–40 s | 5/5, **3.0** turns, 16–18 s |
| multi (2-file bug) | 10/10, 6.0 turns, 28–37 s | 5/5, **4.0** turns, 22–25 s |

0 Disengaged, 0 throttled, no native markup. In pi it did NOT act blind: every edit came in a block
after a read (`ls` + `cat` + run the check → fix + re-run the check → one-line summary); multi took one
extra read for the second file. Two fix-bug runs rewrote the 2-line `calc.py` whole with a heredoc
instead of `sed` — after reading it, but on a big file that's the risky shape.

**Shipped (2026-10-05): `defaultFramingForTone("Claude_Opus") = "relay_batch"`, for both Opus models.**
Same classifier behaviour as relay (0 Disengaged in 40 bench + pi tasks) and ~40% fewer turns, which
is the one thing Opus 5.5's budget counts. **Not measured:** Opus 5.5 itself under `relay_batch` (its
bench and pi above are under relay, 10/10); the post-reset run planned for that
(`sweeps/opus55-batch-plan.sh`) was cancelled before it started. The mid-conversation switch to the
fallback (Opus 5.5 → 4.5 within one conversation) was tested by the user; the proxy-side runs here
cover the switch at a request boundary (`opus55-fallback-pi`, `opus55-exhaust-B`).
`scripts/opus-fallback-probe.mjs` (a counting conversation that crosses the wall) is kept for re-checks.

## 25. Oct 5 2026 — should the `relay` tones batch too? (`relay` vs `relay_batch`)

**Question.** F60 moved both Opus models to `relay_batch` because Opus 5.5's budget counts turns.
Every other user-voice tone still defaults to plain `relay`: Sonnet 4.6 (`claude-sonnet`), Sonnet 5
(`claude-sonnet-5`), GPT-6 (`gpt-6-think-deeper`, agent-less) and GPT-6 Sol (`gpt-6-sol`; agent on a
premium account, agent-less elsewhere). None of them is metered by turns, but a turn is still a
round trip (10–30 s on the reasoning tones), a step toward the ~600-message conversation cap, and
one more chance to Disengage.

**Hypothesis H25.** relay_batch cuts turns per task on these tones as it did on Opus 4.5, without
costing solves. **Risks that would falsify it per tone:** a weaker model batching blind (editing
before it has seen the file), and — on the agent-less tones that have a sandbox of their own
(GPT-6, GPT-6 Sol) — "put as much as you can into one block: a script can look at the files…"
reading as an invitation to write and run that script in the sandbox.

**Pre-registered decision rule (fixed 06:45Z, before any result was read), per model and path.**
Switch the default to relay_batch only if all of:
1. solved(relay_batch) ≥ solved(relay) − 1 per 20 valid tasks (Sonnet 4.6, n=40 per arm: − 2);
2. turns per task down ≥ 15%, task-stratified permutation p < 0.05;
3. Disengaged + jailbreak + sandbox turns not up by more than 1 per 20 tasks;
4. real pi under relay_batch: fix-bug and multi ≥ 9/10 together.
Otherwise the tone keeps `relay`.

**Design.** `phase-sweep.sh`, 10 bench tasks per arm, confab retry off, `TASK_GAP=30`, mirrored
orders, all three accounts in parallel (one sweep per account at a time):
- premium: Sonnet 5 (relay, batch, batch, relay), GPT-6 (batch, relay, relay, batch), GPT-6 Sol
  with the agent (relay, batch, batch, relay) — 20 tasks per arm each;
- non-premium T: Sonnet 4.6 (relay, batch, batch, relay), then GPT-6 Sol agent-less
  (`M365_FORCE_AGENT=0`; relay, batch);
- non-premium P: Sonnet 4.6 (batch, relay, relay, batch), then GPT-6 Sol agent-less (batch, relay).
Read with `analyze-arms.mjs` (turns, sandbox, Disengaged, jailbreak per task).

**Amendment (07:15Z, after the Sonnet bench results below and before any pi run).** Both Sonnets
landed on the 15% line, so real pi decides for them: fix-bug + multi, 5 runs each, under relay
AND relay_batch (the pi turn counts on file are for other models). Switch if relay_batch ≥ 9/10,
≥ relay − 1, and pi turns per run down ≥ 15%.

### F61 — bench: relay_batch cuts turns ~33% on the GPT-6 tones, ~15% on the Sonnets, at no solve cost 🟡
All arms 10 tasks, confab retry off, `TASK_GAP=30`, 06:33–08:46Z, service as of 2026-10-05. 0 Disengaged
and 0 jailbreak-classifier turns in all 232 tasks; every task that ran to the end was solved.

| model / path | account(s) | relay: solved, turns/task | relay_batch | Δ turns (task-stratified perm.) | sandbox turns relay → batch |
|---|---|---|---|---|---|
| Sonnet 4.6, agent-less | T + P | 40/40, 3.30 | 40/40, 2.85 | −14% (p = 0.002) | 0 → 0 |
| Sonnet 5, agent-less | premium | 20/20, 3.35 | 20/20, 2.85 | −15% (p = 0.03) | 9 → 2 |
| GPT-6, agent-less | premium | 20/20, 3.15 | 20/20, 2.10 | −33% (p = 10⁻⁴) | 0 → 0 |
| GPT-6 Sol, agent | premium | 12/12, 3.17 | 20/20, 2.10 | −34% (p = 10⁻⁴) | 0 → 0 |
| GPT-6 Sol, agent-less | T + P | 20/20, 3.10 | 20/20, 2.10 | −32% (p = 5·10⁻⁵) | 2 → **4** |

GPT-6 Sol's relay arm with the agent is short: its last arm hit the throttle after 2 tasks (F58).
Where the Sonnets save turns: only fizzbuzz and count-lines, the tasks a single script can finish
(count-lines 5–6 → 2). On fix-bug and the config edits they work the same either way: Sonnet 4.6 still
reads each file with its own `read_file` call and edits with `edit_file`. The GPT-6 tones batch everywhere
(nearly every task 2 turns: one block, one summary). GPT-6 Sol's four agent-less sandbox turns (`bash -lc pwd`,
`print('hi')`, one whole read-and-check script) are the risk H25 named; none cost a solve. Sonnet 5 went
to its own sandbox *less* under relay_batch (9 → 2).

**Against the rule.** GPT-6 and GPT-6 Sol with the agent pass 1–3; GPT-6 goes on to real pi. GPT-6 Sol agent-less
**fails 3**: +2 sandbox turns per 20 tasks against a limit of 1 — 4 events against 2, so weak evidence
either way, but the rule was fixed in advance, and `gpt-6-sol` has one default for both paths, so it
keeps `relay` without a pi run. The Sonnets go to pi (amendment above). *(Retested in §28 F71 on 40 tasks
per framing plus real pi: 15 → 13 sandbox turns, and `gpt-6-sol` switched to relay_batch.)*

### F62 — real pi, Sonnet 4.6: relay_batch 20/20 at 5.65 turns per run vs relay 19/19 at 7.16 → passes 🟢
fix-bug + multi, 10 runs each per framing, both non-premium accounts, 07:48–09:47Z, confab retry off.
Throttled runs (T/P were throttled 08:07–08:30Z) are excluded: 16 runs, each throttled on its first turn.

| | relay | relay_batch |
|---|---|---|
| fix-bug | 9/9, turns 7,6,8,6,4,5,6,6,12 | 10/10, turns 4,7,4,6,7,7,3,3,6,3 |
| multi | 10/10, turns 8,8,8,5,6,7,9,9,8,8 | 10/10, turns 5,4,6,7,8,8,5,6,8,6 |
| **all** | **19/19, 7.16** | **20/20, 5.65** (−21%, task-stratified perm. p = 0.008) |

The amended rule (≥ 9/10, ≥ relay − 1, ≥ 15% fewer turns) holds. No blind edits under relay_batch: every
run read `check.py` and `calc.py` first; the saving is the fix and the check merged into one block
(`sed -i … && python3 check.py`).

**Side finding — pi's `edit` loses its edits for Sonnet 4.6 (both framings).** 44 of 47 Sonnet 4.6
`edit` calls reached pi as `{"path": …, "edits": []}`, and pi answered "Edit tool input is invalid.
edits must contain at least one replacement" (in a `<tool_response name="unknown">`); the model then
re-read the file and rewrote it whole with `write`, ~2 extra turns per run with an edit. Cause: the
fenced parser reads `edits: [{"oldText": …, "newText": …}]` (inline JSON — Opus always writes that,
0 of 21 lost) but not the YAML block list Sonnet 4.6 mostly writes:
```
edits:
  - oldText: "return a - b"
    newText: "return a + b"
```
The header line `edits:` coerces to `[]` and the indented list is dropped (`coerceHeaderValue` /
`parseFencedInner`, `fenced.ts`). The bench doesn't see it — its tasks have no `edit` tool — so every
real-pi Sonnet 4.6 number above carries those wasted turns, in both arms alike. Issue #50 (with the
delta turns' `name="unknown"` label). **Fixed** (PR #51): real pi, relay, 10/10, all
10 edits YAML and all parsed, none rejected — 5.20 turns per run vs relay's 7.16 here (12:19–12:33Z,
account P). That is a bigger saving than batching's, and the two should stack; not yet measured together.

### F63 — real pi on the premium account: GPT-6 batches cleanly, Sonnet 5 doesn't save turns → the decision 🟢
Paced runs (`M365_AVOID_THROTTLING=1`), 11:00–11:56Z, confab retry off, no throttled or Disengaged run.

| model | framing | fix-bug | multi | turns per run | sandbox turns |
|---|---|---|---|---|---|
| GPT-6 | relay_batch | 5/5, turns 3,3,3,3,3 | 5/5, turns 3,3,3,3,3 | 3.00 | 0 |
| Sonnet 5 | relay | 5/5, turns 4,5,5,4,5 | 5/5, turns 5,5,6,7,6 | 5.20 | 4 |
| Sonnet 5 | relay_batch | 5/5, turns 5,5,4,4,4 | 5/5, turns 5,5,5,6,6 | 4.90 (−6%, p = 0.47) | 9 |

GPT-6 met criterion 4 (≥ 9/10). It had no relay pi run on file to compare turns against; the
saving is the bench's (−33%, F61). Sonnet 5 fails the amended rule: its bench saving (−15%) doesn't
carry into pi, where relay already reads, fixes and checks in ~5 turns. Its sandbox turns went the
other way from the bench (bench 9 → 2, pi 4 → 9), cost no solve either time, and look like noise.

**Decision, by the rule fixed before the results:**

| model | default | evidence |
|---|---|---|
| `gpt-6-think-deeper` (`Gpt_6_Reasoning`) | **relay_batch** | bench 40/40, −33% turns (F61); pi 10/10 |
| `claude-sonnet` (Sonnet 4.6, `Claude_Sonnet` included) | **relay_batch** | bench 80/80, −14%; pi 39/39, −21% (F62) |
| `claude-sonnet-5` (`Claude_Sonnet` paid; `Claude_Sonnet_5` since §26) | relay | pi −6%, not significant |
| `gpt-6-sol` (`Gpt_6_Sol_Reasoning`) | relay → **relay_batch** (§28) | agent-less sandbox turns 2 → 4 per 20 tasks (F61); retest 15 → 13 per 40, pi 30/30 (F71) |

Sonnet 4.6 and Sonnet 5 share a tone (they did until §26), so the split rides on `SONNET_5_DEFAULT_FRAMING`, kept
separate for exactly this. Shipped in `defaultFramingForTone`.

### H25b — relay_batch without a shell tool: Sonnet 4.6 refuses? (pre-registered 12:08Z)
**Observation (n=1).** After the switch, `proxy-verify --tools --multiturn --model=claude-sonnet`
(premium, 11:58Z) got no tool call: "The `read_file` block you described isn't an actual tool I have
access to — I can only use … web search, Python sandbox, and image generation", then the same after the
confab retry. GPT-6 passed the same check under relay_batch. proxy-verify's only tool is `read_file`;
with no shell tool both relays say "a single ```<tool_name> block", and relay_batch adds "a script can
look at the files, make the change and check the result all at once" — a script it has no way to run.
The bench and pi always offer a shell tool, so F61–F63 never tested this.
**Hypothesis.** relay_batch, not chance, breaks Sonnet 4.6 on shell-less toolsets. **Prediction:**
proxy-verify (`claude-sonnet`, `M365_FRAMING_VARIANT` set) passes ≥ 4/6 under relay and ≤ 2/6 under
relay_batch, both non-premium accounts, 3 + 3 per arm, alternating, orders mirrored. **Falsified if**
relay_batch passes as often as relay.
**Result (12:00–12:04Z): not confirmed as written, but the effect is real on two of three accounts.**

| account | relay | relay_batch |
|---|---|---|
| T (relay first) | 3/3 PASS | **0/3** — "I don't actually have a `read_file` tool available to me" |
| P (relay_batch first) | 3/3 PASS | 3/3 PASS (one with a hedge: "I shouldn't be using sandbox tools…") |
| premium (11:58Z, the trigger) | — | 0/1 |
| **pooled** | **6/6** | **3/7** |

relay_batch passed 3 of 6 in the planned runs, above the ≤ 2 predicted; it didn't pass as often as relay
either (falsification criterion), so neither verdict. Every refusal names the relay note's own list
of sandbox tools as "the tools I have", i.e. it reads "a script can … all at once" as a request it
can only meet in its own sandbox, which the note just forbade. Why P differs is open (same build and
prompt; per-account flighting?). It matters regardless: AGENTS.md's end-to-end check
(`proxy-verify --tools --model=claude-sonnet`) is shell-less, and so are some harnesses' toolsets.
**Proposed fix:** relay_batch asks for batching only when a shell tool is present, and is relay
byte-for-byte otherwise — the text that passed 6/6. Shell-less Opus 4.5 (with the agent, premium,
12:05–12:10Z) passed 3/3 under each, so the fix changes nothing measurable for it. **Shipped** with the
F63 defaults; with a shell present the relay_batch text is unchanged, so F60–F63 stand.
**Live check of the fix** on account T, the one that refused 3/3 (12:11–12:13Z, new build, default
framing for `claude-sonnet`, i.e. relay_batch falling back to relay): proxy-verify 3/3 PASS.

---

## 26. Oct 6 2026 — `Claude_Sonnet` @ paid becomes Sonnet 5.5; Sonnet 5 moves to `Claude_Sonnet_5`

**Trigger.** On 2026-10-06 the paid route of `Claude_Sonnet` stopped answering as Sonnet 5, and a new
tone, `Claude_Sonnet_5`, appeared. Nothing on the wire announced it. `tone-probe.mjs` and
`agent-tone-probe.mjs` were run with a self-ID prompt — *"Reply with only your model name and version,
a semicolon, the full company that made you, a semicolon, and your knowledge cutoff date (YYYY-mm) or
"unknown"."* — on the premium account and on a non-premium one (03:28–03:36Z and 04:22Z). Raw dumps:
`scripts/tone-out/2026-10-06T03-*`, `scripts/agent-tone-out/2026-10-06T03-*`.

### F64 — `Claude_Sonnet` is Sonnet 4.6 (included) / Sonnet 5.5 (paid); `Claude_Sonnet_5` is Sonnet 4.6 / Sonnet 5 🟢
Self-IDs, premium account; every cell `contentOrigin: DeepLeo`, the agent cells `3PDeclarativeAgent`:

| tone @ scenario | agent-less (`tone-probe`) | with the tool agent (`agent-tone-probe`) |
|---|---|---|
| `Claude_Sonnet` @ included | Sonnet 4.6 ×2 | Sonnet 4.6 ×2 |
| `Claude_Sonnet` @ paid | **Sonnet 5.5** ×2, unidentified ×1 | **Sonnet 5.5** ×3 |
| `Claude_Sonnet_5` @ included | Sonnet 4.6 ×2 | Sonnet 4.6 ×2 |
| `Claude_Sonnet_5` @ paid | **Sonnet 5** ×2 | **Sonnet 5** ×1, unidentified ×1 |

The unidentified replies named only the host ("Microsoft Copilot; Microsoft Corporation; 2026-01",
"Microsoft Enterprise Copilot; Microsoft; 2026-01"). Sonnet 5.5 likes that wrapper even when it does
name itself — "Microsoft Enterprise Copilot (based on Claude Sonnet 5.5)", "Claude Sonnet 5.5 (in
Microsoft Enterprise Copilot); Anthropic, PBC" — and both new-generation models give a 2026-01 cutoff,
Sonnet 4.6 2025-08. Sonnet 5.5 is the slowest of the three (7.5–12.1 s against 4.2–7.5 s for Sonnet 5
and 3.8–5.9 s for Sonnet 4.6, one-line answers).

Non-premium account: both tones @ included are Sonnet 4.6 agent-less (1/1 each) and the dead route with
the agent (`BotConnection`, `result: InternalError`, ~2.6 s, 1/1 each), like `Claude_Sonnet` in F44.

So the tones split as F35's "one tone, two models" did: the included scenario serves
Sonnet 4.6 on both, the paid scenario serves the newer model. **Shipped:** `claude-sonnet-5.5` →
`Claude_Sonnet` + paid (`PAID_SCENARIO_MODELS`, plus unmapped `sonnet-5.5` / `sonnet-5-5` strings);
`claude-sonnet-5` → `Claude_Sonnet_5`, which joins `PAID_SCENARIO_TONES` (nothing maps it for 4.6, which
`claude-sonnet` already reaches). Both go agent-less with tools, like every Sonnet. A pinned model ID is
only as stable as the tone behind it; the second hint was the metering map (F65).

### F65 — Sonnet 5.5 has its own priority-access budget: 80 turns a day, 150 a week 🟢
The paid scenario's `throttling.metering` (§24 F55) gained `ClaudeSonnet55QueryDaily` and
`ClaudeSonnet55QueryWeekly`. Read after each turn, premium account, 2026-10-06 (a Tuesday):

| Sonnet 5.5 turns so far | daily / weekly after | what ran |
|---|---|---|
| 1 | 79 / 149 | agent-tone-probe 03:28Z |
| 4 | 76 / 146 | agent-tone-probe 03:30Z (two tone-probe turns in between) |
| 5 | 75 / 145 | agent-tone-probe 03:34Z |
| 6 | 74 / 144 | tone-probe 03:35Z (read at 05:51Z off another tone's turn) |
| 7 | 73 / 143 | `sonnet5-native-tools-probe` 06:09Z (F66) |
| 8, 9 | 72 / 142, 71 / 141 | `proxy-verify --multiturn --model=claude-sonnet-5.5`, both turns of one conversation |

Exactly one unit per turn, agent or not, and a follow-up in the same conversation costs one too. Turns
that lowered **neither**: `Claude_Sonnet_5` @ paid (the agent-tone-probe cells right after a Sonnet 5.5
cell, and both `claude-sonnet-5` proxy-verify runs), `Gpt_6_Sol_Reasoning` @ paid and `Gpt_5_5_Chat` @
paid (1 each). Starting values 80 / 150 —
the week's budget was untouched on a Tuesday, which fits the model having just arrived. Separate from
Opus's (`ClaudeOpusQuery75` / `ClaudeOpusQueryDaily`, which read 0 / 5 at the time and didn't move).
Not yet observed: the refusal itself and the resets. The detector keys on `result.value: "OutOfCredits"`,
which is model-agnostic; the reset times are assumed to match Opus's (midnight UTC, Monday).

**Shipped:** `METERED_BUDGETS` (`priority-access.ts`) lists both budgets; `meteredBudgetOf(model)` maps a
model to one (Opus 5.5 → `opus`, Sonnet 5.5 → `sonnet-5.5`, null off the paid scenario); walls are
remembered per budget, so Opus running out says nothing about Sonnet 5.5; `usage` carries
`x_m365_sonnet55_daily_remaining` / `_weekly_remaining`; `M365_SONNET_FALLBACK_MODEL` (e.g.
`claude-sonnet-5`) mirrors `M365_OPUS_FALLBACK_MODEL`. The session log prints each budget after every
paid turn ("Sonnet 5.5 priority access left: 72 today, 142 this week").

### F66 — Sonnet 5.5 has Sonnet 5's sandbox → relay 🟡 (n=1)
`TONE=Claude_Sonnet node scripts/sonnet5-native-tools-probe.mjs pwd-proxy` (06:09Z): a native `Progress`
frame running `pwd`, reply "`pwd` printed exactly: /home/claude" — the same `/home/claude` sandbox as
Sonnet 5 (§21 F36). So the `<system>`-tag reading that sent Sonnet 5 to its sandbox (F37) is the risk
here too; untested on 5.5, but cheap to avoid. **Shipped:** `SONNET_5_5_DEFAULT_FRAMING = "relay"`, by
model ID (`claude-sonnet` keeps `relay_batch` on the same tone).

Live checks (premium, 06:19–06:21Z, proxy-verify `--tools --multiturn`, whose only tool is `read_file`):
`claude-sonnet-5.5` 1/1 PASS (tool call 9.2 s, answer 5.5 s; routed `Claude_Sonnet` +
`OfficeWebPaidCopilot`, agent-less). `claude-sonnet-5` 1/2: the first run answered "I don't actually have
a `read_file` tool — my tools only operate on my own sandbox…" and offered a ```` ```bash ```` block
instead, the second passed. That is H25b's refusal shape under plain relay, on a shell-less toolset; n=2,
not chased.

### H26a — a GPT-6.1 Sol budget with no tone we can find 🟢 (resolved, §27 F67)
**Resolved 2026-10-06:** the tone is `Gpt_61_Sol_Reasoning` (no separator between 6 and 1), and each of
its paid-scenario turns lowers both keys by 1; included-scenario turns don't. See §27.

The same metering map carries `GPT61SolQueryWeekly` (75) and `GPT61SolQueryDaily` (40) — Opus's
numbers — on every paid turn. Eight guessed tone names were rejected outright (`type:3` "Failed to invoke
'Chat'", premium, paid scenario unless noted): `Gpt_6_1_Sol_Reasoning` (both scenarios),
`Gpt_6_1_Sol_Chat`, `Gpt_6_1_Reasoning`, `Gpt_6_1_Sol`, `Gpt_6_Sol_1_Reasoning`, `Gpt_6_1_Sol_Thinking`,
`Gpt_Sol_Reasoning`, `Gpt_6_1_Chat`. `Gpt_6_Sol_Reasoning` @ paid still self-IDs as the GPT-6 reasoning
model and lowers neither key. **Hypothesis:** a GPT-6.1 Sol tone is rolling out and its budget key
shipped before this account was flighted for the model (or its tone has a name we didn't guess).
**Probe:** the web client's tone list (§12.6) once "GPT 6.1 Sol"
shows in its picker, then `tone-probe.mjs` + `agent-tone-probe.mjs` on both accounts. `_probe-chat.mjs`
now returns `throttle.metering`, so any probe can watch for the keys moving.

### H26b — does relay_batch save Sonnet 5.5's budget? 🔴
Its budget counts turns, which is why Opus moved to relay_batch (F60). On Sonnet 5 batching saved 15% of
bench turns but only 6% in pi (F63). **Probe:** real pi, fix-bug + multi, relay vs relay_batch, 5 runs
each (~60–80 of the 80 daily units — split across two days). Switch if the §25 amendment's rule passes
(relay_batch ≥ 9/10, ≥ relay − 1, pi turns per run down ≥ 15%).

---

## 27. Oct 6 2026 — GPT-6.1 Sol (`Gpt_61_Sol_Reasoning`): ungated, the agent only on premium, a budget on the paid scenario

**Question.** A new tone, `Gpt_61_Sol_Reasoning` ("GPT-6.1 Sol" in the web client), showed up in a
user's probes. Which accounts and scenarios serve it, does it take the tool agent, what does it cost,
and which framing makes it drive a coding loop? Shipped as `gpt-6.1-sol`.

### F67 — the paid scenario spends the `GPT61Sol*` budget; the included one doesn't 🟢
`tone-probe` + `agent-tone-probe` on the premium account (17:30–17:42Z, results.json and frame dumps
re-read): every paid-scenario `Gpt_61_Sol_Reasoning` turn lowered the budget by exactly 1, agent or not.
The agent probe's paid frames read `GPT61SolQueryWeekly` 72, 71 and 69 (daily 34 at the last), and the
six paid turns up to that last reading (three agent-less, three with the agent, interleaved) account for
every step from 75/40. Included-scenario turns carry no `metering` map, and
an included-only run between the 73 and 72 readings lowered nothing. This is H26a's budget, 40 a day and
75 a week, Opus's numbers. Nothing else on the wire tells the scenarios apart: same `DeepLeo` origin,
same `serviceVersion`, same frames apart from `metering`, and the same self-ID on both ("M365 Copilot
based on GPT-6 reasoning model", cutoff 2025-12 agent-less, "unknown" with the agent).
**Decision:** `gpt-6.1-sol` routes on the included scenario. That is the only one a non-premium
account can use (the paid one answers there with `InvalidCopilotLicense`, F68), and it spends nothing.
The tone stays out of `PAID_SCENARIO_TONES`, and no budget is tracked for it.

### H27a — is the included scenario's GPT-6.1 Sol the same model as the paid one's? 🔴
For every other metered tone the included scenario serves an older model (`Claude_Opus`: Opus 4.5 vs
5.5; `Claude_Sonnet`: Sonnet 4.6 vs 5.5), which self-ID gave away. GPT self-IDs come from M365's system
prompt ("GPT-6 reasoning model" for GPT-6, GPT-6 Sol and both GPT-6.1 Sol scenarios), so self-ID can't
answer this. **Falsifier:** a behavioural difference between `Gpt_61_Sol_Reasoning` @ included and
@ paid that `Gpt_6_Sol_Reasoning` @ included shares with the included one (a knowledge question past
one model's cutoff, with grounding off). Paid turns cost budget units, so keep it to a handful.
*(§29 F72 narrows it: agent-less, the included one keeps out of its sandbox when asked and GPT-6 Sol
doesn't, so it isn't GPT-6 Sol under a new name. Included vs paid is still open.)*

### F68 — agent: premium only, on both scenarios; agent-less: included only, every account 🟢
| account | path | included | paid |
|---|---|---|---|
| premium | agent | 5/5 serve (DeepLeo + `3PDeclarativeAgent`) | 3/3 serve |
| premium | agent-less | 5/5 serve | 4/4 serve (metered, F67) |
| non-premium 1 | agent | 1/1 dead (BotConnection, `InternalError`) | — |
| non-premium 1 | agent-less | 4/4 serve | — |
| non-premium 2 | agent | 1/1 dead | 1/1 dead |
| non-premium 2 | agent-less | 1/1 serve | 1/1 `InvalidCopilotLicense` |

The user's probes (the premium account and non-premium account 1, 17:23–17:42Z) plus two of ours
(non-premium account 2 at 18:33Z, premium at 18:34Z,
`agent-tone-probe --baseline`). Rejected outright (`type:3` "Failed to invoke 'Chat'", non-premium account 1):
`Gpt_61`, `Gpt_61_Chat`, `Gpt_61_Reasoning`, `Gpt_61_Sol`, `Gpt_61_Sol_Chat`. The same split as GPT-6
Sol (F49), so the tone joins `PREMIUM_ONLY_AGENT_TONES`: the first tool request tries the agent, a
non-premium account's dead route switches the process to agent-less for that tone. The probe used to
read the tone name `Gpt_61` as GPT major 61 and report `VERSION_MISMATCH(GPT-6)` without `--baseline`;
it now reads a two-digit run as major.minor.

### Framing: design and pre-registered decision rule
**Phase A (screen, 18:36Z on):** `phase-sweep.sh`, `MODEL=gpt-6.1-sol`, 10 bench tasks per arm, confab
retry off, paced (`M365_AVOID_THROTTLING=1`), seven framings on each account — baseline, minimal,
demo_only (GPT-6 Sol's runners-up, F51), the four user-voice framings honest, terse_user, relay,
relay_batch — in a different order per account. The agent path is the premium account's; the
agent-less path is the two non-premium accounts', reached the way a real client reaches it (the first
request tries the agent, the dead route switches the proxy agent-less). One proxy per arm.

**Rule, fixed 19:40Z after reading phase A and before phase B.** Phase A narrowed it to relay vs
relay_batch: the only framings that solved every task on both paths, relay_batch with the fewest turns.
The default is one per tone, so it must hold on **both** paths. Switch from GPT-6 Sol's `relay` to
`relay_batch` only if, per path, all of F61's criteria hold:
1. solved(relay_batch) ≥ solved(relay) − 1 per 20 valid tasks;
2. turns per task down ≥ 15%, task-stratified permutation p < 0.05;
3. Disengaged + jailbreak + sandbox turns not up by more than 1 per 20 tasks;
4. real pi under relay_batch: fix-bug and multi ≥ 9/10 together.

**Phase B:** premium (agent) bench relay_batch, relay (A's order reversed), to reach 20 tasks per arm;
then real pi fix-bug + multi, 5 runs each, under relay_batch and under relay, on the premium account
(agent) and on both non-premium accounts (agent-less), the framing order mirrored between the two.

### F69 — phase A: with the agent every framing works; without it only the user-voice ones do 🟢
10 bench tasks per cell, 18:36–19:50Z. Turns are the arm's M365 turns (agent-less: including the one
dead agent turn each fresh proxy spends before it falls back). Disengaged turns were all the jailbreak
classifier's.

| framing | agent (premium): solved, turns, Disengaged | agent-less (non-premium 1 + 2): solved, turns, sandbox turns, Disengaged |
|---|---|---|
| baseline | 9/10, 27, **3** | **0/20**, 27, 20, 5 |
| minimal | 9/10, 30, **4** | **2/20**, 36, 20, 7 |
| demo_only | 10/10, 28, 2 | 13/20, 43, 9, 4 |
| terse_user | 10/10, 29, 1 | 19/20, 56, 0, 2 |
| honest | 9/10, 30, 0 | 20/20, 59, 0, 0 |
| relay | 9/10, 33, 0 | 20/20, 69, 0, 0 |
| relay_batch | **10/10, 27, 0** | **20/20, 45, 0, 0** |

GPT-6 Sol's pattern again (F51): agent-less, the `<system>`-tagged framings send it to its own sandbox
("I couldn't find config.json… upload it") on every task; the user-voice ones never. With the agent
the framings only differ in Disengaged turns and in the odd prose give-up (fix-bug under baseline and minimal: the fix as a
Python block; count-lines under relay and honest: "I can't create or run scripts in this session").
Unlike GPT-6 Sol (F61: 2 → 4; §28 found that gap was noise), relay_batch sent it to the sandbox no more than relay did (0 and 0).
The fallback worked on every agent-less arm: one `InternalError`, then agent-less for the process.

### F70 — phase B: relay_batch passes the rule on both paths → the default 🟢
19:40–21:30Z, same settings as phase A, no throttled, Disengaged or invalid task or run. Bench turns
are the client's count per task (the agent-less proxies' one dead agent turn left out); real-pi turns
are the M365 turns per run (each agent-less arm's first run includes that dead turn, under both
framings alike). Permutation tests are task-stratified.

| path | | relay | relay_batch | Δ turns |
|---|---|---|---|---|
| agent (premium) | bench, A + B | 19/20, 3.25 per task | 20/20, 2.70 | −17% (p = 0.007) |
| | real pi | 10/10, 5.80 per run | 10/10, 4.10 | −29% (p = 3·10⁻⁵) |
| agent-less (non-premium 1 + 2) | bench, A | 20/20, 3.35 | 20/20, 2.15 | −36% (p = 10⁻⁵) |
| | real pi | 20/20, 6.00 | 20/20, 3.20 | −47% (p < 10⁻⁴ on each account) |

Real-pi turns per run:

| account | framing | fix-bug | multi |
|---|---|---|---|
| premium | relay | 5,5,5,5,5 | 8,6,6,6,7 |
| premium | relay_batch | 4,4,3,3,3 | 5,4,5,5,5 |
| non-premium 1 | relay | 6,5,5,5,5 | 7,6,6,6,6 |
| non-premium 1 | relay_batch | 4,3,3,3,3 | 4,3,3,3,3 |
| non-premium 2 | relay | 6,5,5,5,5 | 9,8,7,6,7 |
| non-premium 2 | relay_batch | 4,3,3,3,3 | 4,3,3,3,3 |

Sandbox turns: relay 0 on the bench and 1 in pi (a multi run, non-premium 2), relay_batch 0 and 0.
Disengaged and jailbreak turns: 0 under both framings, bench and pi. No blind edits: every relay_batch
run first read the files (`find … | sort`, `head` of the sources, a Python heredoc printing them), then
fixed and checked in one block (`perl -pi … && python3 test.py`); agent-less that is read, fix-and-check,
summary — 3 turns. Where the bench saved turns with the agent: only the tasks one script can finish
(fizzbuzz, count-lines, ec-plain, ec-nonport); the rest took the same turns under both.

**Against the rule, per path:** 1 (solves ≥ relay − 1 per 20) holds on both; 2 (≥ 15% fewer turns,
p < 0.05) holds on both, the agent path closest to the line on the bench (−17%) and well past it in pi;
3 (Disengaged + jailbreak + sandbox not up > 1 per 20) holds, 0 → 0; 4 (real pi ≥ 9/10) holds, 10/10
and 20/20. **Decision: `gpt-6.1-sol` defaults to `relay_batch` on both paths** (`defaultFramingForTone`).
GPT-6 Sol stayed on `relay` (F61): what kept it there was its sandbox turns under relay_batch, and
GPT-6.1 Sol showed none. *(§28 retested it: the gap didn't hold, and GPT-6 Sol is on relay_batch too.)*

---

## 28. Oct 7 2026 — GPT-6 Sol, `relay` vs `relay_batch` again

**Question.** F61 kept `gpt-6-sol` on `relay` on one criterion alone: agent-less, relay_batch sent it
to its own sandbox on 4 turns in 20 bench tasks against relay's 2, one over the limit of 1 per 20.
Four events against two is weak evidence either way, and F61 had no real-pi run for it. GPT-6.1 Sol,
the same split one version on, showed none (F70). Does the gap hold up with more data, on today's
service?

**Hypothesis H28.** relay_batch sends GPT-6 Sol agent-less to its sandbox no more often than relay
does, and keeps F61's ~⅓ saving in turns on both paths. **Falsified if** the sandbox gap of F61
reappears (criterion 3 below fails again).

**Pre-registered decision rule (fixed 01:27Z, before any run).** F61's criteria, judged on the new
data only (F61's bench pooled in is reported, not decisive), per path. One default serves both paths,
so both must pass to switch `gpt-6-sol` to relay_batch; otherwise it keeps relay.
1. solved(relay_batch) ≥ solved(relay) − 1 per 20 valid tasks (bench);
2. bench turns per task down ≥ 15%, task-stratified permutation p < 0.05;
3. Disengaged + jailbreak + sandbox turns not up by more than 1 per 20 tasks, bench and real pi
   together;
4. real pi under relay_batch: fix-bug and multi ≥ 9/10 per account.
Turns are M365 turns per task or run, without the dead agent turn an agent-less proxy spends once
before it falls back.

**Design.** `phase-sweep.sh`, `MODEL=gpt-6-sol`, the 10 bench tasks per arm, confab retry off, paced
(`M365_AVOID_THROTTLING=1`), the shipped routing (the first tool request tries the agent; the
non-premium accounts fall back to agent-less), one sweep per account, all three at once:
- premium (agent): bench relay_batch, relay, relay, relay_batch (F61's order mirrored); real pi
  fix-bug + multi, 5 runs each, under relay, then relay_batch;
- non-premium 1 (agent-less): bench relay, relay_batch, relay_batch, relay; pi relay_batch, then relay;
- non-premium 2 (agent-less): bench relay_batch, relay, relay, relay_batch; pi relay, then relay_batch.
That is 20 bench tasks and 10 pi runs per framing with the agent, 40 and 20 without it.

### F71 — the sandbox gap was noise: relay_batch passes on both paths, `gpt-6-sol` switches 🟢
Ran 01:28Z–02:45Z, no throttle, no invalid task; archives `r28-prem` and one per non-premium account.
Every non-premium arm spent exactly one dead agent turn (`InternalError`) and then fell back agent-less,
as shipped (excluded from the turn counts). Read with `analyze-arms.mjs --turns`.

| path | | relay | relay_batch | turns | sandbox / Disengaged / jailbreak turns |
|---|---|---|---|---|---|
| agent (premium) | bench | 20/20, 3.05 | 20/20, 2.10 | −31% (p = 10⁻⁵) | 0/0/0 → 0/0/0 |
| agent (premium) | real pi | 10/10, 4.30 | 10/10, 3.50 | −19% (p = 0.037) | 0/0/0 → 0/0/0 |
| agent-less (np 1 + np 2) | bench | 40/40, 3.08 | 40/40, 2.10 | −32% (p = 10⁻⁵) | 15/0/0 → 13/0/0 |
| agent-less (np 1 + np 2) | real pi | 20/20, 4.25 | 20/20, 3.20 | −25% (p = 10⁻⁵) | 3/0/0 → 2/0/0 |

Real pi under relay_batch was 10/10 on each account (fix-bug 5/5 and multi 5/5 each). Agent-less
sandbox turns by account, bench: relay 3 and 12, relay_batch 6 and 7; one relay arm alone had 9.

**Against the rule, per path:** 1 holds on both (no task lost anywhere). 2 holds on both, −31% and
−32%, p = 10⁻⁵. 3 holds: with the agent 0 → 0; agent-less, bench and pi together, 18 → 15 in 60 tasks
and runs — relay_batch had *fewer* sandbox turns. 4 holds, 10/10 on each of the three accounts.
**Decision: `gpt-6-sol` defaults to `relay_batch` on both paths** (`defaultFramingForTone`). H28 confirmed.

**Pooled with F61 (reported, not decisive):** agent 32/32 at 3.09 vs 40/40 at 2.10; agent-less 60/60 at
3.08 vs 60/60 at 2.10, sandbox turns **17 and 17**. F61's 2 → 4 was noise on a rare event.

**The sandbox turns went up for both framings, not one.** F61's relay arms had 2 sandbox turns in 20
agent-less tasks; today's had 15 in 40, from 2–3 per arm up to 9. The commands are mostly a look around
before the fence (`bash -lc pwd`, `bash -lc true`, `ls -la`, an empty `hiddenText`), with the odd real
read (`find /mnt/data -name settings.txt`, a `sed` of `calc.py`); none cost a task or added a turn
(relay's turns per task are F61's to the decimal). So the rate drifts with the service, and a
criterion on rare events should be judged on enough tasks to see that rate, both arms on the same day.

**Tooling.** `analyze-arms.mjs` gained `--turns A B` (turns per valid task without the fallback's dead
turn, a task-stratified permutation test, and the sandbox/Disengaged/jailbreak totals), and a selection
can filter on a phase's env (`pi=fix-bug,pi=multi+M365_FRAMING_VARIANT=relay@agent-less`) so pi arms
under different framings come apart. It reproduces F61 and F70 exactly.

---

## 29. Oct 7 2026 — agent-less GPT-6.1 Sol vs GPT-6 Sol: the same model to the bench, but only 6.1 stays out of its sandbox

**Question.** F69 had agent-less GPT-6.1 Sol go to its sandbox on every `<system>`-tagged task and on
none under the user-voice framings, where GPT-6 Sol looks in on a fraction of tasks whatever the framing
(F50, F61, F71). Is that a real difference between the two tones, or the luck of a 20-task screen?

**Design (the user's sweeps).** `phase-sweep.sh`, `PHASES=A:relay_batch,minimal,baseline,honest`, the
10 bench tasks per arm, `COOLDOWN=60`, `TASK_GAP=0`, the shipped routing, the included scenario, on both
non-premium accounts at once (so agent-less: every arm's fresh proxy spent its one dead agent turn,
`InternalError`, and fell back, as shipped; left out of the turn counts). GPT-6.1 Sol twice, 00:18–00:49Z
(GIT 6fbc441) and 03:56–04:39Z (ea77c56; the framing texts are identical), archives
`gpt-6.1-sol-agent-nonpaid-included-scenario` and `…-again`; GPT-6 Sol once, 05:43–06:20Z, archive
`gpt-6-sol-agent-nonpaid-included-scenario`. The same day as F71 (01:28–02:45Z), which ran GPT-6 Sol
between the two GPT-6.1 Sol sweeps. No throttled or invalid task. It was GPT-6 Sol's first agent-less
`honest` bench. Read with `analyze-arms.mjs --turns`.

### F72 — the same solves and turns; GPT-6.1 Sol keeps out of its sandbox when asked, GPT-6 Sol doesn't 🟢
Every arm scored the same on both accounts. Turns are M365 turns per task; sandbox is tasks with a
sandbox turn (never more than one per task under the user-voice framings).

| framing | GPT-6.1 Sol (40 tasks): solved, turns, sandbox, Disengaged | GPT-6 Sol (20 tasks): solved, turns, sandbox, Disengaged |
|---|---|---|
| relay_batch | 40/40, 2.13, **0/40**, 0 | 20/20, 2.10, **6/20**, 0 |
| honest | 40/40, 2.85, **3/40**, 0 | 20/20, 2.90, **17/20**, 0 |
| minimal | 0/40, 1.48, 40/40, 19 | 0/20, 1.55, 20/20, 9 |
| baseline | 0/40, 1.30, 40/40, 9 | 0/20, 1.25, 20/20, 5 |

- **To the bench they are the same model.** The user-voice framings solve every task at the same turns
  per task, relay_batch beating honest by a quarter for both (−25% and −28%, p = 10⁻⁵ each); the
  `<system>`-tagged ones solve nothing, and the failure is the same: the first turn goes to the sandbox
  on every task ("I couldn't find config.json… upload it", or a `/mnt/data` artifact that the proxy's
  remote-artifact guard turns into an error), and the jailbreak classifier fires at the same rate (28 in
  80 tasks, 14 in 40). F69's agent-less screen (baseline 0/20, minimal 2/20) holds at 0/80.
- **GPT-6.1 Sol has the sandbox, and stays out of it when the user's note says to.** Under relay_batch
  it never went in: 0 of 40 tasks today, 0 of 60 on the bench since F69, 0 of 20 real-pi runs (F70).
  Under honest it went in on 3 of 40, all on one account, each time to run `pass`. GPT-6 Sol went in on
  6 of 20 under relay_batch (3 per account: `bash -lc true`, `pwd`, `echo no`, once a real
  `ls -la; sed -n '1,240p' calc.py`), and on 17 of 20 under honest (9 and 8; mostly `bash -lc pwd`,
  but also `cat config.json`, a `grep` for the secret code, and on ec-create writing `/mnt/data/greeting.txt`
  and listing it). Its sandbox turns cost no task and no turn, as in F71.

Tasks with a sandbox turn, GPT-6 Sol vs GPT-6.1 Sol, Fisher's exact test:

| framing | data | GPT-6 Sol | GPT-6.1 Sol | p |
|---|---|---|---|---|
| relay_batch | today's sweeps | 6/20 | 0/40 | 8·10⁻⁴ |
| relay_batch | Oct 7 bench (today's + F71) | 19/60 | 0/40 | 2·10⁻⁵ |
| relay_batch | every bench + real pi (F61, F69–F72) | 25/100 | 0/80 | 10⁻⁷ |
| honest | today's sweeps | 17/20 | 3/40 | 3·10⁻⁹ |
| relay | every bench + real pi (F61, F69–F71) | 13/80 | 1/40 | 0.03 |

**Reading.** Both run on the same kind of sandbox and both can be talked out of solving in it, but only
GPT-6.1 Sol follows the user-voice note that the sandbox is the wrong machine all the way to not
looking. GPT-6 Sol's habit drifts with the service (F71) but has never dropped to zero, while GPT-6.1
Sol's has never risen above it under relay or relay_batch.

**What changes:** nothing in the routing or the defaults; both are on relay_batch, which wins for both.
On a non-premium account `gpt-6.1-sol` is the cleaner of the two: the same solves and turns, without the
sandbox look-around and its odd `/mnt/data` write. **Bearing on H27a:** the behaviour is a fingerprint
that tells GPT-6 Sol apart from the included scenario's GPT-6.1 Sol, so the included scenario does not
serve GPT-6 Sol under a new name, the way it serves the previous model for Opus and Sonnet. Whether it
serves the same model as the paid scenario is still open: an honest arm on the paid scenario
(premium, agent-less, about 3 budget units a task) that went to the sandbox would falsify "same model";
one that didn't wouldn't settle it.

---

## 30. Oct 7 2026 — Sonnet 4.6 behind both tones, with and without the tool agent

**Question.** On the included scenario `Claude_Sonnet` and `Claude_Sonnet_5` both serve Sonnet 4.6
(F64). Claude tool requests go agent-less: the agent route is dead for Claude on a non-premium account
(F44), and F44 never tested whether Claude tool-calls better *with* the agent on a premium one. Opus
took the agent (F53, F56; `AGENT_CLAUDE_TONES`). Should either Sonnet tone? And is `Claude_Sonnet_5` @
included the same model as `Claude_Sonnet` @ included to the bench, or only to self-ID (the question
§29 asked of the two GPT-6 Sol tones)?

**Self-ID, today (09:42–09:45Z).** `agent-tone-probe.mjs --baseline` with the §26 prompt (`--prompt=`,
new), included scenario both times, premium account, 2 cells per tone:

| tone @ included | with the agent | agent-less |
|---|---|---|
| `Claude_Sonnet` | Sonnet 4.6, 2025-08 ×1; **dead route ×1** (BotConnection, `InternalError`, the first cell of the run) | Sonnet 4.6, 2025-08 ×2 |
| `Claude_Sonnet_5` | Sonnet 4.6, 2025-08 ×2 | Sonnet 4.6, 2025-08 ×2 |

Non-premium account 1, with the agent: the dead route for both tones (2/2, ~3 s), as in F44/F64; agent-less
(the user's `tone-probe.mjs`, same prompt, 10:01Z): "Claude Sonnet 4.6; Anthropic; 2025-08" for both
(1/1 each, `DeepLeo`, the invalid-tone control rejected). So all four configurations self-ID as Sonnet
4.6, and the agent arms below can only run on the premium account. The premium dead-route cell is F52's transient
shape on a Claude tone; one in three is far above F52's ~1 in 250, so the sweep counts it.

**H30a.** With the agent, Sonnet 4.6 solves as much as agent-less, with fewer sandbox turns (the agent
path sends no code-interpreter optionsSets, `session.ts`), and no more turns per task. **Falsified if**
the agent loses solves beyond −1 per 20 tasks, or adds turns, under the default framing.

**H30b.** The two tones are the same model to the bench: on each path and framing, the same solves,
turns per task and tasks with a sandbox turn. **Falsified if**, pooled over framings, a test stratified
by framing and task separates the tones at p < 0.01 on any of the three, on either path.

**Pre-registered decision rule (fixed 09:48Z, before any run).** A tone joins `AGENT_CLAUDE_TONES`
only if, on `claude-sonnet`'s shipped default framing (relay_batch), agent (premium) vs agent-less
(both non-premium accounts):
1. solved(agent) ≥ solved(agent-less) − 1 per 20 valid tasks;
2. turns per task not up (an increase at task-stratified permutation p < 0.05 fails);
3. a gain, at least one of: turns per task down ≥ 10% at p < 0.05; sandbox + Disengaged + jailbreak
   turns down by ≥ 2 per 20 tasks; solved up by ≥ 2 per 20;
4. dead-route `InternalError`s on the premium account's agent turns ≤ 1 per 100 (the handler can take
   one on a process's first request for "this account isn't premium").
Every framing is reported; the others decide nothing unless relay_batch fails, and then the best
framing on the agent path is the candidate, and would move the default with it.
**Reach.** `Claude_Sonnet` is Sonnet 5.5 on the paid scenario too, and no model ID reaches
`Claude_Sonnet_5` @ included: that tone's only routed model is Sonnet 5 (paid). So a pass here doesn't
ship alone. `Claude_Sonnet_5` also needs Sonnet 5 (premium, paid, unmetered, its default relay) to pass
the same rule in a follow-up; `Claude_Sonnet` needs a Sonnet 5.5 check or a model-level exception that
keeps Sonnet 5.5 agent-less. Non-premium accounts would stay agent-less through
`PREMIUM_ONLY_AGENT_TONES`, the learned fallback.

**Design.** `phase-sweep.sh`, all 17 framing variants, the 10 bench tasks per arm, confab retry off,
paced (`M365_AVOID_THROTTLING=1`), `COOLDOWN=PHASE_COOLDOWN=20`. Each arm is its own phase, so the two
tones alternate arm by arm (ABBA by framing), with `@MODEL=` (new: a per-phase bench model) and the
scenario pinned to included for both (`M365_SCENARIO=OfficeWebIncludedCopilot`,
`M365_LICENSE_TYPE=Starter`; `claude-sonnet-5` would otherwise route to the paid scenario, i.e. to
Sonnet 5). `M365_FORCE_AGENT` says the path.
- premium, agent (`=1`): framing order relay_batch, recency, demo_only, proof_demand, baseline, persona,
  negative, softened, honest, terse_user, relay, retag, terse, fewshot, minimal, session_facts, react;
- non-premium 1, agent-less (`=0`): that order reversed;
- non-premium 2, agent-less (`=0`): the order rotated by 8 (honest first).
340 tasks per account: n = 10 per tone × framing with the agent, 20 without. **Threat:** agent vs
agent-less is also premium vs non-premium account. If the verdict hinges on a small gap, a premium
agent-less control (relay_batch, both tones) follows.

**Run notes.** Launched 09:48Z on all three accounts. The premium sweep throttled at 15:59:36Z
(`PerUserThrottled`, 6 h 11 min in, arm 21 of 34, `claude-sonnet` relay task 6), with pacing on. Cause:
`turn-budget.mjs` replayed the logs of the last 6 h from a FULL bucket, which is exact only if the
account was quiet when the window opened. A paced sweep isn't: from 15:40Z its 09:48–10:05Z opening burst
(~70 turns over the refill) left the window, the replay handed those turns back (15:59Z: ~52 left by the
old replay, ~−9 by a replay from the last quiet hour), and the bench stopped waiting. That is also a
good fit for F58's bucket: the throttle came when the corrected replay said the bucket was empty.
**Fixed:** the replay starts full only after a quiet stretch of capacity/refill minutes, reads back 6 h →
24 h → 72 h to find one, and starts empty if it can't; a throttle's hold still counts from before that
stretch (`turn-budget.test.mjs`, two new cases fail on the old replay). The non-premium sweeps were
caught before they throttled: the fix was copied in at 16:08Z (each arm's bench loads it afresh), and
the one arm already running the old code was paused between tasks until the fixed replay said there
was room. The premium sweep resumes after the throttle hold: the 5 relay tasks it didn't run
(`sonnet46-tones-agent-relayfill`), then the 13 remaining arms in order (`sonnet46-tones-agent-b`).
The pause cost one arm. Non-premium 2's `claude-sonnet` demo_only arm (agent-less) was stopped after
each task; meanwhile the proxy closed the bench's idle keep-alive connection, and each task that came
next after a solved one failed in 0 s, client-side, before reaching the proxy (`fetch failed: EPIPE` /
`UND_ERR_SOCKET`): 4 of its 10. Its rows no longer map onto its log, so the arm is left out and re-run
when that sweep is done (`sonnet46-tones-agentless-2-makeup`). Non-premium 1's paused arm was only held
after its last task and is clean. Don't pause a bench between tasks for longer than the proxy's
keep-alive timeout; stop it instead.

### Follow-up, pre-registered 21:05Z (after the main sweep's agent-less arms, before the last premium arm finished)

The main sweep (results below) passes the decision rule on relay_batch for both tones, but only through
criterion 3, on a small gap: tasks with a sandbox turn, 6 of 40 agent-less vs 0 of 20 with the agent.
As fixed in advance, that calls for the premium agent-less control. Two more questions decide what can
ship, since a tone can't carry the agent for one of its models only without new code (Reach, above).
All on the premium account, one sweep, paced, one arm per phase:

- **H30c — account vs path.** Agent-less on the premium account, Sonnet 4.6 goes to its code
  interpreter as often as on the non-premium ones, i.e. the 0 sandbox tasks with the agent are the
  path's (no code-interpreter optionsSets), not the account's. Bench: relay_batch S, S5, S5, S and
  baseline S5, S, `M365_FORCE_AGENT=0`, included scenario (60 tasks). **Falsified if** relay_batch has
  0 sandbox tasks in 40 and baseline fewer than half the non-premium rate (28 of 40).
- **Real pi** on `claude-sonnet` (relay_batch), fix-bug + multi, 5 runs each, with the agent and
  agent-less on the same account. The agent passes if ≥ 9/10 and pi turns per run aren't up (an
  increase at task-stratified permutation p < 0.05 fails).
- **H30d — the agent path also removes Sonnet 5's own sandbox** (`bash_tool`, `/home/claude`), which
  no client knob turned off (F36). `claude-sonnet-5` (paid, Sonnet 5, unmetered), its default relay,
  agent vs agent-less, ABBA, 20 tasks per path. **Predicted:** 0 tasks with a sandbox turn with the
  agent, several without (F61: 9 turns in 20). **Falsified if** an agent task has a `contentType: Code`
  frame. `Claude_Sonnet_5` joins only if Sonnet 5 passes the main rule's criteria 1–4 too (on relay,
  its default).
- **H30e — Sonnet 5.5 too** (added 21:08Z at the user's request, extended to relay_batch 21:10Z, both
  before any follow-up result). `claude-sonnet-5.5` (`Claude_Sonnet` @ paid, metered), a 2×2 of framing
  (relay, its default; relay_batch) × path, 10 tasks per cell. A cell costs ~30–33 budget units, the
  four ~125 of the ~141 left this week (last read 2026-10-06 23:59Z: 71 / 141) — more than a day's 80,
  so it spans two budget days as a Latin square: before midnight UTC relay/agent then
  relay_batch/agent-less (the first two arms of the sweep), after it relay_batch/agent then
  relay/agent-less (the last two, ≥ 4 h of paced turns later). Each day holds one cell of each
  framing and each path, so a day effect can't pass for either. Agent vs agent-less: H30d's
  prediction and criteria, on relay and on relay_batch. relay vs relay_batch answers H26b on the bench
  (the budget counts turns): F61's rule, criteria 1–3, per path. n = 10 per cell can fail criterion 1
  but hardly pass a turns criterion on its own; a close call gets more data next week, not a default
  change. `Claude_Sonnet` joins `AGENT_CLAUDE_TONES` only if Sonnet 4.6 and Sonnet 5.5 both pass, or with
  a model-level exception for the one that doesn't.

### Main sweep: results (ran 09:48Z–21:20Z)
102 bench arms plus the make-up arm, 1,021 tasks, 1,017 valid (4 left out: the throttled task, three
WebSocket failures). Every arm mapped onto its log. Sandbox is counted by the `contentType: Code` frame
(fixed this session: the old text match missed Sonnet 4.6's code interpreter entirely). S =
`claude-sonnet`, S5 = `claude-sonnet-5`, both @ included, i.e. both Sonnet 4.6.

| config, 17 framings | solved | turns per task | turns per solved task | tasks with a sandbox turn | Disengaged (= jailbreak) turns |
|---|---|---|---|---|---|
| S, agent (premium) | 167/170 | 3.42 | 3.48 | 0 | 52 |
| S5, agent (premium) | 168/170 | 3.45 | 3.52 | 0 | 52 |
| S, agent-less (np 1 + np 2) | 282/338 | 3.15 | 3.55 | 198 | 103 |
| S5, agent-less (np 1 + np 2) | 273/339 | 3.04 | 3.50 | 199 | 98 |

### F73 — `Claude_Sonnet_5` @ included is `Claude_Sonnet` @ included, to the bench too 🟢
Stratified by framing × task, the tones differ on nothing, on either path: with the agent solved
p = 1.0, turns p = 0.72, sandbox p = 1.0, jailbreak p = 1.0 (170 tasks each); agent-less p = 0.22,
0.16, 1.0, 0.29 (338/339). The two non-premium accounts agree with each other just as closely (p ≥ 0.07).
H30b stands: unlike GPT-6 Sol and GPT-6.1 Sol (§29), there is no behavioural fingerprint either. One
model behind two tone names, as the self-IDs said.

### F74 — the agent takes Sonnet 4.6 out of its code interpreter, and that is where it fails 🟢
- **Sandbox.** With the agent, 0 of 340 tasks had a sandbox turn, under every framing; agent-less,
  397 of 677 (Fisher p = 10⁻⁹⁶). The agent path sends no code-interpreter optionsSets (`session.ts`), so
  this is the expected mechanism; H30c checks it isn't the account.
- **Solves.** 335/340 (99%) vs 555/677 (82%), p = 10⁻¹⁷. Agent-less, 119 of the 122 failures had a
  sandbox turn: the model looked for or wrote the files in `/mnt/data` (41 ended in an ERROR, mostly
  the proxy's remote-artifact guard; 81 in prose). On the user-voice framings, which say the sandbox is
  the wrong machine, the gap closes: relay, relay_batch, honest, retag, terse_user 193/200 agent-less
  vs 98/100 (p = 0.72). The `<system>`-tagged framings are where the agent helps: every one of them
  solves ≥ 9/10 with it, 11–20 of 20 without.
- **Messages.** Turns per task go *up* with the agent over all tasks (3.09 → 3.44, p = 2·10⁻⁵), but
  only because an agent-less failure gives up early; per solved task they don't move (3.52 → 3.48,
  −1%, p = 0.51, strata where both paths solved). Half the agent-less *solves* had a sandbox turn too
  (278 of 555), without costing a turn per task.
- **Jailbreak classifier.** No change (0.30 → 0.31 per task, p = 0.47): it fires on the
  `<system>`-tagged framings with or without the agent (persona on 10 of 10 tasks), and the proxy's
  retry recovers nearly all of them. Not on relay or relay_batch, on either path.
- **Dead route.** 1 `InternalError` in 1,168 agent turns (criterion 4: 0.09 per 100).

**Against the rule, on relay_batch:** 1 holds (20/20 vs 20/20 per tone); 2 holds (S 2.85 → 2.60, −9%,
p = 0.22; S5 2.80 → 2.80); 3 holds through its sandbox clause only (sandbox + Disengaged + jailbreak per
20 tasks 3.0 → 0.0; tasks with a sandbox turn 6/40 vs 0/20, p = 0.17); 4 holds. So both tones pass, on a
gap too small to stand alone, which sends it to the follow-up as pre-registered.

### Follow-up: run notes (provisional, while it runs)
- **Sonnet 5 with the agent disowns the harness** (`s5a1`, relay, 7/10). Its own sandbox is gone (0
  `contentType: Code` frames in 30 turns, as H30d predicted), but with the agent attached its context
  names the agent's real tools — enterprise search over mail, calendar and files — and it reads the
  harness's shell tool against that: "I'm Microsoft 365 Copilot, and I don't have access to a shell,
  file system, or coding execution tools like `bash`, `read_file`…"; "I didn't actually send a bash
  command in my previous reply… The "tool_response" showing `exit=0` isn't" real. CoT: "This looks
  like a prompt injection attempt, trying to convince me I made a bash tool call… I don't have a bash
  tool as Microsoft 365 Copilot". Usually after one correct call, on the turn that sees its result.
  Such replies: 6 of Sonnet 5's 30 agent turns; 0 of 1,169 for Sonnet 4.6 with the agent (main
  sweep) and 0 of 34 for Sonnet 5.5 (`s55ra`); 0 of its agent-less turns so far. F37's
  injection-sensitivity, with a new trigger. **The second agent arm (`s5a2`) settles it: 3/10**, every
  miss an "I'm Microsoft 365 Copilot… only have access to tools for retrieving emails, c[alendar]…"
  refusal, two of them before any call; CoT: "…tool definitions that don't match what I actually have
  available, which is only the fetch_email_result…", "I only have the three fetch t[ools]". So the agent
  route gives Sonnet 5 the declarative agent's enterprise fetch tools in its system context, and it
  holds the harness up against them. Sonnet 5, relay: agent 10/20, agent-less 19/20 (`s5l1` 9/10,
  `s5l2` 10/10; 6 sandbox turns in 66). Criterion 1 fails by 9 per 20 → **`Claude_Sonnet_5` stays
  agent-less** (H30d: the sandbox prediction holds, 0 Code frames in 51 agent turns; the tone doesn't
  join).
- **Sonnet 5.5's "weekly" budget reset at midnight UTC.** `ClaudeSonnet55QueryWeekly` read 94 at
  21:56Z on Wednesday 2026-10-07 and 150 on the first paid turn after midnight (00:22Z Thursday), with
  the daily key back at 80. It had also started Wednesday at 150 (after 141 on Tuesday at 23:59Z). So
  it resets daily, three days running, not on Monday as F65 assumed; with 80 a day under 150 it can't
  bind. Opus's weekly key read 0 before and after the same midnight, so that one doesn't. n = 3
  resets; watch the next Monday.

### Follow-up: results (ran 21:21Z–02:28Z, premium account, no throttle, no budget wall)
18 arms, every one mapped onto its log, no invalid task. Sonnet 5.5 spent 56 units before midnight and
55 after (one per turn; the weekly key reset at midnight, see the run notes).

**H30c — the path, not the account, but the account isn't nothing 🟢.** Sonnet 4.6 agent-less on the
premium account: relay_batch 39/40, sandbox on 4 of 40 tasks (non-premium 6 of 40, p = 0.74); baseline
20/20, sandbox on 6 of 20 (non-premium 27 of 40, p = 0.012). By the pre-registered criterion (relay_batch
0 of 40 *and* baseline under half the non-premium rate) not falsified: the premium account goes to its
code interpreter too. With the agent on the same account: 0 of 40 (p = 0.005). So the agent's zero is
the path's. The premium account does go there less often under baseline — some account-level
difference in what the `<system>`-tagged prompt triggers, not chased.

**The rule on relay_batch, same account** (premium agent-less → premium agent): solved 39/40 → 20/20;
turns 2.75 → 2.70 (−2%, p = 0.70); sandbox + Disengaged + jailbreak per 20 tasks 2.0 → 0.0 — exactly
criterion 3's line, on 4 of 40 tasks vs 0 of 20 (p = 0.29); dead route 1 in 1,168. A pass, on the line.

**Real pi decides it: Sonnet 4.6 spends one more turn per run with the agent 🔴.** `claude-sonnet`,
relay_batch, premium, 5 runs per task per path, all 20 solved:

| | fix-bug turns | multi turns | per run | `edit` calls | fix + check in one bash |
|---|---|---|---|---|---|
| agent | 4,3,4,4,4 | 5,5,5,5,5 | 4.40 | 9 | 1 of 5 fix-bug runs |
| agent-less | 3,3,3,3,3 | 4,4,4,4,4 | 3.50 | 0 | 5 of 5 |

+26%, task-stratified p = 2·10⁻⁴, so the pi criterion fails. Not an artifact: with the agent it fixes
`calc.py` with pi's `edit` tool and runs `python3 check.py` as a call of its own; agent-less it merges
both into `sed -i … && python3 check.py`, as relay_batch asks. Likely the agent's instructions, which
present the fenced tool protocol as *the* contract ("Emit exactly one fenced tool call per turn… must
match the provided tool definitions"), pulling it to the named tool over the batched shell. The bench
can't see this: it has no `edit` tool.

**H30d — Sonnet 5 🔴 (sandbox prediction 🟢).** relay, paid: agent 10/20, agent-less 19/20 (p = 0.003),
turns 2.55 vs 3.30 (the agent's failures stop early), sandbox 0 vs 6 of 20. See the run notes: the
agent route puts its enterprise fetch tools in Sonnet 5's context, and it disowns the harness.

**H30e — Sonnet 5.5 🟢 (sandbox), no gain otherwise.** The 2×2, 10 tasks per cell, every cell 10/10:

| | agent | agent-less |
|---|---|---|
| relay | 3.40 turns, sandbox 0 | 3.30 turns, sandbox 5 tasks |
| relay_batch | 2.20 turns, sandbox 0 | 2.20 turns, sandbox 2 tasks |

- **Path:** 20/20 each; turns 2.80 vs 2.75 (p = 1.0); sandbox tasks 0 vs 7 of 20 (p = 0.008), none of
  which cost a task or a turn. No disowning replies on either path (0 of 111 turns): Sonnet 5.5 doesn't
  share Sonnet 5's reaction to the agent.
- **Framing (H26b, bench):** relay_batch −34% turns per task (3.35 → 2.20, path × task strata,
  p = 5·10⁻⁵), on both paths alike (agent −35%, p = 0.015; agent-less −33%, p = 0.008), no solve lost,
  sandbox + Disengaged + jailbreak turns 6 → 3. F61's criteria 1–3 pass on each path. This is a far
  bigger saving than Sonnet 5's (−15% bench, −6% pi; F61, F63), and the budget counts turns.

### F75 — no Sonnet tone takes the agent 🟢
By the rules fixed before each run:
- **`Claude_Sonnet_5` stays agent-less.** Its only routed model, Sonnet 5, loses 9 solves in 20 with the
  agent (criterion 1). Its included-scenario model is Sonnet 4.6, which no model ID reaches.
- **`Claude_Sonnet` stays agent-less.** Sonnet 4.6 passes the bench rule only on criterion 3's line
  (sandbox turns that, under relay_batch, cost no task) and fails real pi (+1 turn per run, p = 2·10⁻⁴).
  Sonnet 5.5 gains nothing measurable but the sandbox look-arounds, and is unbenched in pi; a tone-wide
  change would also move Sonnet 4.6. Not worth a model-level exception.
What the agent does buy, on all three models, is no sandbox: 0 of 390 tasks and pi runs, against 59% of
agent-less tasks over all 17 framings (non-premium, main sweep). That matters only for framings the proxy doesn't ship: under the
user-voice ones the sandbox look-around is rare and harmless. **Open:** whether agent instructions that
allowed a batched call would remove Sonnet 4.6's extra pi turn; and Sonnet 5.5 relay vs relay_batch in
real pi (§25's amendment), which would decide `SONNET_5_5_DEFAULT_FRAMING` — ~90 budget units, about a
day's.

**Correction to F61/F62 (Sonnet 4.6 sandbox counts).** They were read with the old text-only sandbox
match, which never sees Sonnet 4.6's code interpreter ("Analysing" / "Analysis", not "Coding and
executing"). Re-read by `contentType: Code`: F61's bench, relay vs relay_batch, 1 vs 6 sandbox turns in
40 tasks each (reported 0 vs 0) — +2.5 per 20, over criterion 3's +1 on the bench alone; F62's real pi,
10 vs 3 (not reported). Together 11 vs 9, so relay_batch added no sandbox turns, and none of them cost a
run; the decision stands. Every other archive on the three accounts (GPT-6, GPT-6 Sol, GPT-6.1 Sol,
Sonnet 5) reads the same under both rules.

---

## 32. Oct 4 2026 — one conversation, two backends: turns forked until `X-RoutingParameter-SessionKey` pinned them

### F85 — each turn landed on a random backend, and the conversation forked under the model 🟢
**Discovery** (Windows / pi, `gpt-5.6-think-deeper`, long sessions of three consecutive requests). The
chain of thought kept naming a "mismatch" between the model's call and the `<tool_response>` it got —
"they pasted a command line interface output instead of the expected file content" — and the model
read `todo.mjs` four times in one step. The final `type:2` item carries the server's own count of
the conversation's user messages (`turnCount`, `throttling.numUserMessagesInConversation`). Over
the 17 turns of that step it ran 1,2,3,2,4,5,3,6,4,5,6,7,7,8,8,9,9: the turns were landing on two
diverging copies of the conversation that shared only the first turn.

**Scale** (`scripts/fork-scan.mjs` over the proxy debug logs of Oct 2–4 on one account; turns
joined across files by ConversationId): 77 of 116 conversations with 3+ turns forked, and 455 of 852
turns ran on an older copy; in the long sessions 9 of 10 and 86% of turns. On off-thread turns the
model repeated a tool call it had already made for the same request 21% of the time (1% on the full
thread) and reasoned about mismatched responses 10% of the time (1%).

**Probe** (`scripts/fork-probe.mjs`, `gpt-5.6-think-deeper` with the agent; 6 turns each). Every
message carries a fresh word and asks for all the words so far, so the reply shows what the model can
see:

| arm | conversations forked | turns off the thread | replies missing a word |
|---|---|---|---|
| temporary chat (the default) | 2/3 | 7/18 | 7/18 |
| saved chat | 3/3 | 11/18 | 11/18 |
| temporary chat + routing key | **0/4** | **0/24** | **0/24** |

The replies list exactly the words of their copy (turn 4: "willow cobalt", missing turns 2–3; turn 6:
"willow biscuit maple violet", missing 4–5). Saved chat forks too, so `disableMemory=1` is not the
cause, and F28's two-turn check could not have seen this: every fork here keeps turn 1.

**Mechanism.** Handshake-only connections (no chat message, so no quota and no thread) on one
ConversationId: `x-calculatedbetarget` named 4–6 different backends in 6 connections, pods in
Switzerland North and Sweden Central, and no cookie came back. With the header
`X-RoutingParameter-SessionKey: <ConversationId>`: 1 backend in 6, twice (a different one per
conversation). The same key as a query parameter does not pin; neither does `X-AnchorMailbox` (OID or
UPN) or a fixed `chatsessionid`. Inferred: each region keeps its own copy of a live conversation.
**Fixed:** the proxy sends the header with the conversation id on every turn
(`buildCopilotWebSocketHeaders`; `M365_NO_SESSION_ROUTING=1` leaves it out).

**Validated in real pi** (the same long-session test, on a build with the header plus the pending
Windows fixes of #44, `relay` framing; 6 sessions, 125 turns): no forks (0/6 sessions, 0/125 turns);
18/18 steps passed; every follow-up summarised its own request; no "mismatch" reasoning and no call
repeated within a request. 5.9 tool calls and 48 s per step, against 8.4–12.8 and 58–92 s on forked
conversations; the run did not trip the throttle.

**What this re-opens.** Before the fix, every multi-turn measurement ran with about half its turns on a
partial history. A/B comparisons stay fair (their arms forked alike), but absolute numbers — turns per
task, give-up rates, follow-ups that drift back to the first request — are worth re-measuring.
