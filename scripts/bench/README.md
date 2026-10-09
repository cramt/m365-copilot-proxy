# m365-bench — a tiny Terminal-Bench-style benchmark

Quantify **what actually works** instead of guessing. Real agentic coding tasks,
objective pass/fail verifiers, scored across whatever lever you want to compare
(tool-call format, model/tone, prompt, optionsSets). "Best" becomes a number.

## How it works

`run.mjs` drives the **local proxy** as an OpenAI-compatible agent loop:
send task → model returns a `tool_call` → execute it **inside a Docker container**
(`--network none`, only the task dir mounted, host uid) → feed the result back →
loop until the model stops → run the task's **objective verifier**.

Execution is sandboxed: model-generated shell runs in the container, **never on
your host**, with no network. Real `python3`/`bash` so "does the generated code
actually work" is genuinely tested.

Each task ends in one outcome:
- `SOLVED` — verifier passed (the only success)
- `GAVE_UP_PROSE` — model answered in prose without finishing (the compliance bug)
- `MAX_TURNS` — ran out of turns
- `ERROR` — upstream 502 (Disengaged / empty / rate limit)

## Usage

```sh
pnpm run proxy 4141                 # in one shell
# in another:
node scripts/bench/run.mjs --base-url http://localhost:4141/v1 \
  --model m365-copilot --label magic-baseline
```

### Nix

The shell scripts here (`phase-sweep.sh`, `pi-reliability.sh`, `sonnet5-sweep.sh`) run inside
the repo's dev shell, which provides node, pnpm, pi, python3, curl and Chromium:

```sh
nix develop --command bash scripts/bench/phase-sweep.sh
```

Environment variables set before `nix develop` carry through to the script. Docker comes from
the host: the bench needs its daemon, and your user in its group.

Flags: `--label <name>` (names the output), `--tasks fizzbuzz,fix-bug` (subset),
`--max-turns 12`, `--repeat 3` (n per task for a real rate), `--image python:3-slim`,
`--task-gap 30` (seconds between tasks, see below), `--no-stop-on-throttle`.

Every task is a fresh M365 conversation, and every turn draws on the account's throttle budget: a
bucket of ~100 turns that refills at ~1.6 a minute fits all seven `PerUserThrottled` onsets on record,
premium and non-premium accounts alike (hypotheses §24 F58). The first throttled task stops the
run (`[bench] THROTTLED`, exit 3; pi-reliability: `[pi-rel] THROTTLED`, exit 3) and phase-sweep stops
the sweep: everything after it would fail the same way and keep the throttle alive. Wait it out; a
fresh login doesn't clear it. `--task-gap S` (phase-sweep: `TASK_GAP=S`) slows a run down by a fixed gap.

To avoid the throttle instead, set **`M365_AVOID_THROTTLING=1`** (off by default). The bench then waits
before every task (and every real-pi run) until the proxy's debug logs say the bucket covers a whole
task plus a reserve of 20 turns, and for 75 minutes of quiet after a throttled turn (`turn-budget.mjs`).
A long sweep then runs at the account's pace, ~1.6 turns a minute once the bucket is low. It needs a
proxy with `M365_DEBUG=1`, which phase-sweep always sets; turns it can't see (the web client, another
host, a proxy without debug logs) aren't counted. `node scripts/bench/turn-budget.mjs status` shows
where the bucket stands, and the `M365_BUDGET_*` variables in its header tune the model. The Opus
priority-access wall (`claude-opus`: 40 turns a day) stops it the same way, as `[bench] PRIORITY
ACCESS EXHAUSTED` (exit 4); `analyze-arms.mjs` counts the tasks it took as `INVALID(quota)`.

## Comparing levers (the whole point)

Change **one** variable, give it a `--label`, diff the JSON in `scripts/bench/out/`:

| Lever | How to vary |
|---|---|
| **model / tone** | `--model m365-copilot` vs `--model gpt-5.5` vs `--model claude-sonnet` |
| **tool format** | fenced is the only format now (JSON removed). Vary the per-request framing via `--system <file>` (see `prompts/p*.txt`) instead |
| **prompt / agent instructions** | edit `getAgentInstructions()`, rebuild, re-run |
| **per-request framing variant** | `phase-sweep.sh` (below), or `scripts/bench/sonnet5-sweep.sh`, which starts a proxy per arm with its own framing (`ARMS="default relay retag"`, any `MODEL`) and archives each arm's debug log + frames |
| **proxy env** (agent on/off, code interpreter, confab retry) | a phase per setting in `phase-sweep.sh`: each phase's proxies get its own env |
| **optionsSets** | `M365_NO_CODE_INTERPRETER=1` etc. on the proxy |

Example: `--label json` then `--label fenced` → compare `pct` and the
`GAVE_UP_PROSE` counts. Higher SOLVED % + fewer prose give-ups = better.

## Phase sweeps and reading them back

`phase-sweep.sh` runs a whole experiment unattended: phases, each with its own proxy env, and
within a phase framing arms (one bench run each) and real-pi arms. Every arm gets a fresh proxy,
so no arm inherits proxy state from the one before. One sweep per account at a time; arms run
one after another with cooldowns (thread-rate throttle, F13).

```sh
MODEL=gpt-6-sol TAG=g6s \
PHASES='A:baseline,relay,demo_only,relay|B@M365_FORCE_AGENT=0:relay,pi=fix-bug,pi=multi' \
  nix develop --command bash scripts/bench/phase-sweep.sh
```

`PHASES` is `NAME[@KEY=VAL...]:ARM,...` separated by `|`. An arm is a framing variant, `default`
(the model's shipped framing) or `pi=fix-bug|multi|edit-config` (`PI_N` real-pi runs).
`@MODEL=ID` gives a phase its own model, so one sweep can alternate two models arm by arm (one arm
per phase) instead of running them hours apart; `MODEL` can then be left out, and `analyze-arms`
selects on `+MODEL=ID`. Every
proxy runs with debug logs, frame dumps and the confab retry off. `DRY_RUN=1` validates the plan
(unknown variants included) without spending anything; `PROXY_CMD="node
scripts/bench/_mock-proxy.mjs"` runs the whole driver against the mock. The header of the
script lists the other knobs. For a long sweep, detach it and wait for `DONE` (or `FAILED`) in
the archive:

```sh
setsid -f env MODEL=… PHASES=… nix develop --command bash scripts/bench/phase-sweep.sh </dev/null >/dev/null 2>&1
```

Everything lands in `~/.config/opencode-m365/sweeps/<TAG>/`: per arm the scorecard and its JSON,
the proxy's debug log and frames (written there directly, through `M365_LOG_FILE` and
`M365_FRAME_DIR`) and its console output, pi CSVs and failed runs' output, plus `manifest.tsv` and
`sweep.env` (the plan and the git revision).

`analyze-arms.mjs` reads one or more archives (pool accounts by passing several):

```sh
nix develop --command node scripts/bench/analyze-arms.mjs ~/.config/opencode-m365/sweeps/g6s [more archives…] \
  --compare 'relay,default@agent-less' 'demo_only@agent-less' [--rows]
```

Per arm it prints the score and what happened on the wire: which path served each task (with or
without the tool agent), turns where the model worked in its own sandbox, Disengaged and
jailbreak-classifier turns, dead-route `InternalError`s and fallbacks, network failures and
throttles. Then it pools by arm × path, and `--compare` gives Fisher's exact test between two
selections. `--turns A B` compares turns per task instead, with a task-stratified permutation test,
and counts each selection's sandbox, Disengaged and jailbreak turns; a pi arm's framing is selected
by its phase env (`'pi=fix-bug,pi=multi+M365_FRAMING_VARIANT=relay@agent'`). Tasks that failed because of the network or a throttle are left out of every score,
so an outage doesn't read as a bad arm. It also reads the older `sonnet5-sweep.sh` archives. The
header of the script documents each rule.

## Cost & caveats

- Each task = several M365 messages (multi-turn). Full suite ≈ 25–40 messages,
  spread across fresh conversations. Use `--tasks` / `--repeat 1` to stay cheap.
  A throttled account now shows as `ERROR … HTTP 429 … m365_throttled` (the turn's
  final result says `PerUserThrottled`); ~190 fresh threads in a day tripped it.
  Exclude those rows from any comparison — they measure the account, not the arm.
- `n=1` by default — LLM output varies. Use `--repeat 3+` before trusting small
  differences.
- Tasks live in `tasks.mjs` (objective, python3+bash only). Add your own.
- Requires Docker (daemon up). Swap `--image` for a node base if you write
  node-based tasks.
