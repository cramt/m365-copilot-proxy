# Overnight work log (autonomous session, started 2026-06-24 night)

Durable scratch log so work survives context summarization. Newest entries at top.
Goal: usable coding agent in pi/openclaw via the prompt-emulated shell-routing path.

## ☀️ END-OF-NIGHT SUMMARY (for Alex, ~05:30 2026-06-25)

**Headline: the ultimate goal is VALIDATED.** Real `pi` (the actual coding agent, headless),
backed by M365 Copilot through the proxy, fixes a real bug end-to-end **10/10** (F20, mean 107s,
zero failures). The proxy drives a genuine agentic loop reliably on the core find-and-fix task.
**Generality check:** a harder MULTI-FILE bug (read→run→reason→fix across files) = **3/4** via
real pi; the 1 miss was a hallucinated "OK" with the file unfixed — the honest residual tail on
harder tasks (~10-25%, n small) that framing+detectors don't fully close. The loop generalizes;
perfection on hard tasks doesn't. Net: a genuinely usable coding agent for everyday find-and-fix work.

**What the night produced** (all on a 2-week-rested account that stayed **zero-throttle the
entire ~5.5h** — F13 thread-throttle never fired once; spacing worked):
- **F20** 🟢 — real pi fixes a bug 10/10 end-to-end (the goal; principle-#3 validation).
- **F19** 🟢 — the §8.12 fakeable-task hallucination is **closed**: fizzbuzz 9/1, count-lines 9/1
  SOLVED (was ~0/5). Driven by the shell-routing framing (model acts turn-1), not the detector.
  Confab-retry (F16) **validated live** (fired 2×, salvaged both).
- **F18** 🟡 — framing A/B: the **shipped `baseline` is near-optimal** (100% on solvable tasks,
  tied with `fewshot`); aggressive framings BACKFIRE (`persona` 0%, Disengages even fix-bug).
  Actionable: don't replace baseline with a "stronger" prompt.
- **F17 + F21** 🟢/🟡 — **the one real gap, fully characterized:** requests shaped as
  "replace literal X→Y in a file" trip the Disengaged filter — driven by **file-edit framing
  weight + the declarative agent** (plain/light = fine; heavy framing or the agent = Disengage),
  independent of config/port/json wording or the numbers. Confirmed to bite real pi (3/3).
  **No clean auto-fix** (reliable tool-calling needs the agent, which is what Disengages these);
  the current fail-fast 502 is the right behavior. Workaround is request-level: "fix/implement"
  asks that don't pre-state the literal replacement sail through.

**Harness improvements** (code is cheap; these made the science possible): throttle-aware
overnight orchestrator with strategy+task rotation and DISENGAGED-vs-THROTTLE classification
(`scripts/bench/overnight-sweep.sh`); real-pi reliability harness (`scripts/bench/pi-reliability.sh`,
`TASK=`); Disengage probes (`scripts/disengage-*probe.mjs`); fakeable-hallucination detector
broadening (`fc92498`, unit-tested — correct insurance, though framing made it rarely needed).

**Mistakes I caught mid-flight** (logged in Timeline): orchestrator wasted a 30-min backoff on
Disengaged-misread-as-throttle (fixed, wake-2); task-position confound made edit-config look
content-driven (fixed via task rotation, wake-4); wake-5 "task-content" reading of F17 corrected
twice (→ agent path, → framing-weight) as probes refined it.

**Open threads for you to steer** (none blocking): (a) a handler-level minimal-framing agent-less
retry could be tested but looks not-worth-it (trades 502 for silent non-completion); (b) more
F18 rounds for tighter n; (c) pi on multi-file/harder tasks. Commits: f603203→33c0e4e + the F21
doc commit. Proxy still running on :4141; framing sweep stopped.

---

## Operating constraints (self-reminders)
- SEQUENTIAL only. One M365 thread at a time. Long cooldowns between thread-heavy runs.
- Offline work (code, tests, analysis, docs) = no quota → run freely.
- Live work (bench/pi/probes) = burns quota + thread-rate throttle → space with ~1h cooldowns (ScheduleWakeup).
- Every Bash call has an explicit timeout. Long waits via ScheduleWakeup, not foreground sleep.
- n=1 is noise. Confirm winners with --repeat, rotate order.
- Native tool-calling is OUT OF SCOPE (licensing). Improve prompt-emulated path only.

## Plan / phases
- [x] P0 recon code (handler detectors, fenced strategies, bench harness)
- [x] P1 OFFLINE: fakeable-task hallucination detector broadened + unit tests → commit fc92498
      (catches §8.12 "Created fizzbuzz.py and executed it with python3."; FP-guarded; gated on !everActed)
- [ ] P2 OFFLINE: verify A/B framing sweep is runnable (mock proxy), prep configs
- [ ] P3 LIVE (spaced): auth smoke → framing A/B sweep → ~10x pi fix-bug → validate F16
- [ ] P4 analyze + write up findings into hypotheses.md, graduate conclusive ones

## Notes
- count-style pure-result hallucinations ("the file has 42 lines") deliberately
  NOT matched — too FP-risky vs real answers. §9 says fakeable tasks also need
  task-redesign; the create+execute pattern is the clean proxy-side win.

## LIVE STATE (read this first on wake-up)
**Framing sweep is STOPPED (its job is done — F18/F19 graduated).** Current background job is
the **real-pi reliability run** (task `bc9hv50md`): `scripts/bench/pi-reliability.sh` N=10,
driving the actual `pi` agent headless against the proxy on fix-bug, verifying each.
- Results CSV: `/tmp/m365-pi-reliability.csv` (run,ts,outcome,elapsed,dir); log `/tmp/m365-pi-rel.log`.
- Needs nix (pi) + python3-from-nixpkgs (resolved inside the script); runs ~20 min.
- On wake: read the CSV → comply-rate (SOLVED/10). If solid, GRADUATE F20 (real-pi end-to-end
  comply-rate, the F14 "~10x" ask). FAIL dirs are kept (pi.out) for diagnosis.
- Proxy still persistent on :4141 with M365_FRAMING_FILE=/tmp/m365-framing (control file currently "minimal").
- To resume the framing sweep for more F18 n: ROUNDS=30 CELL_COOLDOWN=120 bash scripts/bench/overnight-sweep.sh &

### (history) earlier bg sweep tasks: brgoh98x5 (wake-5), b8kcmtnfm (wake-4), bemd9qspp, b1ilyr1u0.
- **Grid NOW:** `TASKS="fix-bug fizzbuzz count-lines"` × 10 strategies. Dropped edit-config
  (conclusive: 100% Disengaged, F17) + find-needle (DIS story told). Added fakeable tasks
  fizzbuzz+count-lines to **validate the hallucination detector (fc92498/F16) LIVE** — on a
  fakeable task, SOLVED ⟺ the model REALLY wrote+ran (bench verifier runs in-sandbox), so
  SOLVED-rate = how often detector+framing force real action instead of a hallucinated "done".
- **Orchestrator:** `scripts/bench/overnight-sweep.sh` (rotates BOTH strategy and task order per round).
- **Kill safely:** do NOT `pkill -f overnight-sweep` (matches your own zsh cmdline → exit 144).
  Kill by PID filtered to bash: `for p in $(pgrep -f overnight-sweep); do [ "$(cat /proc/$p/comm)" = bash ] && kill $p; done`.
- **Grid:** 10 framing strategies × 3 unfakeable tasks (fix-bug, find-needle, edit-config),
  ROUNDS=30, CELL_COOLDOWN=120s, rotated order per round. ~90 min/round → expect ~5-6 rounds/night.
- **Results CSV (append-only):** `/tmp/m365-overnight.csv` (round,ts,task,strategy,outcome,tools,msgs,elapsed_s)
- **Per-cell JSON:** `scripts/bench/out/ov-<round>-<task>-<strategy>-<ts>.json`
- **Run log:** `/tmp/m365-overnight.run.log` ; **heartbeat:** `/tmp/m365-overnight.heartbeat`
- **Proxy:** persistent, port 4141, started in `nix develop` with
  `M365_FRAMING_FILE=/tmp/m365-framing M365_DEBUG=1`. Auth = silent-refresh (worked off the
  2-week-old msal-cache). Proxy log: `/tmp/m365-proxy.log`.

### On wake-up, do:
1. `curl -s -m3 http://localhost:4141/health` — if DOWN, restart proxy:
   `nix develop --command bash -c 'M365_DEBUG=1 M365_FRAMING_FILE=/tmp/m365-framing node packages/proxy/bin/m365-proxy.mjs 4141' &` (background), wait for "Listening".
2. Check the background sweep task is still alive; if it died, relaunch overnight-sweep.sh
   (it appends to the same CSV — resumable).
3. Tally CSV: `tail -n+2 /tmp/m365-overnight.csv | awk -F, '{c[$5]++}END{for(o in c)print o,c[o]}'`.
   Many ERROR/PROXY_DOWN in a row = throttle or dead proxy → fix, then let it ride.
4. Once ≥3 rounds done (~n≥3/cell), analyze SOLVED-rate by strategy:
   `tail -n+2 /tmp/m365-overnight.csv | awk -F, '{t[$4]++; if($5=="SOLVED")s[$4]++}END{for(k in t)printf "%-12s %d/%d\n",k,s[k],t[k]}' | sort`
   and write a finding into hypotheses.md §8.12/§9 (graduate if conclusive). Control for order/throttle.
5. Reschedule the next wake-up (~30 min) unless the night's clearly over / data's conclusive.

### Smoke results (baseline, pre-sweep), rested account:
- fix-bug SOLVED 2 tools/3 msgs/51s. Validation r1: fix-bug SOLVED under minimal/terse/baseline (3/3).

## Timeline / entries
- 2026-06-25 04:45 — wake 8 (fired on pi-run completion). **GOAL VALIDATED + F17 bites real pi.**
  - **F20 graduated:** real `pi` fixes the bug end-to-end **10/10** (mean 107s, zero
    confab/disengage/throttle). The ultimate goal — usable coding agent in pi — works. (commit next)
  - **F17 confirmed on real pi:** edit-config "change port 8080" via actual pi → **3/3 DISENGAGED**,
    pi shows the raw 502, file unchanged. Real product gap. Parameterized pi-reliability.sh (TASK=).
  - **Mitigation feasibility = next experiment:** does agent-less (DeepLeo) + shell-routing framing
    still emit ```bash? If yes → "on Disengaged, retry agent-less" rescues these. Need a probe that
    builds the proxy framing (formatMessages) + sends agentId=null + checks for ```bash & no-disengage.
    Also check for an existing M365_NO_AGENT-style toggle in core/handler before writing the probe.
  - LIVE STATE: pi-run done; no bg job running now; proxy still up on :4141. Account zero-throttle ~5h.
- 2026-06-25 04:11 — wake 7. **BIG wake: F17 corrected (major novel finding) + real-pi validated.**
  - F19 firmed: fizzbuzz 9/1, count-lines 9/1 SOLVED. Stopped the sweep (job done).
  - **F17 investigation (probes A/B/C):** plain chat (DeepLeo) does NOT Disengage the exact
    "edit config.json port" prompt or 5 variants (0/12, dea~1e-9). Agent+framing path DISENGAGES
    2/2 every "replace literal X→Y in a file" variant (config.json, settings.txt, value.txt,
    even non-port 42→99) but SOLVES create-file + find-and-fix. → trigger = **substitute-a-literal-
    value request SHAPE on the AGENT path**, not config/port wording or numbers. Corrected &
    rewrote F17 in hypotheses.md §10 (commit e98ab47). New: routing-path × request-shape Disengage axis.
    Candidate proxy mitigation noted (Disengaged-retry that de-literalizes, or route such turns agent-less).
  - **Real-pi end-to-end VALIDATED** (principle #3): wrote scripts/bench/pi-reliability.sh (drives
    actual `pi --print` headless vs proxy, python3 via nixpkgs, per-run nonce for fresh convs).
    Smoke SOLVED 63s; launched N=10 (bc9hv50md), run 1 SOLVED 72s. Pins the F14 ~10x comply-rate.
  - Account STILL zero-throttle after ~4.5h. 2-week rest holds beautifully.
- 2026-06-25 03:03 — wake 6. **Detector/fakeable validation = strong. F19 graduated.**
  - fizzbuzz 9/10 SOLVED (only persona DIS), count-lines 3/3 SOLVED — vs §8.12 baseline ~0/5.
    Almost all tools=1,msgs=2 → model acts on TURN 1 (no hallucination). So the framing closed
    the gap; detector is backstop. Confab-retry fired 2× and SALVAGED both (F16 validated live);
    my fc92498 hallucination broadening fired 0× (no occasion — framing prevents it upstream).
  - **Graduated F19** to hypotheses.md §10.
  - **pi-run prep:** `pi --print/-p` = headless one-shot (good). BUT **python3 MISSING in nix shell**
    → a host pi fix-bug run fails on infra (the F14 snag). Fix later via `nix shell nixpkgs#python3`
    wrapping pi, OR use a bash-only pi task (count-lines uses bash/wc, host-OK).
  - **NEXT (decided):** wind down the bench sweep (it's confirming knowns now) and pivot to the
    **F17 edit-config Disengage probe** — highest RE value, cheap, no plumbing. Probe plan: vary the
    prompt to isolate the trigger — (a) reproduce original; (b) same edit, NO tools (plain chat);
    (c) reworded dropping "config"/"port"/".json" (e.g. "in data.txt change 3000 to 8080");
    (d) framed as a bugfix. Use scripts/_probe-chat.mjs (single-turn, reports messageType). n≈2-3
    each, SEQUENTIAL (stop the sweep first — one thread at a time). Goal: is it the config/port
    wording, the filename, or the tool-framing+config combo that trips Disengaged?
- 2026-06-25 02:28 — wake 5. **Confound resolved + 2 findings graduated + sweep pivoted to goal.**
  - edit-config Disengaged 15/15 across all framings AND now in round-position 2 (not just last)
    → CONFIRMED task-content, not position. **Graduated F17** to hypotheses.md §10.
  - Framing on solvable tasks (n=4–5/strat): fewshot 100%, baseline 100% (shipped default!),
    down to proof_demand 20%, persona 0%. Aggressive framings backfire (more Disengage).
    **Graduated F18** to hypotheses.md §10. Takeaway: keep the shipped baseline; don't go heavier.
  - **Pivoted sweep** (bg brgoh98x5): TASKS="fix-bug fizzbuzz count-lines" — dropped the two
    conclusive tasks, added fakeables to validate the hallucination detector LIVE (the F16
    "not yet validated live" gap). First cell fizzbuzz/minimal SOLVED (real exec).
  - Account STILL zero throttle after ~3.5h / ~60+ threads — 2-week rest holds; F13 not triggered.
- 2026-06-25 01:54 — wake 4. **edit-config Disengaged 8/8 across ALL framings** (incl baseline/
  terse/reply_tool/fewshot). BUT discovered a **confound in my own sweep**: tasks ran in FIXED
  order (fix-bug→find-needle→edit-config), so edit-config was ALWAYS last → task-content vs
  position-in-round perfectly confounded. Time gradient (fix-bug early 10% DIS → find-needle mid
  73% → edit-config late 100%) made this urgent to resolve.
  - **Fix (commit a07f9fe):** rotate TASK order per round too. Killed sweep, relaunched (b8kcmtnfm).
  - **Decisive early result:** round 1 now leads with find-needle, and it Disengaged on minimal
    AND recency *while running first* (rested/early). So find-needle fragility = task-content, not
    position. edit-config now runs 2nd this round — those samples (next wake) settle its case.
  - edit-config benign prompt: "Edit config.json so the port is 8080 instead of 3000." — nothing
    jailbreak-shaped, yet 100% Disengaged. Genuinely surprising RE finding if it holds off-position.
  - **Gotcha:** `pkill -f overnight-sweep` self-matches the harness zsh cmdline → exit 144. Kill
    bash PIDs via /proc/$p/comm filter (now in LIVE STATE).
- 2026-06-25 01:19 — wake 3. Healthy (proxy up, sweep running, hb fresh). 28 cells.
  **Preliminary cross-tab** (ERROR treated as DISENGAGED — all 5 verified Disengaged at wake 2):
  - BY TASK: find-needle SOLVED 2 / DIS 7 /9 (**78% Disengaged**); fix-bug SOLVED 17 / DIS 2 /20
    (10%); edit-config 0 samples yet (round reaches it after find-needle).
  - BY STRATEGY: **persona = worst (0 SOLVED / 4, 100% Disengaged**, only framing to Disengage
    fix-bug too). **fewshot = best so far (4/4 SOLVED, 0 Disengaged**, incl. find-needle).
    Lean framings (baseline/minimal/terse/negative/reply_tool) 2/2 SOLVED, 0 DIS but thin n=2.
    proof_demand 1/4 + 2 DIS, recency 2/4 + 2 DIS, react 2/3 + 1 DIS.
  - Disengaged cells: find-needle|{persona×2,proof_demand×2,recency×2,react×1}, fix-bug|persona×2.
  - **NOT graduated yet** — most cells n≤2. Need ≥~5/strategy + edit-config coverage. Watching:
    persona-is-bad and fewshot-is-strong are the firming hypotheses; find-needle is filter-fragile.
  - Design note (leave for now): task-major ordering over-samples fix-bug (20) vs find-needle (9)
    vs edit-config (0) because each restart resets to fix-bug. OK as long as rounds complete.
- 2026-06-25 00:43 — wake 2. **Found+fixed an orchestrator flaw.** Round 1 reached 14 cells
  then hit a 3-ERROR streak (proof_demand/persona/react on find-needle) → triggered a 30-min
  throttle backoff that recovered NOTHING, because **every ERROR was content-filter Disengaged,
  not throttle** (confirmed in ~/.config/m365-proxy/debug.log: messageType:"Disengaged",
  hiddenText:"> Conversation disengaged", offense:"None"). Account is HEALTHY — zero empty-throttle.
  - **Signal building:** find-needle Disengages across MANY framings (recency, proof_demand,
    persona, react all Disengaged; fewshot SOLVED it); fix-bug only persona Disengaged. So
    Disengaged is per (task-content × framing-shape), consistent with F10.
  - **Fix (commit 91c482c):** orchestrator now reads per-cell JSON to split ERROR →
    DISENGAGED (fail-fast, normal cooldown) vs THROTTLE (F13, long backoff). Only THROTTLE
    trips the streak. Killed old sweep, relaunched with fix (bg task bemd9qspp) at 00:44.
  - **CSV note:** rows now = partial-old-round-1 + fresh-restarted-round-1. Don't trust the
    `round` column as unique runs; AGGREGATE by (task,strategy), each row = 1 independent sample.
  - **Env gotcha:** harness shell is zsh — `[ "$a" \> "$b" ]` string compare FAILS. Use row-count
    deltas / file mtime, not `\>`.
- 2026-06-25 00:09 — wake 1. Proxy UP, sweep alive (heartbeat <1min). Round 1 at 12/30 cells.
  Tally: SOLVED 9, ERROR 2, GAVE_UP_PROSE 1. Pace ~2.8 min/cell → ~85min/round.
  **Early signal (n=1 each, WATCH don't conclude):** both ERRORs were **Disengaged**
  (content filter, confirmed in per-cell JSON), and both were the aggressively-shaped
  framings — `persona` (fix-bug) and `recency` (find-needle). Matches F10 (Disengaged =
  jailbreak *shape*, not size). Hypothesis to confirm across rounds: aggressive framings
  (persona/recency, maybe negative/terse) Disengage more than lean ones (minimal/baseline),
  forfeiting the whole task. The 1 GAVE_UP_PROSE: need to check which strategy.
- 2026-06-24 night: session start. Env confirmed (clean tree, creds present, nix OK, bench present).
  msal-cache.json dated Jun 9 — expect silent-refresh or reauth on first live call.
