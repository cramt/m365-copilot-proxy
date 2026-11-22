# Usage-limit study: data

Raw data behind docs/m365-copilot-api.md §7. The account is the re-zip.com work
account, "M365 Copilot (Basic)" (`licenseType: Starter`, scenario
`OfficeWebIncludedCopilot`).

| File | What | Written by |
|------|------|------------|
| `direct.jsonl` | One row per turn sent straight to M365, with no proxy memory, retries, or fallback: tone, transport, size, result, `ttud` (`TotalTurnUsageDaily` after the turn), metering keys that moved, any MeteringInfo/billing/cost frame, and the whole `meter` map | `scripts/quota-direct.mjs` |
| `sent.jsonl` | One row per request sent through the proxy (`127.0.0.1:24034`): model, prompt size, HTTP status, error code. The server side (tone, result, `ttud`) comes from the proxy log; join on time. | `scripts/quota-probe.sh` |
| `proxy-turns.jsonl` | Every finished turn in the proxy's debug.log for the study window, including other threads' and Alex's | `ssh root@luna cat …/debug.log \| node scripts/quota-log.mjs --since …` |

`exp` labels name the experiment; §7 says what each one tested.

## Method notes

- Each text turn reports its own after-value, so text turns need no control. Things
  that don't report a value (images, web-UI turns, cancelled turns, license
  refusals, oversize inputs) are bracketed by control turns (`Gpt_5_5_Chat` pong):
  cost = (before − after) − 1.
- At 0, a turn is refused in ~1 s (a pre-check) unless the gate's cached state has
  lapsed. Then the turn runs and is judged at the end, and now and then it is let
  through. Space the zero-state probes so that one experiment doesn't warm the cache
  for the next.
- The other thread's scheduled Pi image check (2026-11-23T01:00Z, 2–5 turns) sits in
  the middle of day 2. Read its turns from `proxy-turns.jsonl` and don't count them
  as ours.
