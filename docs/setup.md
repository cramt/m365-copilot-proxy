# Setup from scratch: M365 Copilot in Codex and Claude Code

```
Codex / Claude Code ──► copilot-api (127.0.0.1:4141) ──► m365-proxy (127.0.0.1:4143) ──► M365 Copilot Chat
```

pi and OpenClaw talk to the proxy directly (README steps 3–4). Codex and Claude Code can't: Codex
speaks only the Responses API and Claude Code only Anthropic Messages, so copilot-api translates. The
Windows commands below are the setup this guide was tested with; the macOS and Linux block sets the
same options and hasn't been run end to end. Background and results:
[claude-code-codex.md](claude-code-codex.md).

## Do you need the copilot-api repo?

Usually not: run the published package, `@jeffreycao/copilot-api`, with `npx`, and clone the repo only to
change copilot-api, or when your npm registry has no recent enough version. The Codex app needs 2.9.7
or later. An older copilot-api rejects any request from the app that carries the app's own context,
such as its page snapshot, with "function_call_output.call_id is required" (fixed upstream in
[#500](https://github.com/caozhiyuan/copilot-api/pull/500)). The public npm registry has 2.9.12 (since
Nov 16), but a registry mirror can lag: a company mirror still served 2.9.3 as `latest` and had no 2.9.7
or later. `npm view @jeffreycao/copilot-api version` shows what yours serves; if it's older, step 3
builds a release tag instead. Claude Code and the Codex CLI worked on 2.6.23 too. You need copilot-api
only for Codex and Claude Code, and it doesn't need GitHub Copilot: with a provider configured and no
GitHub login it starts in provider-only mode. If you already run it for Copilot, add the provider in
step 3 and your Copilot models stay. Tested with 2.6.23 and 2.9.12.

## 1. Prerequisites

- Node.js 24+, pnpm 10+ (`corepack enable`), git.
- Google Chrome, which the proxy signs in through. On Windows, Edge fails under the `BrowserSignin=2`
  policy.
- A work or school account with M365 Copilot Chat. Some models need a premium seat
  ([README, Available models](../README.md#available-models)).
- Codex (CLI or app) and/or Claude Code.

## 2. Build and start the proxy

```sh
git clone https://github.com/cramt/m365-copilot-proxy
cd m365-copilot-proxy
pnpm install
pnpm build
```

Then start it on port 4143 (copilot-api takes 4141). It listens on 127.0.0.1 unless `HOST` says
otherwise. To require a key too, set `M365_PROXY_KEY` (or `M365_PROXY_KEY_FILE`) and give copilot-api
the same value in step 3.

Windows (PowerShell):

```powershell
$env:M365_ENABLE_INTERACTIVE_APPROVAL = '1'
$env:CHROMIUM_PATH = "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
$major = (Get-Item $env:CHROMIUM_PATH).VersionInfo.ProductMajorPart
$env:M365_LOGIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$major.0.0.0 Safari/537.36"
$env:M365_HARNESS_PROMPT = 'lean'; $env:M365_AVOID_THROTTLING = '1'; $env:M365_DEBUG = '1'
$env:M365_TRANSPORT = 'streamhub'; $env:M365_FORCE_AGENT = '0'
$env:M365_FRAMING_VARIANT = 'relay_batch'; $env:M365_NO_CODE_INTERPRETER = '1'; $env:M365_NO_IMAGE_GEN = '1'
node packages\proxy\bin\m365-proxy.mjs 4143
```

macOS / Linux:

```sh
export M365_ENABLE_INTERACTIVE_APPROVAL=1
export CHROMIUM_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"   # Linux: your Chrome or Chromium
major="$("$CHROMIUM_PATH" --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')"
export M365_LOGIN_UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/$major.0.0.0 Safari/537.36"   # Linux: unset (the default is Linux)
export M365_HARNESS_PROMPT=lean M365_AVOID_THROTTLING=1 M365_DEBUG=1
export M365_TRANSPORT=streamhub M365_FORCE_AGENT=0
export M365_FRAMING_VARIANT=relay_batch M365_NO_CODE_INTERPRETER=1 M365_NO_IMAGE_GEN=1
node packages/proxy/bin/m365-proxy.mjs 4143
```

What the settings do:

- **Sign-in.** The first start opens Chrome; sign in once and the token refreshes silently from then
  on. On an Intune-managed Windows PC whose Chrome has the `CloudAPAuthEnabled` policy it is silent.
  Stored credentials work too (README step 2). The user agent should name the OS you're on; the
  proxy's default says Linux.
- **Conditional Access.** If your organization admits only compliant devices, the sign-in has to come
  from one, through a browser that presents it. The proxy signs in with its own Chrome profile
  (`~/.config/opencode-m365/browser-profile`), where extensions don't run: on Windows Chrome presents
  the device through `CloudAPAuthEnabled`, and on a Mac only if IT has enabled Chrome for Microsoft's
  Enterprise SSO. If you have the device's certificate as a PKCS#12 file, the proxy can present it
  itself, with a macOS or Windows user agent (README step 2, *If sign-in asks for a client
  certificate*). Otherwise a refusal at this step is your organization's policy; nothing in the proxy
  changes it, so use a device it admits.
- **`M365_HARNESS_PROMPT=lean`** strips the Codex and Claude Code identity lines and reminders that
  M365's models refuse as injections.
- **`M365_AVOID_THROTTLING=1`** paces turns before the account's throttle trips.
- **The last two lines** are for GPT models, the best ones for Codex: StreamHub (where this account's
  Chathub refused GPT-6.x), the user-voice `relay_batch` framing, no code interpreter or image
  generation, no tool agent. They apply to every model. With them Codex solved 7/7 on `gpt-6.1-sol`
  (hypotheses §40 F109), and Claude Code on `claude-sonnet-5` passed step 6's check; its 6/6 in §39
  was on Chathub with only `lean`.

Check: `curl -s http://127.0.0.1:4143/v1/models` lists the models. Debug log:
`~/.config/opencode-m365/debug.log`.

### Windows token-protection policies: native broker

A compliant device can still receive Entra error `530084` if browser authentication
does not satisfy token protection. On Windows, try WAM instead, keeping the other
proxy settings above:

```powershell
$env:M365_AUTH_MODE = 'wam'
$env:M365_ENABLE_INTERACTIVE_APPROVAL = '1'
node packages\proxy\bin\m365-proxy.mjs 4143
```

WAM uses the existing Microsoft client ID and Sydney scopes through the Windows
account picker, without Playwright or a stored password. With multiple accounts,
select the work account in the picker, or set `M365_LOGIN_HINT` to its sign-in
name. The selection is saved in `~/.config/opencode-m365/wam-account.json`; tokens
remain broker-managed. `M365_NO_INTERACTIVE=1` disables the picker as well as browser
prompts. Browser authentication remains the default when `M365_AUTH_MODE` is unset.

The optional `@azure/msal-node-extensions` dependency must be installed, including
its native dependencies. If an existing installation skipped native builds, run
`pnpm -r rebuild keytar` and rebuild the proxy. This mode does not change tenant
policy; a native broker policy refusal still needs administrator review.

## 3. Start copilot-api with the proxy as a provider

Create or edit `config.json` in copilot-api's home, `~/.local/share/copilot-api/` (on Windows
`%USERPROFILE%\.local\share\copilot-api\`; `--api-home` or `COPILOT_API_HOME` moves it), and add the
`m365` provider, keeping anything else in the file:

```json
{
  "providers": {
    "m365": {
      "type": "openai-compatible",
      "baseUrl": "http://127.0.0.1:4143",
      "apiKey": "not-needed",
      "models": {
        "gpt-6.1-sol": { "contextWindow": 1000000, "maxOutputTokens": 32000 },
        "claude-sonnet-5": { "contextWindow": 1000000, "maxOutputTokens": 32000 },
        "claude-opus": { "contextWindow": 1000000, "maxOutputTokens": 32000 }
      }
    }
  }
}
```

```sh
npx @jeffreycao/copilot-api@latest start --port 4141
```

If you use the Codex app and your registry serves a version older than 2.9.7
(`npm view @jeffreycao/copilot-api version`), build a release tag of
[caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api) instead. Its lockfile needs Bun
1.4.4 or later, which `npx -y bun@latest` runs without installing it:

```sh
git clone --depth 1 --branch v2.9.12 https://github.com/caozhiyuan/copilot-api
cd copilot-api
npx -y bun@latest install --frozen-lockfile --ignore-scripts
npx -y bun@latest run build
node dist/main.js start --port 4141
```

It listens on 127.0.0.1 by default. Models appear as `m365/<model id>`, and any ID the proxy knows
routes, listed here or not: `curl -s http://127.0.0.1:4141/v1/models` should show them. If you set
`M365_PROXY_KEY` in step 2, put it in the provider's `apiKey` (copilot-api sends it as a bearer). If the
file has `auth.apiKeys`, use one of those keys wherever the steps below say `not-needed`.

To run a model on Cowork or Code (Copilot's agent runtime: longer turns, charged to your Copilot
credits; [Backends](../README.md#backends-chat-cowork-and-code)), pick its ID: the proxy offers all three
backends by default (`M365_BACKENDS=chat` turns the runtime off). copilot-api lists the runtime's IDs as
`m365/<id>`, such as `m365/claude-sonnet-5.5(cowork)_640k_credit`; the parentheses route as they are
(Codex's Responses API and Claude Code's Messages API both answered through them). The runtime's models
follow its live catalog, which dropped every GPT model on Nov 19 2026. Add an ID to `models` to give it
its window:

```json
"claude-sonnet-5.5(cowork)_640k_credit": { "contextWindow": 640000, "maxOutputTokens": 32000 },
"claude-opus-5.5(cowork)_640k_credit": { "contextWindow": 640000, "maxOutputTokens": 32000 }
```

In a shell, quote such an ID: `claude --model "m365/claude-sonnet-5.5(cowork)_640k_credit"`.

## 4. Codex

Save the brief below to a file, say `~/.codex/m365-brief.txt`. It replaces Codex's ~40k-character
instructions, which name the Codex CLI throughout, and cut Codex's M365 turns per task from 5.3 to 2.3:

```text
I'm working on a project in the current directory of my computer. My terminal tools run the commands and file edits you ask for, and I send you back their output. Please work through the task step by step with those tools, and finish with a short answer.
```

Build a model catalog from copilot-api's, with each model's context window. The Codex app lists only its
own GPT models without one, so this is also what puts Claude in its picker:

```sh
node scripts/codex-catalog.mjs --all --out=~/.codex/m365-models.json
```

`--all` includes every model the gateway advertises on `/v1/models` that its Codex catalog offers,
each with the context window the gateway advertises for it (the proxy's `M365_CONTEXT_WINDOW`,
1,000,000 by default); `--window=N` gives them all one, and `MODEL=WINDOW` gives one model its own.
For a smaller picker, replace `--all` with explicit model IDs, for example
`m365/gpt-6.1-sol m365/claude-sonnet-5 m365/claude-opus`. Re-run after the proxy adds models.
This discovers the proxy's **Chat** routes, not the separate **Cowork** or **Code** backend: a model
shown only in those web-app pickers is not automatically supported here.

Then `~/.codex/config.toml` (the top-level keys go above the first `[table]`):

```toml
model = "m365/gpt-6.1-sol"
model_provider = "m365"
web_search = "disabled"                                # copilot-api rejects Codex's hosted search
model_instructions_file = "/Users/you/.codex/m365-brief.txt"
model_catalog_json = "/Users/you/.codex/m365-models.json"

[model_providers.m365]
name = "M365 Copilot via copilot-api"
base_url = "http://127.0.0.1:4141/v1"
wire_api = "responses"
requires_openai_auth = true                            # the Codex app keeps your ChatGPT account
experimental_bearer_token = "not-needed"               # and your ChatGPT token stays out of copilot-api
request_max_retries = 1
stream_max_retries = 1
stream_idle_timeout_ms = 900000   # Cowork/Code turns at high effort can run past 5 minutes
```

Use absolute paths (on Windows, single-quoted: `'C:\Users\you\.codex\m365-models.json'`). The Codex app
reads all of this at startup, so restart it after a change. `requires_openai_auth = true` is for the
app's account menu; the CLI ran with this file and no ChatGPT login. Things to know:

- **The app keeps each thread on the provider it started with,** and saves the model you last picked
  as the default without its provider. Keep only gateway models in the catalog (or put other backends
  behind copilot-api too: [claude-code-codex.md](claude-code-codex.md), step 5).
- **Context windows** come from the catalog. M365 reports no token counts, so the proxy estimates
  them by default; Codex uses those estimates to decide when to compact. In the proxy's tests,
  Claude models read 2M characters or more in a turn, while GPT-6.x read about 270k tokens and
  summarized older turns (hypotheses §47). Codex compacts at 90% of a window, counted in the proxy's
  estimate (4 UTF-8 bytes a token): 225,000 for GPT-6.x and 450,000 for Claude compact before M365
  summarizes or drops turns.
- **Metered models.** On Chathub `claude-opus` (Opus 5.5) is limited to 40 turns a day and
  `claude-sonnet-5.5` to 80, every tool call a turn, while `gpt-6.1-sol` and `claude-sonnet-5` spend no
  allowance. StreamHub reports no meters at all (hypotheses §41), so prefer the unmetered models.
- **Sandbox.** On Windows, Codex 0.157 refused every command in its sandbox, `workspace-write`
  included ("blocked by policy", even `echo`), so the tested runs used
  `--dangerously-bypass-approvals-and-sandbox`. On macOS and Linux use `-s workspace-write`.

### Long-context catalog

The default catalog configures a 1,000,000-token window. For the long-context setup, use 1,050,000
tokens for [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra),
[GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol),
[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol),
[GPT-6.2 Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra), and
[GPT-6.2 Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol), their published OpenAI API
context windows (input and output; up to 922,000 input). Keep 1,000,000 as the catalog fallback for the
other M365 models.

M365 serves less than those windows: GPT-6.x reads about 270k tokens a turn and summarizes older
turns, Claude 2M characters or more (hypotheses §47). With these windows Codex compacts after M365 has
already summarized or dropped earlier turns. To have Codex compact first, use the same `MODEL=WINDOW`
form with 225,000 for GPT-6.x and 450,000 for the Claude models, counted in the proxy's estimate.

From the repo root in PowerShell, with the gateway running, discover every M365 model and pass
`MODEL=WINDOW` for the five overrides. `--all` takes the same overrides, but lists every gateway
model, not only `m365/*`:

```powershell
$longContext = @(
  'm365/gpt-6-astra',
  'm365/gpt-6-sol',
  'm365/gpt-6.1-sol',
  'm365/gpt-6.2-astra',
  'm365/gpt-6.2-sol'
)
$ids = (Invoke-RestMethod -Uri 'http://127.0.0.1:4141/v1/models' -ErrorAction Stop).data.id
$entries = foreach ($id in $ids) {
  if ($id -notlike 'm365/*') { continue }
  if ($id -in $longContext) { "${id}=1050000" } else { $id }
}
node scripts\codex-catalog.mjs --window=1000000 "--out=$HOME\.codex\m365-models.json" @entries
```

The script sets both `context_window` and `max_context_window`. Fully quit and reopen the Codex app
to load the updated catalog. These values set Codex's context budget; they do not raise or measure
the input limits enforced by M365 Copilot.

## 5. Claude Code

`m365-claude.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4141",
    "ANTHROPIC_AUTH_TOKEN": "not-needed",
    "ANTHROPIC_MODEL": "m365/claude-sonnet-5",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "m365/claude-sonnet-5",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "m365/claude-sonnet-5",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "m365/claude-sonnet-5",
    "CLAUDE_CODE_SUBAGENT_MODEL": "m365/claude-sonnet-5",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION": "false",
    "CLAUDE_CODE_ENABLE_AWAY_SUMMARY": "0",
    "CLAUDE_CODE_TOTAL_TOKENS_REMINDER": "off",
    "CLAUDE_CODE_MAX_RETRIES": "1"
  }
}
```

```sh
claude --settings m365-claude.json --safe-mode --tools "Bash,Read,Edit,Write"
```

Keep the toolset lean: Claude Code's default 27 tools trip M365's Disengaged filter. `--safe-mode`
leaves your CLAUDE.md, skills, plugins, hooks and MCP servers out of the prompt, as in the tested runs.
Unset `ANTHROPIC_API_KEY` in that shell so Claude Code uses the gateway.

## 6. Check it

```sh
# macOS / Linux; on Windows replace -s workspace-write with --dangerously-bypass-approvals-and-sandbox
codex exec --skip-git-repo-check -s workspace-write "Create hello.txt containing the line: setup check. Then confirm in one short sentence."
claude --settings m365-claude.json --safe-mode --tools "Bash,Read,Edit,Write" --permission-mode acceptEdits -p "Create hello.txt containing the line: setup check."
```

Each should create `hello.txt`. After a reboot, start the proxy, then copilot-api.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Sign-in refused: the device or browser doesn't meet your organization's requirements | Conditional Access admits only compliant devices | Sign in on a device it admits (step 2, Conditional Access) |
| Sign-in blocked with `530084` despite a compliant device | The authentication flow does not satisfy token protection | Try the native Windows broker (step 2); if it is also refused, ask IT to review the sign-in policy result |
| Codex: "Reconnecting… waiting for network", then "error sending request" | Nothing answers on the thread's provider port: the proxy or copilot-api is down, or the thread started on a provider whose server isn't running | Start them; or open a new thread |
| copilot-api 400 "function_call_output.call_id is required" | copilot-api before 2.9.7, with the Codex app adding its own context to the turn | Run 2.9.7 or later (step 3), then retry the turn |
| copilot-api 400 "This model does not support the responses endpoint" | A model name without `m365/`, often one the app saved from another provider | Pick an `m365/…` model; keep only gateway models in the catalog |
| copilot-api 400 "does not support tool 'web_search'" | Codex's hosted search | `web_search = "disabled"` |
| The Codex app shows the provider's name instead of your ChatGPT account | `requires_openai_auth = false` | Step 4 |
| 429 `priority_access_exhausted` | Opus 5.5's or Sonnet 5.5's daily allowance | Another model, or wait for midnight UTC |
| 429 `m365_throttled` | The account's turn budget | Wait; keep `M365_AVOID_THROTTLING=1` |
| The model says it's Microsoft Copilot and won't act | Harness identity text | `M365_HARNESS_PROMPT=lean` |
