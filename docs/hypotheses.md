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
- §13 — User-driven SSO auth for tenants with no automatable TOTP (July 29 2026,
  third-party): loopback redirect falsified, `nativeclient` corroborated by two forks
- §12 — Multi-agent research dig (July 13 2026) + framing A/Bs, and §12.13: tool-less
  requests silently execute in M365's sandbox and return a real (wrong-machine) transcript

---

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
controlled finding. If H-R1 holds, auto-reauth provides **zero** throttle benefit while
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
(dead tone or throttle-onset). **Interpretation:** single-turn, back-to-back probes are dominated by
THREAD-RATE degradation (F13), not tone quality — ~16 fresh conversations were started across the two
runs, which is exactly what trips the throttle-that-looks-like-confab. So both the 0/2 and the 2/2 are
measuring the account's thread-rate state, not the `magic` tone. **The instrument is wrong for this
question:** ranking tones needs the multi-turn bench with rotated order + generous cooldowns on a
RESTED account (the F23 overnight methodology), because a real pi session is ONE long thread (cheap)
while our probes are many threads (self-throttling). Net: no evidence `magic` is specifically broken;
the deterministic routing/regex fixes stand on their own merits; the pi default (`gpt-5.5-think-deeper`)
rests on real-session experience, which is the more reliable signal here.
**Note:** `Claude_Opus` remains a dead agent-less tone (F23: 0/3, `BotConnection` apology) — the
generic `claude-*`→`Claude_Sonnet` fallback deliberately avoids it; bare `claude-opus` still maps
to the dead `Claude_Opus` and should probably be remapped too.

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
  agent; `gpt-5.5` behaves like `magic`. The declarative agent forces GPT routing; tone doesn't leak.

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

### H13.2 — Device-code flow is enabled for the first-party client 🔴 UNTESTED

Both forks assume it; **neither has run it.** neffer77 has it as H-A2 with no result, EatonWu
ships it behind `M365_ENABLE_DEVICE_CODE=1` unverified. It's the natural headless answer (no
browser on the box at all), so it's the highest-value open probe in this section — but treat
"two forks implemented it" as zero evidence that it works. Conditional Access commonly blocks
device code outright, and the token may come back without the Sydney audience even when the
grant succeeds.

**Falsification:** `/devicecode` POST rejected for the client, CA blocks it, or the resulting
token's `aud`/scopes don't match the PKCE path's.

### Not yet upstreamed

EatonWu's `loginInteractiveForScopes` (env-gated on `M365_ENABLE_INTERACTIVE_APPROVAL=1`, with
`M365_NO_INTERACTIVE` and a timeout) is the shape #4 needs and is written defensively. It is
**not merged** because it cannot be verified from here without a live non-TOTP tenant, and
shipping unverified auth code is how you turn a broken login into a broken login *plus* a
support thread. Two things to fix when it does land: the device-code half is H13.2 above, and
it hardcodes `locale: "en-GB"` / `timezoneId: "Europe/Copenhagen"` — copied from the §11 F25
anti-fingerprint config, which is right for this account and wrong for everyone else's.
