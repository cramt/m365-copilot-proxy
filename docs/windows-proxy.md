# Running the proxy natively on Windows

Windows-native equivalents of the Linux/macOS `scripts/pi-local.sh` /
`scripts/pi-smoke-test.sh` flow, for running this repo directly on a Windows
machine (PowerShell), no WSL/bash required. See [AGENTS.md](../AGENTS.md) and
the main [README.md](../README.md) for the protocol/model background - this
doc only covers the Windows mechanics.

## Scripts

| Script | Purpose |
|---|---|
| `scripts\windows\Setup-Proxy.ps1` | Idempotent: toolchain, `pnpm install --frozen-lockfile`, build, Chromium |
| `scripts\windows\Start-Proxy.ps1` | Launch the proxy in a new visible window; optional interactive sign-in |
| `scripts\windows\Test-Proxy.ps1` | Smoke test: `/v1/models`, a harmless completion, a real tool-call regression |
| `scripts\windows\Stop-Proxy.ps1` | Stop the proxy (and its child `node.exe`) started by `Start-Proxy.ps1` |
| `scripts\windows\Install-ScheduledTask.ps1` | **Not run automatically.** Optional per-user logon persistence - see below |

All runtime state (PID, port, logs) lives under `.local\` at the repo root,
which is git-ignored. No credentials are ever written by these scripts -
auth state lives where the rest of the repo already puts it:
`%USERPROFILE%\.config\opencode-m365\` (`msal-cache.json`, `secrets.json` if
you use automated login, `browser-profile\`).

## Setup

```powershell
pwsh scripts\windows\Setup-Proxy.ps1
```

Requires Node 22+. Uses the repo's pinned pnpm (from `package.json`'s
`packageManager` field) via Corepack when available, falling back to
`npx pnpm@<pinned-version>` if Corepack can't write its shims (that write
goes under `C:\Program Files\nodejs`, which needs an elevated shell - the
script detects this and falls back automatically rather than failing).
Installs the Playwright Chromium build matching the installed
`playwright-core` version. Safe to re-run.

## Start

```powershell
pwsh scripts\windows\Start-Proxy.ps1                    # port 4141, loopback, interactive sign-in allowed
pwsh scripts\windows\Start-Proxy.ps1 -Port 4143          # different port
pwsh scripts\windows\Start-Proxy.ps1 -NoInteractive      # never pop a browser (needs secrets.json or a cached token)
pwsh scripts\windows\Start-Proxy.ps1 -BindHost 0.0.0.0   # NOT recommended - see "Loopback and exposure" below
```

This opens a **new, visible** PowerShell window running the proxy so a real
browser can appear for sign-in - it does not run hidden or inside this
shell. If no cached token and no `secrets.json` exist, a browser window pops
up: **finish SSO/MFA by hand in it, then return to the terminal.** Tokens
then refresh silently from `msal-cache.json` on every subsequent run - the
browser is a one-time cost.

Known first-run quirk (seen on macOS too, not Windows-specific): the very
first interactive attempt can close without completing. If that happens,
just re-run `Start-Proxy.ps1` - the partial MSAL state from the first attempt
is often enough that the second run signs in silently with no browser at
all (verified live on 2026-10-03).

## Validate

```powershell
pwsh scripts\windows\Test-Proxy.ps1
```

Checks, in order: `GET /v1/models` is non-empty; a `POST /v1/chat/completions`
echoes back a harmless phrase; a real multi-turn tool-call loop through the
`pi` harness (skipped with a note if `pi` isn't installed) writes a sentinel
file via an actual tool call, not prose. Exits non-zero if anything fails.

Uses `claude-sonnet` by default - that tone runs **agent-less**, so routine
smoke testing never triggers first-use Copilot Studio agent creation (see
"Agent creation" below). Override with `-Model <id>` to test another tone.

> **Why the harmless-completion prompt is phrased softly.** An aggressive
> "output ONLY this exact string, nothing else" instruction paired with a
> string that looks like a verification code (`PROXY_SMOKE_OK_123`) reads as
> jailbreak-shaped to M365's own content classifier and can get refused -
> this repo's own hypotheses notebook documents that shape, not size, drives
> the `Disengaged` filter. The script asks for a plain word instead.

## Stop

```powershell
pwsh scripts\windows\Stop-Proxy.ps1
```

Uses `taskkill /T /F` on the recorded PID, not `Stop-Process`: the PID
`Start-Proxy.ps1` records is the wrapper PowerShell window, and `node.exe`
(the actual listener) is its *child* - plain `Stop-Process` on Windows does
not kill child processes, which would leave the listener orphaned.

## Loopback and exposure

`Start-Proxy.ps1` sets `HOST`/`NITRO_HOST` to `127.0.0.1` by default and the
Nitro `node-server` preset honors it. Verify the actual listener yourself
after starting:

```powershell
Get-NetTCPConnection -LocalPort 4141 | Select-Object LocalAddress,LocalPort,State,OwningProcess
```

Confirmed `127.0.0.1` (loopback-only) in this environment. The proxy does
**not** authenticate incoming requests - its `apiKey` field is a placeholder
only the OpenAI client schema requires - so don't bind it to a non-loopback
address without adding your own auth in front of it. This script will not
create a firewall rule for you; that's an administrator-visible system
change the operator should make deliberately, if ever.

## OpenAI-compatible local endpoint

Point any OpenAI-compatible client at `http://127.0.0.1:4141/v1`. For `pi`
specifically, **merge** this into `~/.pi/agent/models.json` (create the file
if it doesn't exist yet; do not overwrite other providers already defined
there):

```json
{
  "providers": {
    "m365": {
      "api": "openai-completions",
      "apiKey": "not-needed",
      "baseUrl": "http://127.0.0.1:4141/v1",
      "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false, "supportsUsageInStreaming": false },
      "models": [
        { "id": "gpt-5.5-think-deeper", "name": "M365 Copilot (GPT-5.5, recommended for tools)" },
        { "id": "claude-sonnet", "name": "M365 Copilot (Claude Sonnet, agent-less)" }
      ]
    }
  }
}
```

`scripts\pi-local.sh` / `scripts\pi-smoke-test.sh` (bash) already do this for
an *isolated* repo-local pi home (`.pi-local/`) on Linux/macOS;
`Test-Proxy.ps1` does the Windows equivalent for its own isolated temp
profile rather than touching your real `~/.pi` config.

## Agent/tool behavior and Copilot Studio agent creation

The fenced-tool-call and shell-routing behavior (`formatFencedToolDefinitions`,
`parseFencedToolCalls`) is unchanged by this Windows work. One real bug
*was* found and fixed while running the suite natively on Windows for the
first time: `hostPlatformNote()` correctly detects `process.platform ===
"win32"` and injects Windows-specific tool guidance, but
`formatFencedToolDefinitions()` had no way to override that platform for
testing, so its own unit test asserting POSIX-only output could never
actually exercise Windows - it happened to pass only because CI ran on
Linux. Fixed by threading an optional `platform` parameter through
(`packages/core/src/fenced.ts`); see the git log for the exact diff.

**GPT tones (`gpt-5.5-think-deeper`, `m365-copilot`, etc.) attach a Copilot
Studio agent on first use** via the PowerPlatform API (creates+publishes a
bot, caches its id in `agent-id.json`) - this is existing, documented repo
behavior (see README.md "Agent mode"), not something this Windows work adds.
It is **not** a pueblo-agent capability and needs no external service - just
your own tenant's Power Platform entitlement, which your M365 login already
carries. `Test-Proxy.ps1` defaults to `claude-sonnet` specifically to avoid
exercising this path in routine smoke tests; pass `-Model gpt-5.5-think-deeper`
if you want to verify agent creation deliberately (it's a one-time ~3-5s
cost per tone, repeated only if the agent's instructions hash changes).

## Optional startup persistence (not enabled)

`scripts\windows\Install-ScheduledTask.ps1` registers a per-user logon
Scheduled Task - it is **never run automatically** by any other script here.
Creating it is an administrator-visible system change, so do it yourself,
deliberately, and only after `Start-Proxy.ps1` has completed interactive
sign-in successfully at least once:

```powershell
pwsh scripts\windows\Install-ScheduledTask.ps1          # register (does not run itself)
Get-ScheduledTask -TaskName "M365CopilotProxy"          # check status
Disable-ScheduledTask -TaskName "M365CopilotProxy"      # pause without removing
Unregister-ScheduledTask -TaskName "M365CopilotProxy" -Confirm:$false   # remove
```

The task runs with `-NoInteractive`, so if the MSAL cache ever goes stale it
fails loudly in its log instead of trying to pop an invisible browser under
a logon trigger - re-run `Start-Proxy.ps1` by hand to refresh the cache, and
the task resumes working on its own.

## Rollback

- Stop the proxy: `Stop-Proxy.ps1`.
- Remove cached auth state (forces a fresh sign-in next run):
  `Remove-Item -Recurse -Force "$env:USERPROFILE\.config\opencode-m365"`.
- Remove the scheduled task if you created one (see above).
- Revert the code changes: this work landed as ordinary commits on this
  branch - `git log` / `git revert` as usual, same as any other change.
- `.local\` (logs/PIDs) and `.pi-local\`/temp pi homes are disposable scratch
  state; delete freely.

## The model-proxy / Microsoft Graph boundary

This proxy is an **LLM backend only** - it wraps M365 Copilot's chat
WebSocket API so OpenAI-compatible clients get a model to talk to. It is
**not** a Microsoft Graph / mail / calendar / Teams / OneDrive / SharePoint
connector, and nothing in this Windows-native work adds one. A tool-calling
session can *talk about* those things exactly as well as it can talk about
anything else, but it has no code path that reads or writes your mailbox,
calendar, or files - the only filesystem/shell access available to a tool
call is whatever local tools the harness (e.g. `pi`) exposes to it, on your
own machine. Don't represent this proxy as a Graph-data integration to
anyone unless a separate, explicitly-configured connector is added and
verified.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `corepack enable` fails with `EPERM` | Needs admin rights to write shims under `C:\Program Files\nodejs`. `Setup-Proxy.ps1` falls back to `npx pnpm@<pinned>` automatically; or elevate once and re-run if you want the global shim. |
| A `.ps1` script throws `Missing closing '}'` pointing at an `if` block that is textually fine | Windows PowerShell 5.1 misreads a UTF-8 file **without a BOM** that contains any non-ASCII character (e.g. an em dash) using the system codepage, corrupting a string literal and desyncing brace counting. Save Windows PowerShell scripts as UTF-8 **with BOM**, or stick to ASCII punctuation. |
| `Cannot overwrite variable 'home'/'args' because it is read-only` inside a script | `$home` and `$args` are PowerShell automatic variables - never use them as your own parameter/variable names, even inside a `Start-Job` scriptblock's own `param()`. |
| A background `pi` run under an isolated `$env:HOME` can't find its config | Node's `os.homedir()` reads `USERPROFILE` on Windows, not `HOME`. Set both when sandboxing `pi`'s config dir for a test. |
| First interactive sign-in window closes with nothing logged | Known quirk (also seen on macOS); re-run `Start-Proxy.ps1` - the second attempt typically signs in silently from the partial MSAL state the first attempt left behind. |
| A chat completion is refused for an oddly generic/suspicious reason | If your prompt pairs a strict "output only this exact token" instruction with a token that looks like a verification/test code, M365's content classifier can read the *shape* as jailbreak-like and refuse. Soften the phrasing (see `Test-Proxy.ps1`'s own prompt for an example that works reliably). |
