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

Flags: `--label <name>` (names the output), `--tasks fizzbuzz,fix-bug` (subset),
`--max-turns 12`, `--repeat 3` (n per task for a real rate), `--image python:3-slim`.

## Comparing levers (the whole point)

Change **one** variable, give it a `--label`, diff the JSON in `scripts/bench/out/`:

| Lever | How to vary |
|---|---|
| **model / tone** | `--model m365-copilot` vs `--model gpt-5.5` vs `--model claude-sonnet` |
| **tool format** | fenced is the only format now (JSON removed). Vary the per-request framing via `--system <file>` (see `prompts/p*.txt`) instead |
| **prompt / agent instructions** | edit `getAgentInstructions()`, rebuild, re-run |
| **per-request framing variant** | one proxy with `M365_FRAMING_FILE=<file>`, then `scripts/bench/sonnet5-sweep.sh` switches the file per arm (`ARMS="default relay retag"`, any `MODEL`) and archives each arm's debug log + frames |
| **optionsSets** | `M365_NO_CODE_INTERPRETER=1` etc. on the proxy |

Example: `--label json` then `--label fenced` → compare `pct` and the
`GAVE_UP_PROSE` counts. Higher SOLVED % + fewer prose give-ups = better.

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
