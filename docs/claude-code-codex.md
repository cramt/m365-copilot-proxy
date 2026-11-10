# Claude Code and Codex

> **Status: experimental; first live runs Nov 10 2026** (Windows 11, premium account, three runs
> per arm, so read the numbers as direction, not rates). The path works end to end and never tripped
> `Disengaged`. What failed was the model: M365's Claude models often refuse to act as Claude Code
> or the Codex CLI ("I'm Microsoft Copilot…"), reading the harness's identity lines and
> `<system-reminder>` blocks as an injection. `M365_HARNESS_PROMPT=lean` strips those. With it,
> Claude Code on `claude-sonnet-5` solved 6/6, against 0/3 without it. Codex still refuses about one
> task in three. Details: [hypotheses §39](hypotheses.md) F102–F104.

Neither client speaks the API this proxy serves. Claude Code only speaks the Anthropic
Messages API. Codex only speaks the OpenAI Responses API: it dropped
`wire_api = "chat"` in February 2026
([openai/codex#7782](https://github.com/openai/codex/discussions/7782)).
[copilot-api](https://github.com/caozhiyuan/copilot-api) (npm
`@jeffreycao/copilot-api`) translates both onto any OpenAI-compatible provider, so the
proxy plugs in as one, with no new endpoints:

```
Claude Code ── Anthropic Messages ──┐
                                    ├─▶ copilot-api ── Chat Completions ──▶ m365-proxy ──▶ M365 Copilot
Codex ─────── OpenAI Responses ─────┘   (provider "m365", type openai-compatible)
```

## Setup

**1. Start the proxy on a port other than 4141.** copilot-api also defaults to 4141.
`M365_HARNESS_PROMPT=lean` removes what the models refuse (see
[What the proxy does](#what-the-proxy-does-for-these-clients)), and `M365_AVOID_THROTTLING=1` paces
turns before the account's throttle trips:

```sh
M365_HARNESS_PROMPT=lean M365_AVOID_THROTTLING=1 M365_DEBUG=1 m365-proxy 4143
```

On a managed Windows PC (Entra-joined, Intune) the one-time sign-in can be silent. If the Chrome
policy `CloudAPAuthEnabled` is on, Chrome signs in with your Windows account. Set
`M365_ENABLE_INTERACTIVE_APPROVAL=1`, `CHROMIUM_PATH` to `chrome.exe`, and `M365_LOGIN_UA` to a
Windows Chrome user agent; the default is a Linux one. On Windows `CHROMIUM_PATH` is required, because
the proxy finds a browser with `command -v`. Edge doesn't work when policy forces browser sign-in
(`BrowserSignin=2`): Playwright never gets a window.

**2. Add the proxy to copilot-api as a provider.** Edit `config.json`
(`~/.local/share/copilot-api/`, or the directory given to `--api-home`):

```json
{
  "providers": {
    "m365": {
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:4143",
      "apiKey": "not-needed",
      "models": {
        "claude-sonnet": { "contextWindow": 1000000, "maxOutputTokens": 32000 },
        "gpt-5.5-think-deeper": { "contextWindow": 1000000, "maxOutputTokens": 32000 }
      }
    }
  }
}
```

Then run `npx @jeffreycao/copilot-api@latest start`. With a provider configured it starts
in provider-only mode, so you don't need a GitHub Copilot login. Models appear as
`m365/<model id>`.

**3. Claude Code** (`.claude/settings.json`):

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "not-needed",
    "ANTHROPIC_MODEL": "m365/claude-sonnet",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "m365/claude-sonnet",
    "CLAUDE_CODE_SUBAGENT_MODEL": "m365/claude-sonnet",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false",
    "CLAUDE_CODE_ENABLE_AWAY_SUMMARY": "0",
    "CLAUDE_CODE_TOTAL_TOKENS_REMINDER": "off",
    "CLAUDE_CODE_MAX_RETRIES": "1"
  }
}
```

Run it with a lean toolset:

```sh
claude --tools "Bash,Read,Edit,Write"
```

By default Claude Code offers 27 tools: about 90k characters of tool definitions on top of
a 14k-character system prompt. That is far past the ~12 tools at which M365 starts to
disengage (on the agent path,
[api §9](m365-copilot-api.md#the-disengaged-filter)). The lean set is 4 tools, about 17k
characters, the same count as pi. Add `WebSearch`/`WebFetch` only if you want them (see
[Search](#search)).

Which model: on a premium account, `m365/claude-sonnet-5` (Sonnet 5 on the paid scenario, with no
priority-access budget) solved 6/6 live with `M365_HARNESS_PROMPT=lean`. Otherwise use
`m365/claude-sonnet` (Sonnet 4.6). `claude-opus` (Opus 5.5) and `claude-sonnet-5.5` spend small daily
budgets (40 and 80 turns), shared with your own Copilot Chat use, and every tool call is a turn.

GPT models need more care ([F105](hypotheses.md)):
- Some GPT tones can be dead on an account: on Nov 10, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-6-think-deeper`
  and `gpt-5.5-think-deeper` refused every prompt with `InputTokenLimitExceeded` ("prompt is too long"),
  even a 46-character one. The proxy now answers that with a 400 `context_length_exceeded` after one turn.
- `gpt-5.6-think-deeper` worked: Claude Code 3/3 and Codex 5/8. Without the tool agent it needs the
  user-voice framing and no code interpreter, or it works in its own cloud sandbox (`/mnt/data`) instead
  of yours: `M365_FRAMING_VARIANT=relay_batch M365_NO_CODE_INTERPRETER=1 M365_NO_IMAGE_GEN=1`.
- In Codex, don't name a GPT-5.5 model: Codex then adds its hosted `tool_search` tool, which copilot-api
  rejects. `m365/think-deeper` is the same tone under a name Codex doesn't know.

**4. Codex** (`~/.codex/config.toml`):

```toml
model = "m365/claude-sonnet"
model_provider = "m365"
web_search = "disabled"
model_instructions_file = "/path/to/m365-brief.txt"   # optional, see below

[model_providers.m365]
name = "m365 via copilot-api"
base_url = "http://localhost:4141/v1"
env_key = "M365_GATEWAY_KEY"   # any non-empty value; export it
wire_api = "responses"
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 300000
```

`model_instructions_file` replaces Codex's own ~40k-character instructions, which are written for GPT
and name the Codex CLI throughout. A three-sentence brief with no identity cut Codex's M365 turns per
task from 5.3 to 2.3 live, but didn't stop the remaining refusals. The brief used:
"I'm working on a project in the current directory of my computer. My terminal tools run the commands
and file edits you ask for, and I send you back their output. Please work through the task step by step
with those tools, and finish with a short answer."

`web_search = "disabled"` is required for now. Through an OpenAI-compatible provider,
copilot-api rejects Codex's hosted search tool with a 400 ("Responses Messages fallback
does not support tool 'web_search'"). On Windows, Codex's default read-only sandbox
refused to start even `echo`; pick `-s workspace-write` (or wider) for real work.

Codex 0.160+ can load copilot-api's catalog (`model_catalog_url =
"http://localhost:4141/models"`), which puts gateway models in Codex **Code Mode**. The
proxy handles both modes; see below.

## What the proxy does for these clients

- **Shell routing knows their shells.** Claude Code's `Bash` was always caught. Codex's
  `exec_command` (unified exec) and `shell_command` are new. Before this, a ```` ```bash ````
  reply to Codex produced no tool call at all.
- **Codex Code Mode.** There the one shell-like tool, `exec` (`functions__exec` through
  copilot-api), runs **JavaScript** in a V8 isolate, and a raw ```` ```bash ```` body is a
  SyntaxError.
  - The proxy shows the model that tool as an ordinary shell. Its 11k-character
    JavaScript API description is not passed on.
  - Each shell block is wrapped as a nested `await tools.exec_command({ cmd })` call that
    prints the command's output (`codeModeShellScript`).
  - Transcripts and result labels show the original command, not the wrapper.
  - A body that is already Code Mode JavaScript passes through untouched.
- **Claude Code on Windows.** Its `Bash` tool runs Git Bash ("not cmd.exe or
  PowerShell"), so the proxy no longer tells the model that `Bash` runs PowerShell.
  ```` ```powershell ```` blocks go to Claude Code's own `PowerShell` tool when it has one.
- **Sessions are keyed on the client's session id.** copilot-api passes Claude Code's and
  Codex's session ids as `prompt_cache_key`. Codex opens every session in a repo with the
  same environment message, which used to merge separate sessions into one M365
  conversation. Subagents share their parent's session id, so the first user message
  stays part of the key, and so do the request's tool names (as for every client): a
  tool-less side request gets a conversation of its own.
- **copilot-api's "Tool Call Tips" are removed.** For Codex, the gateway appends
  instructions to write JavaScript for `functions__exec` and says `exec_command` doesn't
  exist. That contradicts the shell routing, so the proxy strips the block.
- **Errors end the turn instead of triggering retries.** After a streaming response's
  HTTP 200, the proxy reports a failure (Disengaged, throttle, priority-access wall) as an
  OpenAI-style `error` chunk. copilot-api can't parse that chunk. Claude Code saw "API
  Error: 500 Unexpected token 'd'…" and retried 10 times in ~150 s, and every retry of a
  Disengaged turn opens fresh M365 conversations. For `claude-cli/…` and `codex…`
  user-agents the proxy now sends the reason as the assistant's text
  (`[m365-proxy: disengaged] …`) with `finish_reason: "stop"`. Nothing retries: one
  failed turn costs 2 M365 turns (the proxy's own F22 retry) instead of ~22.
  `M365_STREAM_ERROR_MODE=text|chunk` forces either behaviour for any client.
- **The harness's identity and reminders can be stripped (`M365_HARNESS_PROMPT`, off by default).**
  Even with `--system-prompt-file`, Claude Code sends Anthropic's billing header, "You are a Claude
  agent, built on Anthropic's Claude Agent SDK." and `<system-reminder>` blocks in the user turn, one of
  which names the model ID. M365's models answer that they're Microsoft Copilot and refuse. `clean`
  drops those lines and blocks, plus Claude Code's and Codex's own "You are …" lines; the environment
  and date reminders are kept as plain text. `lean` also cuts each tool description to ~700
  characters, so Bash keeps its Git Bash line and loses the git and PR protocol. Claude Code's first
  turn goes from 17.2k to 5.1k characters.
- **Smaller fixes from the live runs (any client).** A sub-1000 value for a parameter the tool's
  schema documents in milliseconds is read as seconds: GPT-5.6 wrote `Bash` `timeout: 30`, Claude Code
  backgrounded every command after 1 s, and `claude -p` never exited. M365's canned
  "Sorry, it looks like I can't chat about this" (`contentOrigin: "Apology"`) is retried once in a fresh
  conversation, like a Disengage. A turn refused as `InputTokenLimitExceeded` fails fast with a 400.

## Search

Disabling Codex's hosted `web_search` doesn't rule out search:

- **Claude Code `WebSearch`.** With copilot-api's `messageApiWebSearchModel` set to `""`,
  the search sub-request falls through to the proxy as plain, tool-less chat. On the real
  proxy that is an agent-less turn, and those always carry M365's built-in Bing plugin.
  The routing is checked; real M365 answers are not.
- **Codex standalone search.** Set `supports_standalone_web_search = true` on the provider
  and `web_search = "live"`. Unless Codex loads copilot-api's catalog (whose
  `use_responses_lite` turns it on), also set `[features] standalone_web_search = true`.
  Codex then drops the hosted tool and gives the model a `web.run` function. It runs
  searches itself through copilot-api's `/v1/alpha/search`, and that needs either a
  `codex` (ChatGPT) or Copilot login, or an `openai-responses` search provider.
- **Planned:** a search-only `/v1/responses` in this proxy, backed by one Bing-grounded
  M365 turn, as that provider for both clients.

## Known limits

- **The models refuse the harness.** Live, no turn disengaged; the failures were the model saying it is
  Microsoft Copilot with its own sandbox, not Claude Code or the Codex CLI. Without
  `M365_HARNESS_PROMPT` Claude Code solved 1/3 (Sonnet 4.6) and 0/3 (Sonnet 5); with `lean`, Sonnet 5
  solved 6/6. Codex solved 2/3 in every arm. Its remaining refusals quote the proxy's
  `<harness_system_prompt>` wrapper and Codex's PTY tools (`exec_command`, `write_stdin`)
  ([F103](hypotheses.md)).
- **Quota.** A headless run of these small tasks cost one conversation and 2–5 M365 turns. Every turn
  draws on the account's throttle bucket (~100 turns, refilled at ~1.6 a minute); once it runs dry,
  `PerUserThrottled` refuses everything for about an hour, and a fresh login doesn't help. Run the
  proxy with `M365_AVOID_THROTTLING=1`. Fan-out to subagents spends the bucket fastest (issue #94).
  Opus 5.5 and Sonnet 5.5 also have small daily budgets, shared with your own Copilot Chat use.
- **Thread budget ([F13](hypotheses.md)).** A headless session opens one M365
  conversation, plus one per `WebSearch` call and one per subagent
  ([F101](hypotheses.md)). Compaction and `WebFetch` summaries open more, and so may
  interactive-mode extras such as titles, prompt suggestions and recaps; those haven't
  been measured. The settings above turn off the avoidable ones.
- **One tool call per turn, and about 3k output tokens per turn.** A large `Write` or
  heredoc gets cut off. Codex's `apply_patch` isn't used; edits go through the shell.
- **No token counts.** M365 reports none, so usage shows 0 tokens and the harness can't track its
  context window. The proxy sends only new messages per turn, and M365 holds the conversation
  (600 messages each).

## Checking it without quota

```sh
pnpm build
node scripts/gateway-fake-m365.mjs 4143      # the real proxy, M365 turn faked
npx @jeffreycao/copilot-api@latest start     # provider "m365" → http://127.0.0.1:4143
claude -p "Say hello from the shell." --tools "Bash,Read,Edit,Write" --allowedTools "Bash(echo hello-from-m365)"
codex exec "Say hello from the shell."
```

The fake answers with a ```` ```bash ```` block, then `done` once the tool result
arrives. Each prompt the proxy would have sent is written to `gateway-fake-m365-out/`.
`FAKE_MODE=disengaged` makes every turn Disengage, to check the error path.
`scripts/harness-check.mjs --cooldown=0` (below) also runs against the fake.

## Running the open questions live (hypotheses §39: H39a–c)

These need a signed-in account and spend real conversations: about 12 in total, spaced
out (F13). Run them one at a time.

1. **Start the proxy** with a debug log and frame dumps.
   `M365_ENABLE_INTERACTIVE_APPROVAL=1` opens a browser for a one-time sign-in when no
   token is cached:

   ```sh
   M365_DEBUG=1 M365_DUMP_FRAMES=1 M365_ENABLE_INTERACTIVE_APPROVAL=1 m365-proxy 4143
   ```

   In PowerShell, set them first (`$env:M365_DEBUG='1'`, and so on).

2. **Start copilot-api** with the provider block above. For Claude Code's `WebSearch`,
   also set `"messageApiWebSearchModel": ""`, so search sub-requests reach the proxy
   (Bing).
3. **H39b: what a Bing-grounded answer looks like** (1 conversation):

   ```sh
   node scripts/search-citations-probe.mjs --proxy=http://127.0.0.1:4143
   ```

   It reports the queries M365 ran, its `sourceAttributions` (count, keys, first
   entries), and how the answer cites them (private-use `turnNsearchM` markers, `[^n^]`,
   Markdown links). `--from-dump=<frames/…ndjson>` re-reads a dump without spending a
   turn.
4. **H39a + H39c: real harness loops** (6 conversations, 90 s apart):

   ```sh
   node scripts/harness-check.mjs --harness=claude,codex --tasks=fix-bug,find-needle,edit-config
   ```

   For H39d's prompt arms, restart the proxy with `M365_HARNESS_PROMPT=off|clean|lean` between
   runs, and pass `--claude-system-prompt-file=F`, `--claude-append-system-prompt-file=F` or
   `--codex-instructions-file=F` (with `--label=NAME` to tell the result files apart).

   Per run you get:
   - the outcome, from a verifier;
   - M365 turns and conversations, Disengaged turns and the highest `dea_violation`
     score, all from the proxy's debug log;
   - every request the harness made, from a pass-through shim.

   Each task runs in a throwaway temp directory on this machine. On Windows Codex runs
   unsandboxed there, because its `workspace-write` sandbox refuses every command. A
   throttled run stops the loop.
5. **H39c: what searches and subagents cost** (Claude Code; about 4 conversations):

   ```sh
   node scripts/harness-check.mjs --harness=claude --tasks=web-search,subagent
   ```
