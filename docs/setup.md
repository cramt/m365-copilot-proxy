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

No. Run the published package, `@jeffreycao/copilot-api` (built from
[caozhiyuan/copilot-api](https://github.com/caozhiyuan/copilot-api)), with `npx`. Clone the repo only
to change copilot-api itself. You need copilot-api only for Codex and Claude Code, and it doesn't need
GitHub Copilot: with a provider configured and no GitHub login it starts in provider-only mode. If you
already run it for Copilot, add the provider in step 3 and your Copilot models stay. Tested with 2.6.23.

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

Then start it on 127.0.0.1:4143 (copilot-api takes 4141). Unset, the host is every interface, and the
proxy has no auth.

Windows (PowerShell):

```powershell
$env:HOST = '127.0.0.1'; $env:NITRO_HOST = '127.0.0.1'
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
export HOST=127.0.0.1 NITRO_HOST=127.0.0.1
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
  Enterprise SSO. A refusal at this step is your organization's policy; nothing in the proxy changes
  it, so use a device it admits.
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

It listens on 127.0.0.1 by default. Models appear as `m365/<model id>`, and any ID the proxy knows
routes, listed here or not: `curl -s http://127.0.0.1:4141/v1/models` should show them. If the file has
`auth.apiKeys`, use one of those keys wherever the steps below say `not-needed`.

## 4. Codex

Save the brief below to a file, say `~/.codex/m365-brief.txt`. It replaces Codex's ~40k-character
instructions, which name the Codex CLI throughout, and cut Codex's M365 turns per task from 5.3 to 2.3:

```text
I'm working on a project in the current directory of my computer. My terminal tools run the commands and file edits you ask for, and I send you back their output. Please work through the task step by step with those tools, and finish with a short answer.
```

Build a model catalog from copilot-api's, with each model's context window. The Codex app lists only its
own GPT models without one, so this is also what puts Claude in its picker:

```sh
node scripts/codex-catalog.mjs --out=~/.codex/m365-models.json m365/gpt-6.1-sol m365/claude-sonnet-5 m365/claude-opus
```

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
stream_idle_timeout_ms = 300000
```

Use absolute paths (on Windows, single-quoted: `'C:\Users\you\.codex\m365-models.json'`). The Codex app
reads all of this at startup, so restart it after a change. `requires_openai_auth = true` is for the
app's account menu; the CLI ran with this file and no ChatGPT login. Things to know:

- **The app keeps each thread on the provider it started with,** and saves the model you last picked
  as the default without its provider. Keep only gateway models in the catalog (or put other backends
  behind copilot-api too: [claude-code-codex.md](claude-code-codex.md), step 5).
- **Context windows** come only from the catalog. Codex compacts at 90% of a window, but the gateway
  reports 0 tokens used, so for `m365/*` models Codex never compacts and M365 holds the context.
- **Metered models.** On Chathub `claude-opus` (Opus 5.5) is limited to 40 turns a day and
  `claude-sonnet-5.5` to 80, every tool call a turn, while `gpt-6.1-sol` and `claude-sonnet-5` spend no
  allowance. StreamHub reports no meters at all (hypotheses §41), so prefer the unmetered models.
- **Sandbox.** On Windows, Codex 0.157 refused every command in its sandbox, `workspace-write`
  included ("blocked by policy", even `echo`), so the tested runs used
  `--dangerously-bypass-approvals-and-sandbox`. On macOS and Linux use `-s workspace-write`.

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
| Codex: "Reconnecting… waiting for network", then "error sending request" | Nothing answers on the thread's provider port: the proxy or copilot-api is down, or the thread started on a provider whose server isn't running | Start them; or open a new thread |
| copilot-api 400 "This model does not support the responses endpoint" | A model name without `m365/`, often one the app saved from another provider | Pick an `m365/…` model; keep only gateway models in the catalog |
| copilot-api 400 "does not support tool 'web_search'" | Codex's hosted search | `web_search = "disabled"` |
| The Codex app shows the provider's name instead of your ChatGPT account | `requires_openai_auth = false` | Step 4 |
| 429 `priority_access_exhausted` | Opus 5.5's or Sonnet 5.5's daily allowance | Another model, or wait for midnight UTC |
| 429 `m365_throttled` | The account's turn budget | Wait; keep `M365_AVOID_THROTTLING=1` |
| The model says it's Microsoft Copilot and won't act | Harness identity text | `M365_HARNESS_PROMPT=lean` |
