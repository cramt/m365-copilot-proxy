# m365-copilot-proxy

Use Microsoft 365 Copilot as an LLM backend for OpenAI-compatible coding agents like [pi](https://pi.dev/) and [OpenClaw](https://docs.openclaw.ai/). Wraps M365 Copilot's WebSocket/SignalR API in an OpenAI-compatible interface with tool calling support.

> **Want the gory protocol details?** See [docs/m365-copilot-api.md](docs/m365-copilot-api.md) — a full write-up of M365 Copilot's undocumented WebSocket API: auth, SignalR frames, tones/models, throttling, the "Disengaged" filter, and the Copilot Studio agent trick that makes tool calling work.

## How it works

M365 Copilot uses a SignalR WebSocket protocol, not the OpenAI API. This project translates between the two:

1. **Standalone proxy** — HTTP server with `/v1/chat/completions` and `/v1/models` endpoints. Works with any OpenAI-compatible client (pi, OpenClaw, etc.).
2. **OpenClaw plugin** — Config generator + setup CLI for OpenClaw's provider system.

### Tool calling

M365 Copilot doesn't support OpenAI-style `tool_calls` natively. Instead, tools are
emulated via a **Markdown-fence format** (the JSON `{"tool":...}` format was removed —
it scored 0/5 on real agentic tasks; see [hypotheses §9](docs/hypotheses.md)):

- Tool definitions are injected into the prompt as fenced templates inside a `<tools>` block
- The model emits a fenced tool call — a code block whose info-string is the tool name
  (scalar args as `key: value` header lines, one free-form body arg as the fence body,
  `old`/`new` edits as aider-style `SEARCH/REPLACE` diffs)
- The proxy/handler parses that and converts it to OpenAI `tool_calls` format
- **Shell-routing (the key lever):** M365's chat-tuned model won't "act as an agent" on
  demand but *will* reflexively write a ```` ```bash ```` block. When the toolset includes a
  shell tool (`bash`/`shell`/`run`/`run_command`/… — any name), the proxy injects "do the
  whole step by writing one ```` ```bash ```` block" framing and routes that block to the
  shell tool. This exploits the one agentic behavior Microsoft's system prompt permits, and
  is what turns 0/5 into real multi-turn loops (verified 9-tool-call bug fix).
- **Reliability comes from the Copilot Studio agent (below) + the fenced/shell framing** —
  without the agent, M365 ignores tool instructions and answers in prose

### Agent mode

On first use, the system creates a **Copilot Studio agent** with tool-calling instructions baked into its server-side system prompt. This is done via the PowerPlatform API:

1. Discovers the environment URL via the BAP API (`api.bap.microsoft.com`)
2. Creates a bot with instructions in the Copilot Studio `minimalBots` API
3. Publishes the bot to get a `TitleId`
4. Uses the agent ID (`T_{titleId}.{botId}.gpt.default`) in WebSocket chat requests
5. Caches the agent ID in `~/.config/opencode-m365/agent-id.json`

### Conversation reuse

Each agent session reuses the same M365 conversation (same `sessionId` + `conversationId`). The WebSocket reconnects per turn but M365 maintains server-side context. This saves quota — the 600 message limit applies per-conversation.

### Chain of thought (`reasoning_content`)

Some models send M365 their reasoning as they work, which the web client shows in its chain-of-thought
card: Claude Sonnet 5.5, Sonnet 5, Opus 5.5 and Opus 4.8, and GPT-5.5 Think Deeper. Not on every turn: an
easy step usually has none. The proxy returns it as `reasoning_content`. A streamed reply carries it in
`delta.reasoning_content` chunks as it arrives, ahead of the answer, on tool turns too, while their text
is held back to be parsed. An unstreamed reply has it in `message.reasoning_content`. pi and opencode show
it as thinking with no configuration. It never goes back to M365: pi sends it back on its assistant
messages, and the proxy drops it there. `M365_NO_REASONING=1` leaves it out.

## Packages

```
@m365-copilot/core          — Shared: auth, WebSocket client, tool formatting, proxy server, agent management, session
├── @m365-copilot/proxy     — Standalone HTTP proxy binary
└── @m365-copilot/openclaw-plugin  — OpenClaw config generator + setup CLI + skill
```

## Setup

### Prerequisites

- Node.js 24+
- pnpm 10+
- A **work or school (Entra ID) account** with M365 Copilot Chat. Personal Microsoft
  accounts — Microsoft 365 Personal/Family, Outlook.com, copilot.microsoft.com — are
  not supported: the proxy talks to the enterprise M365 Copilot service, and the Office
  client it signs in as rejects personal accounts ("You can't sign in here with a
  personal account", #64). "Every account" elsewhere in this README means every work
  or school account, premium or not.
- A way to sign in, either:
  - **TOTP-based MFA with the base32 secret in hand** — the automated login types the
    6-digit code itself, so it needs the seed, not an app on your phone. See
    [Getting the TOTP secret](#getting-the-totp-secret). This is the headless-friendly
    option; prefer it if your tenant allows it.
  - **or a display and 30 seconds** — set `M365_ENABLE_INTERACTIVE_APPROVAL=1` and sign
    in by hand once. Required if your tenant has [no TOTP option](#if-your-tenant-has-no-totp-option)
    (push-only MFA, FIDO2, Okta/Ping/Duo).

### 1. Install

```sh
git clone https://github.com/cramt/m365-copilot-proxy
cd m365-copilot-proxy
pnpm install
pnpm build
```

### 2. Configure credentials

Create `~/.config/opencode-m365/secrets.json`:

```json
{
  "email": "you@company.com",
  "password": "your-password",
  "mfaSecret": "YOUR_TOTP_BASE32_SECRET"
}
```

`mfaSecret` is the **base32 seed** your authenticator app derives its 6-digit codes
from — not a code itself. It looks like `JBSWY3DPEHPK3PXP`: 16–32 characters, `A`–`Z`
and `2`–`7` only, no spaces.

#### Getting the TOTP secret

**Already using a password manager for TOTP? Just read it back out.** 1Password,
Bitwarden, KeePassXC, Aegis, Ente Auth and friends all keep the seed and will show it
on demand — open the item's one-time-password field and reveal it. You'll get either a
bare base32 string or an `otpauth://totp/...?secret=JBSWY3DPEHPK3PXP&...` URI; in the
second case the `secret=` parameter is the bit you want. No re-enrollment needed.

**If the seed is trapped in Microsoft Authenticator, enroll a second method.** That app
deliberately never exposes it, and Microsoft's security-info page won't re-display the
key after enrollment either — between them that's the only case where the seed is
genuinely unrecoverable. Enroll a fresh entry and copy it on the way past:

1. Go to <https://aka.ms/mfasetup> (**My Account → Security info**).
2. **Add sign-in method → Authenticator app**.
3. Click **"I want to use a different authenticator app"**. This step is the one that
   matters — the default path assumes Microsoft Authenticator and registers a
   push-only method with no seed you can extract.
4. At the QR-code screen, click **"Can't scan image?"**. It reveals a **Secret key** —
   that's your base32 string.
5. Generate a code from it to finish enrollment — `oathtool --totp -b <secret>`, or
   paste the seed into your password manager — and enter that code.

Store it somewhere that will give it back (see above) so this is a one-time chore. The
new entry sits alongside your existing sign-in methods; you don't have to remove
Microsoft Authenticator.

#### If your tenant has no TOTP option

Plenty of tenants can't do the above, and then there is no seed to extract:

- the authenticator-app / software-OATH method is disabled by tenant policy;
- MFA is push / number-matching only, FIDO2, Windows Hello, or certificate-based;
- sign-in is federated to a third-party IdP (Okta, Ping, Duo) that owns the MFA step.

The stored-credentials flow above cannot work in those cases — the automated login has
no code to type, and no amount of configuration fixes that.

**Use interactive approval instead.** Skip `secrets.json` entirely and set:

```sh
export M365_ENABLE_INTERACTIVE_APPROVAL=1
m365-proxy 4141
```

A real browser window opens; you complete SSO/MFA by hand exactly as you would in
Outlook — push, FIDO2, Okta, whatever your tenant enforces. The proxy captures the
resulting OAuth code and from then on refreshes tokens silently from the MSAL cache,
so the window is a **one-time cost**, not a per-run prompt. It also kicks in when
stored credentials exist but stop working (policy change, MFA method swap).

Contributed by [@EatonWu](https://github.com/EatonWu). Two honest caveats:

- It is **opt-in on purpose.** Without the flag a headless host (systemd, CI, a second
  PC) fails loudly instead of hanging on a window nobody can see. Set
  `M365_NO_INTERACTIVE=1` to veto it outright.
- The redirect capture and token exchange are the same ones the automated path uses in
  production, but **nobody has yet run this end to end against a federated Okta/Ping/Duo
  tenant.** If that's you, please report in
  [#4](https://github.com/cramt/m365-copilot-proxy/issues/4) — working or not.

> **Not device code.** The obvious headless alternative — `login.microsoft.com/device`
> with a short code — is permanently dead here, not merely unimplemented. Initiation
> returns a valid code, but redeeming it fails with `AADSTS7000218`: Entra treats
> Microsoft's own Copilot client as confidential for that grant and demands a
> `client_secret` only Microsoft holds. No tenant admin can grant it. Measured, with the
> sign-in actually completed, in [§13 H13.2](docs/hypotheses.md).

#### On WSL: sign in through Windows Edge

With Windows Edge installed, you can use its existing profile for sign-in instead
of storing credentials in `secrets.json`. Set `M365_EDGE_LOGIN=1` to explicitly
opt in to opening Edge. This is the only switch: `M365_ENABLE_INTERACTIVE_APPROVAL=1`,
a WSL host, an installed Edge or an existing `secrets.json` do not turn it on, so without
`M365_EDGE_LOGIN=1` the existing headless/automated login policy is unchanged.
`M365_NO_INTERACTIVE=1` always vetoes it. With `M365_EDGE_LOGIN=1`, Edge is tried
instead of `secrets.json` and the Playwright logins, once silent sign-in has failed.
Edge may ask you to choose an account or complete MFA; silent sign-in depends on your
tenant and session.

This path requires Node.js 22.13 or newer with `node:sqlite` available. It copies
the selected Edge History database and, if present, its write-ahead log into a
temporary directory while polling for the matching OAuth redirect. The copy can
contain your browsing history and authorization codes; it is removed after each
read, but may remain after a crash. The redirect may also remain in Edge history.
Access to your temporary directory and Edge profile should be restricted.

| Variable | Default |
|---|---|
| `M365_EDGE_PROFILE` | `Default` (profile directory name, e.g. `Profile 1`) |
| `M365_EDGE_PATH` | standard Edge install path (Linux/WSL executable path) |
| `M365_EDGE_USER_DATA` | Windows Edge user-data root discovered from `%LOCALAPPDATA%` |

Set `M365_EDGE_USER_DATA` to a **Linux/WSL filesystem path**, e.g.
`/mnt/c/Users/Alice/AppData/Local/Microsoft/Edge/User Data`, not a Windows
`C:\Users\...` string and not the `Default` / `Profile 1` subdirectory.
The resolved root is used both for History lookup and, after conversion with
`wslpath -w`, Edge's `--user-data-dir`; `M365_EDGE_PROFILE` selects the same
profile within that root. `wslpath` and Windows interop must be available.

#### First run

On first run, the system does an automated browser login (via Playwright/Chromium) to get OAuth tokens. After that, tokens refresh silently from the MSAL cache.

### 3. Use with pi (or any OpenAI-compatible agent)

Start the proxy:

```sh
m365-proxy 4143        # or: pnpm run proxy 4143
```

Point [pi](https://pi.dev/) at it via `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "m365": {
      "baseUrl": "http://localhost:4143/v1",
      "api": "openai-completions",
      "apiKey": "not-needed",
      "compat": {
        "supportsDeveloperRole": false,
        "supportsReasoningEffort": false,
        "supportsUsageInStreaming": false
      },
      "models": [
        { "id": "gpt-5.5-think-deeper", "name": "M365 Copilot (GPT-5.5, recommended)" },
        { "id": "m365-copilot", "name": "M365 Copilot (Auto)" }
      ]
    }
  }
}
```

> `apiKey` is a placeholder unless you set `M365_PROXY_KEY` on the proxy, in which case
> it must match. The proxy binds to `127.0.0.1` and refuses browser origins by default.

To let the model see images — a screenshot, a chart the agent drew, a PNG it `read`s — add
`"input": ["text", "image"]` to each model entry. pi then sends them as `image_url` parts and the proxy
uploads them to M365 the way the web client does.

Documents (PDF, Office files, text) work as OpenAI `file` parts, `{ "type": "file", "file": { "filename":
"spec.pdf", "file_data": "data:application/pdf;base64,…" } }`. Like the web client, the proxy uploads them
to your OneDrive's "Microsoft Copilot Chat Files" folder, where they stay.

Then run pi (use `gpt-5.5-think-deeper` — the reliable tool-calling model — and keep the
toolset lean; M365 "disengages" on very large tool payloads, see
[docs/m365-copilot-api.md](docs/m365-copilot-api.md#the-disengaged-filter)):

```sh
pi --models "gpt-5.5-think-deeper" -p --tools read,list,edit,write "your task"
```

This is verified working end-to-end, including multi-tool calls and real file edits.

**Long sessions.** Every turn draws on the account's throttle budget, about 100 turns refilled at
~1.6 a minute. A busy pi session can run it dry, and M365 then refuses every turn for about an hour
(`PerUserThrottled`). Start the proxy with `M365_AVOID_THROTTLING=1` (and `M365_DEBUG=1`, so it can
read the budget from its logs) and it slows the session down instead. Once the budget is down to a
reserve, it waits before each turn, inside the open stream so pi doesn't time out. See
[`M365_AVOID_THROTTLING`](#environment-variables).

### 4. Use with OpenClaw

```sh
# Configure and start in one command
m365-openclaw-setup --start

# Or configure only, then start separately
m365-openclaw-setup
m365-proxy 4141
```

The proxy uses session reuse and delta messages — follow-up turns only send new messages, saving M365 quota. New conversations are detected automatically when the message array shrinks or the first user message changes.

### 5. Use as standalone proxy

```sh
npx m365-proxy 4141
# or
pnpm run dev
```

Then point any OpenAI-compatible client at `http://localhost:4141/v1`.

#### Temporary chats

Proxy conversations use M365 **temporary-chat mode by default**
(`disableMemory=1` on the authenticated Chathub URL), so they are not added to
the Copilot history sidebar while multi-turn context still works for the live
conversation. Set `M365_SAVE_HISTORY=1` before starting the proxy only if you
deliberately want proxy chats saved in Copilot history. The Cowork and Code
backends have no temporary mode: their conversations show as tasks in the
Copilot app's sidebar while in use. The proxy deletes the ones it leaves, five
minutes on, drops idle ones after 30 minutes (`M365_RUNTIME_CONVERSATION_TTL_MINUTES`),
and on startup deletes what a stopped proxy left; `M365_SAVE_HISTORY=1` keeps them all.

### 5a. Use with Claude Code or Codex

Neither speaks this API directly: Claude Code only speaks Anthropic Messages, and Codex
only the Responses API. Put [copilot-api](https://github.com/caozhiyuan/copilot-api) in
front of the proxy as a translator. Run the proxy on another port (`m365-proxy 4143`) and
add it to copilot-api as an `openai-compatible` provider. Then point Claude Code
(`ANTHROPIC_BASE_URL`) or Codex (`wire_api = "responses"`) at copilot-api, and give
Claude Code a lean toolset (`--tools "Bash,Read,Edit,Write"`), and start the proxy with
`M365_HARNESS_PROMPT=lean`: without it, M365's models often refuse to act as these harnesses. First
live runs: Claude Code 6/6 on `claude-sonnet-5` with it, Codex 2/3. For GPT, Codex solved 7/7 on
`gpt-6.1-sol` over StreamHub (see [StreamHub](#streamhub-the-new-web-clients-transport));
without the tool agent GPT models need `M365_FRAMING_VARIANT=relay_batch` and
`M365_NO_CODE_INTERPRETER=1`. Full setup, what the proxy does
for these clients, and the known limits are in [docs/claude-code-codex.md](docs/claude-code-codex.md);
a step-by-step install from scratch, Windows and macOS, is [docs/setup.md](docs/setup.md).

### 6. Run on NixOS (systemd service)

The proxy is a [Nitro](https://nitro.build/) service. The flake exposes a package
(built from the workspace via [pnpm2nix](https://github.com/cramt/pnpm2nix)) and a NixOS
module:

```nix
# flake.nix
{
  inputs.m365.url = "github:cramt/m365-copilot-proxy";

  outputs = { nixpkgs, m365, ... }: {
    nixosConfigurations.myhost = nixpkgs.lib.nixosSystem {
      modules = [
        m365.nixosModules.default
        {
          services.m365-copilot-proxy = {
            enable = true;
            # JSON with { email, password, mfaSecret } — kept out of the Nix store,
            # delivered via systemd LoadCredential. Manage with sops-nix/agenix.
            secretsFile = "/run/secrets/m365-copilot.json";
            # port = 4141;          # default
            # host = "127.0.0.1";   # default — do not expose; unauthenticated, paid account
            # openFirewall = false;
          };
        }
      ];
    };
  };
}
```

The service runs as a hardened `DynamicUser` unit. Auth state (`msal-cache.json`,
`agent-id.json`) persists in `/var/lib/m365-copilot-proxy`; a fresh deploy self-bootstraps
via headless login using `secretsFile` + the bundled Chromium. To run the package directly
without NixOS: `nix run github:cramt/m365-copilot-proxy -- 4141`.

## Available models

| Model ID | M365 Tone | Description |
|---|---|---|
| `gpt-6-think-deeper` | Gpt_6_Reasoning | GPT-6 reasoning. **Needs a paid/premium Copilot seat** (see below); 30/30 on the bench (agent-less, `relay` framing). Defaults to `relay_batch`: 20/20 at 2.1 turns per task (relay: 3.2), 10/10 driving real pi |
| `gpt-6-sol` | Gpt_6_Sol_Reasoning | GPT-6 Sol ("GPT 6.0 Sol" in the web UI). Needs no paid scenario, but **a premium account**: a non-premium one is refused it by licence ([hypotheses §49 F146](docs/hypotheses.md)). Uses the tool agent (see below). Defaults to `relay_batch`: 40/40 on the bench with the agent, 60/60 without, 30/30 driving real pi, at 2.1 turns per bench task either way |
| `gpt-6.1-sol` | Gpt_61_Sol_Reasoning | GPT-6.1 Sol ("GPT-6.1 Sol" in the web UI). Like `gpt-6-sol`: **a premium account** (a non-premium one is refused it by licence), and the tool agent. Defaults to `relay_batch`: 40/40 on the bench, 30/30 driving real pi, at 2.7 turns per bench task with the agent and 2.2 without, and without the agent it keeps out of its sandbox, which `gpt-6-sol` doesn't always (see below) |
| `gpt-6.2-sol` | Gpt_62_Sol_Reasoning | GPT-6.2 Sol ("GPT-6.2 Sol" in the web UI, since 2026-11-17). Serves on the included scenario. Defaults to `relay_batch`, not yet benched; Codex 3/3 over StreamHub ([hypotheses §45](docs/hypotheses.md)) |
| `gpt-6.2-astra` | Gpt_62_Astra_Reasoning | GPT-6.2 Astra (marked "Uses credits" in the web UI): **its turns are charged to the user's Copilot credits.** Serves on the included scenario. Defaults to `relay_batch`, not yet benched |
| `gpt-6-astra` | Gpt_6_Astra_Reasoning (paid scenario) | GPT-6 Astra, also charged to Copilot credits. **Needs a paid/premium Copilot seat**: the included scenario gives M365's canned apology. The web UI replaced it with GPT-6.2 Astra on 2026-11-17. Defaults to `relay_batch`, not yet benched |
| `gpt-5.6-think-deeper` | Gpt_5_6_Reasoning | GPT-5.6 reasoning ("GPT-5.6 Sol Think deeper" in the reported web picker; see H-SOL56 in `docs/hypotheses.md`) — 27/30 on the bench, tied with `gpt-5.5-think-deeper`. Defaults to the `relay_batch` framing, which ends its give-ups in pi ([hypotheses §58](docs/hypotheses.md)) |
| `gpt-5.6` / `gpt-5.6-quick` | Gpt_5_6_Chat | GPT-5.6 fast ("GPT-5.6 Sol Quick response" in the reported web picker). **Weak at tool calling** — 7/30 on the bench (see below) |
| `gpt-5.5-think-deeper` | Gpt_5_5_Reasoning | **Recommended default for agents/tool-calling** — 26/30 on the bench |
| `gpt-5.5` / `gpt-5.5-quick` | Gpt_5_5_Chat | GPT-5.5 fast — 16/30 on the bench, the strongest benchmarked chat tone |
| `m365-copilot` / `auto` | magic | Auto-routing — high-variance at tool-calling (confabulates; see below) |
| `quick` | Gpt_5_5_Chat | Alias of `gpt-5.5` (its old `Gpt_Quick` tone was retired — see below) |
| `think-deeper` | Gpt_5_5_Reasoning | Alias of `gpt-5.5-think-deeper` (its old `Gpt_Reasoning` tone was retired) |
| `claude` / `claude-sonnet` / `claude-sonnet-4.6` | Claude_Sonnet | Real Anthropic Claude Sonnet 4.6 (agent-less path) — 78/90 on the bench with the `relay` framing (47/76 with `baseline`). Defaults to `relay_batch`: 40/40, and 21% fewer turns driving real pi (20/20). `claude-sonnet-4.5` is kept as an alias |
| `claude-sonnet-5.5` | Claude_Sonnet (paid scenario) | Claude Sonnet 5.5. **Needs a paid/premium Copilot seat** — same tone as above, the scenario picks the model — and has a separate quota: 80 turns a day, 150 a week (see below). Defaults to `relay`, inherited from Sonnet 5 (not benchmarked yet) |
| `claude-sonnet-5` | Claude_Sonnet_5 (paid scenario) | Claude Sonnet 5. **Needs a paid/premium Copilot seat**; no separate quota. 27/30 on the bench with the `relay` framing (6/40 with `baseline`; see below) |
| `claude-sonnet-think-deeper` | Claude_Sonnet_Reasoning | Claude reasoning |
| `claude-opus` / `claude-opus-5.5` | Claude_Opus (paid scenario) | Claude Opus 5.5. **Needs a paid/premium Copilot seat** and has a small separate quota: 40 turns a day (see below). 10/10 on the bench with `relay`; defaults to `relay_batch`. `claude-opus-5` is kept as an alias |
| `claude-opus-4.8` | Claude_Opus (included scenario) | Claude Opus 4.8. **Premium accounts only**, but **no** priority-access quota. With its default `relay_batch` framing and the tool agent: 30/30 on the bench at 2.5 turns per task, 10/10 driving real pi. `claude-opus-4.5` is kept as an alias (it was Opus 4.5 until October 2026) |
| `claude-fable` / `claude-fable-5.1` | Claude_Fable | Claude Fable 5.1 ("Fable 5.1" in the web UI, marked "Uses credits"): **its turns are charged to the user's Copilot credits.** Serves on the included scenario, agent-less like every Claude but Opus. Defaults to `relay_batch`, not yet benched; Claude Code and Codex 3/3 each over StreamHub ([hypotheses §45](docs/hypotheses.md)) |
| `gpt-5.4` / `gpt-5.4-quick` | Gpt_5_4_* | GPT-5.4 |
| `gpt-5.3` / `gpt-5.3-think-deeper` | Gpt_5_3_* | GPT-5.3 |
| `gpt-5.2` / `gpt-5.2-think-deeper` | Gpt_5_2_* | GPT-5.2 |

Bench scores are 10 tasks × 3 reps with the confab-retry **off** (`M365_NO_CONFAB_RETRY=1`), so
every first-try give-up counts, including ones the proxy's retry would normally recover
([hypotheses §19](docs/hypotheses.md)). GPT-6's 24/30 was measured with the retry on, so it
isn't directly comparable.

> **Microsoft retired the `*_Quick` tones; `*_Chat` tones replaced them.** Every `quick` /
> `*-quick` model ID still works and resolves to the replacement `*_Chat` tone (e.g.
> `gpt-5.3-quick` → `Gpt_5_3_Chat`), so existing configs need no change.

> ✅ **For tool calling, use `gpt-5.5-think-deeper` (the default when no model is sent).**
> The current agent + fenced/shell-routing path makes this reasoning tone robust:
> 26/30 on the bench, tied with `gpt-5.6-think-deeper` and well ahead of every benchmarked
> chat tone (docs/hypotheses.md §19), and 100% compliance and solve across prompt/toolset
> sizes in the tool-call harness (§12.10/§12.11). The **default `m365-copilot` (magic) tone is *not* reliable** for
> tools — it confabulates ("I no longer have access to the filesystem tools") and solves
> ~0% of real tasks (§12.11); a proxy request with no `model` field already defaults to
> `gpt-5.5-think-deeper` for this reason.
>
> ⚠️ The **older** reasoning tones (`gpt-5.2`/`gpt-5.3`/`gpt-5.4` `*-think-deeper`, bare
> `gpt-5.4`) route through M365's `DeepLeo` pipeline, which meta-analyzes the
> injected prompt and can disengage from tools. Prefer `gpt-5.5-think-deeper`.
> See [docs/m365-copilot-api.md](docs/m365-copilot-api.md) §5/§10.

### GPT-5.6 chat (`gpt-5.6` / `gpt-5.6-quick`) — newer, and worse at agentic work

The web client calls this one **"GPT 5.6 Quick response"**, which is the shape to expect:
it is the chat sibling of `gpt-5.6-think-deeper`, not a reasoning tone, and it self-identifies
as "the GPT-5 chat model" — exactly as `Gpt_5_5_Chat` does. Neither tone will tell you which
generation is actually answering, so don't pick between them on self-report.

**Pick it for chat, not for tools.** A higher version number is not an upgrade here: on the
bench it solves **7/30**, against **16/30** for `gpt-5.5`. Its low message count (39 vs 69)
is not efficiency: 22 of its 23 failures gave up before making a single tool call. See
[hypotheses §19](docs/hypotheses.md).

**No entitlement needed.** It reaches a model on the default `OfficeWebIncludedCopilot`
scenario, so the proxy sends nothing special for it. This is newly true: until recently the
tone deflected with the canned `BotConnection` apology on the included scenario while serving
normally under `OfficeWebPaidCopilot` — it was entitlement-gated like Opus, which
[hypotheses §12.15](docs/hypotheses.md) had misfiled as a permanently dead route.
See [§18](docs/hypotheses.md) for the correction.

### GPT-6 (`gpt-6-think-deeper`) — entitlement, but no separate quota

**It needs the paid scenario, exactly like Opus.** On the default
`OfficeWebIncludedCopilot` the `Gpt_6_Reasoning` tone is accepted and then deflects with the
canned apology; under `OfficeWebPaidCopilot` it serves normally. The proxy sends the paid
scenario automatically whenever the resolved tone is `Gpt_6_Reasoning`, so nothing has to be
configured — but this is an **entitlement, not a bypass**, and a seat without paid/premium
access will see the apology no matter which scenario is requested.

**It is not metered separately, and that is the part worth stating.** The paid scenario is an
entitlement gate; it does not imply a budget. GPT-6 has no priority-access allowance and is
throttled by the same per-conversation cap and thread-rate governor as every other model, so
none of the Opus advice about rationing turns applies.

**Tool calls go without the tool agent, and with a `relay` framing.** With the Copilot Studio
tool agent attached, `Gpt_6_Reasoning` doesn't serve at all (a canned apology, on every account),
so the proxy sends GPT-6 tool requests agent-less, as it does Claude's (#41). Agent-less, under the
`baseline` framing GPT-6 worked in M365's own code interpreter instead of calling your tools:
0/30 on the bench. Under `relay` it scored **30/30** (confab-retry off, 2026-10-01), and 5/5 driving
real pi. The default is now `relay_batch`, which asks it to put as much as it can into each block:
20/20 on the bench at 2.1 turns per task against relay's 3.2, and 10/10 through real pi at 3 turns
per run (hypotheses §25). `M365_FORCE_AGENT=1` and `M365_FRAMING_VARIANT` still override both.
`gpt-5.5-think-deeper` remains the recommended default and the no-model fallback, because it needs
no entitlement: making GPT-6 the default would hand most seats a model they can't reach.

### GPT-6 Sol (`gpt-6-sol`) — no entitlement, the agent only on premium

The web client calls it **"GPT 6.0 Sol"**; the tone is `Gpt_6_Sol_Reasoning` and it identifies
itself as the GPT-6 reasoning model. Unlike `gpt-6-think-deeper` it is **not** entitlement-gated: it
serves on the default included scenario, so the proxy sends nothing special for it. It needs a
premium account now: a non-premium account, where it served in October, is refused it by licence
("This model requires a Premium license"), on either transport ([hypotheses §49 F146](docs/hypotheses.md)).

**The tool agent depends on the account.** With the Copilot Studio tool agent attached, GPT-6 Sol
serves on a premium (paid Copilot) account and returns a canned apology on a non-premium one.
Nothing in the login token tells the two apart, so the proxy tries: the first tool request carries
the agent, and if it comes back as that dead route the proxy remembers it for the rest of the
process and re-sends the request without the agent. Your client never sees the failure; a
non-premium account spends one ~3 s turn per proxy start, which `M365_FORCE_AGENT=0` avoids. A
premium account occasionally returns the same apology as a one-off; once the agent has answered,
the proxy treats that as a transient and retries instead of dropping the agent.

**Without the agent it has a sandbox of its own.** It runs `bash` in a remote machine (`/mnt/data`,
`/home/oai`), finds none of your files there, and asks you to upload them, or hands back a Teams link
to a file it made. Turning off M365's code interpreter (`M365_NO_CODE_INTERPRETER=1`) doesn't stop
it. The user-voice `relay` framing does: on the bench it solved 60/60 agent-less, against 0–6/10 for
every other framing, and 30/30 with the agent (the others 3–9/10). Its batching variant,
`relay_batch`, is the default on both paths: it keeps relay's wording and asks for one script per
turn, which cut the turns by a third on the bench (60/60 agent-less, 40/40 with the agent) and by a
fifth to a quarter in real pi (30/30 runs). It doesn't send GPT-6 Sol to its sandbox any more often
than `relay` (an earlier, smaller run suggested it did; the retest found no difference). Details:
[hypotheses §23, §28](docs/hypotheses.md).

### GPT-6.1 Sol (`gpt-6.1-sol`) — GPT-6 Sol's routing, and the `relay_batch` framing

The web client calls it **"GPT-6.1 Sol"**; the tone is `Gpt_61_Sol_Reasoning`, and like GPT-6 Sol it
identifies itself as the GPT-6 reasoning model. It is routed exactly like `gpt-6-sol`: the default
included scenario, which serves it on a premium account (a non-premium one is refused it by licence,
as for GPT-6 Sol), and the tool agent only on a premium account, which the proxy learns from the
first tool request (see above).

**It has a separate allowance, which the proxy doesn't use.** The paid scenario serves it too, but
every paid turn spends a GPT-6.1 Sol allowance of 40 turns a day and 75 a week, the size of Opus
5.5's; included turns spend nothing, and a non-premium account can't use the paid scenario at all.
So the proxy stays on the included one. Whether the paid scenario serves a newer model behind the
same name is still open: the model can't tell you, since its self-description is M365's.

**It defaults to `relay_batch` on both paths.** Without the agent it has a sandbox like GPT-6 Sol's,
and the framings that put the instructions in a `<system>` block send it there: `baseline` solved
0/20 and `minimal` 2/20. The framings written as the user's own request kept it out entirely. As with
GPT-6 Sol, it went to the sandbox no more often under `relay_batch` than under `relay` (never, on the
bench), so here the turn saving decides: 40/40 on the bench against relay's 39/40 at 17% fewer turns
with the agent and 36% fewer without, and 30/30 runs driving real pi at 29% and 47% fewer turns (about
4 and 3 per run). Details: [hypotheses §27](docs/hypotheses.md).

**Without the agent it matches GPT-6 Sol on the bench, but stays out of its sandbox.** Side by side
on both non-premium accounts, the two solved the same tasks at the same turns under every framing:
`relay_batch` and `honest` everything (about 2.1 and 2.9 turns per task), `baseline` and `minimal`
nothing. The difference is the sandbox: told by the user's note that it's the wrong machine, GPT-6.1
Sol never went into it under `relay_batch` (0 of 80 bench tasks and pi runs so far), where GPT-6 Sol
still looks around in it on about a quarter of tasks — harmless, but on a non-premium account
`gpt-6.1-sol` is the tidier of the two. It also shows the included scenario's GPT-6.1 Sol isn't GPT-6
Sol under a new name. Details: [hypotheses §29](docs/hypotheses.md).

### Sonnet 5 and 5.5 (`claude-sonnet-5`, `claude-sonnet-5.5`) — their own sandbox, and the `relay` framing

`Claude_Sonnet` is Sonnet 4.6 on the included scenario and **Sonnet 5.5** on the paid one, and
Sonnet 5 has its own tone, `Claude_Sonnet_5`, which is likewise Sonnet 4.6 unless the scenario is
paid. So both need a paid/premium seat, like Opus. Microsoft made that switch on 2026-10-06: before
it, the paid `Claude_Sonnet` was Sonnet 5, which is why `claude-sonnet-5` now maps to the new tone.

**Sonnet 5.5 is metered: 80 turns a day, 150 a week**, separately from Opus, one per turn (in a
coding loop, one per tool call). The proxy handles it like the Opus quota below:
`usage.x_m365_sonnet55_daily_remaining` / `x_m365_sonnet55_weekly_remaining` on every response, a
429 once it's used up, and an opt-in fallback, `M365_SONNET_FALLBACK_MODEL` (e.g. `claude-sonnet-5`,
which isn't metered). Sonnet 5 has no such quota.

Sonnet 5 arrives with **its own tools** (`bash_tool`, `create_file`, …) running in a remote
sandbox (`/home/claude`) that cannot see your files, and it reads the proxy's usual
`<system>`-tagged tool framing as a prompt injection — so with that framing it inspects its own
empty sandbox and reports that your files don't exist (6/40 on the bench). Sonnet 5.5 has the same
sandbox. The proxy therefore gives every Sonnet model a user-voice framing instead. Sonnet 5's
default is `relay`: a plain note
asking it to guide you through your terminal one command at a time, which also tells it the sandbox
is the wrong machine. That scores **27/30** on the bench (from 5/30) and solved **5/5** fix-bug runs
through real pi. Sonnet 4.6 beat `baseline` with it too (78/90 vs 47/76), and now defaults to
`relay_batch`, the same note asking it to put as much as it can into each block: same solves, 21%
fewer turns through real pi (39/39). On Sonnet 5 that saved only 6% in pi, so it stays on `relay`.
Sonnet 5.5 starts on `relay` too, until it has been benchmarked.
Override with `M365_FRAMING_VARIANT` as usual. Details: hypotheses §21, §25, §26.

### Opus (`claude-opus`, `claude-opus-4.8`) — two models, one with a small quota

The `Claude_Opus` tone serves two models, picked by the `scenario` the WebSocket is opened with:

| Model ID | Model | Scenario | Who can use it | Quota |
|---|---|---|---|---|
| `claude-opus` (`claude-opus-5.5`, `claude-opus-5`) | Claude Opus 5.5 | `OfficeWebPaidCopilot` | paid/premium seat | small priority-access quota |
| `claude-opus-4.8` (`claude-opus-4.5`) | Claude Opus 4.8 | `OfficeWebIncludedCopilot` | premium account | none beyond the usual throttling |

The proxy picks the scenario from the model ID, so nothing has to be configured. This is an
**entitlement, not a bypass**: without a paid/premium seat neither model serves. `claude-opus`
then gets a licence-refusal message, and `claude-opus-4.8` a 502 saying it's premium-only. `licenseType`
alone unlocks nothing; override either with `M365_SCENARIO` / `M365_LICENSE_TYPE`.

**`claude-opus-4.8`'s tool requests carry the Copilot Studio tool agent**, like `claude-opus`'s.
Without the agent Opus 4.8 has a code interpreter of its own, and unless the framing steers it away it
works there instead of in your harness, reporting success on files it never touched. The default
`relay_batch` framing does steer it away, and there the two paths solve the same, so the agent is the
safety margin. Requests without tools go without it. Until October 2026 this route served Claude Opus
4.5, and only through the agent; `claude-opus-4.5` now reaches Opus 4.8 (see hypotheses §24, §36).

**`claude-opus` is metered separately: 40 turns a day, 75 a week.** Opus 5.5 draws on a "priority
access" budget distinct from the ~600-message conversation cap, and **every M365 turn costs one,
whatever its size**. In an agent loop every tool call is a turn, so one coding task costs 3–5 and a
day's budget is gone after about ten tasks. That's what [issue #18](https://github.com/cramt/m365-copilot-proxy/issues/18)
ran into; a shorter prompt doesn't help. Both budgets reset at **midnight UTC**, the weekly one on Monday.

What the proxy does about it:
- **Shows the budget:** every `claude-opus` response carries `usage.x_m365_opus_daily_remaining` and
  `usage.x_m365_opus_weekly_remaining`.
- **Says when it's used up:** M365 ends the turn with a refusal (*"You've used your available priority
  access to the Opus model for today…"*), which the proxy turns into **HTTP 429**
  (`code: priority_access_exhausted`, `param: day|week`) with a `Retry-After` to the reset — on the
  streaming path an `error` chunk with the same fields. It then answers further `claude-opus`
  requests itself until the reset, without spending M365 turns on more refusals.
- **Can fall back to Opus 4.8:** with `M365_OPUS_FALLBACK_MODEL=claude-opus-4.8`, a `claude-opus`
  request that hits the wall is sent to `claude-opus-4.8` instead (unmetered, premium accounts only),
  and so is every later one until the reset. The response's `model` field says which model answered.
- **Spends fewer turns:** the `relay_batch` framing (below) asks the model to do as much as it can
  per tool call, and avoids the jailbreak-filter retries that cost `claude-opus`'s old default framing
  a wasted turn on about 40% of tasks.

**Both use the tool agent and the `relay_batch` framing.** On the bench Opus 4.5 solved nearly every
task whatever the framing, so two other things decided it. M365's jailbreak classifier: the proxy's
older `<system>`-tagged framings tripped it on a third of the tasks (each one a wasted turn and a
retry in a fresh conversation), the user-voice `relay` framings on none. And turns:
`relay_batch` asks the model to put as much as it can into each command block, which took Opus 4.5
from 3.65 to 2.30 turns per bench task (20/20 either way) and from 6 to 3.5 turns per real-pi run
(10/10 either way) — on Opus 5.5 that's ~17 tasks a day instead of ~11. The cost to watch is a
block that acts before it has seen any output; in pi every edit still came after a read. Opus 5.5
went 10/10 on the bench with `relay`; it hasn't been benched with `relay_batch` yet. Opus 4.8, which
replaced Opus 4.5, went 30/30 with it at 2.5 turns per task.
Override with `M365_FRAMING_VARIANT` as usual. Details: [hypotheses §24, §36](docs/hypotheses.md).

### StreamHub, the new web client's transport

The new web client (`copilot.cloud.microsoft`) reaches Copilot over a second WebSocket, StreamHub.
The proxy speaks both: `M365_TRANSPORT=streamhub` sends every model over StreamHub, under the web
client's own `officeweb` scenario and without the tool agent (sent there, it isn't applied:
[hypotheses §49 F144](docs/hypotheses.md)).

**A non-premium account needs the included scenario there.** Under `officeweb` it is refused,
whatever the model, and the proxy passes the refusal on as the answer ("It looks like you don't have
a valid license…"). With `M365_SCENARIO=OfficeWebIncludedCopilot` StreamHub serves it, and of the
models probed, the same ones as Chathub: `m365-copilot` and the GPT-5.5 and GPT-5.6 models. Every
Claude and GPT-6.x model is refused on either transport ([hypotheses §49 F145, F146](docs/hypotheses.md)).

That switch is for accounts whose Chathub refuses GPT-6.x: on the test account, `gpt-6-think-deeper`,
`gpt-6-sol`, `gpt-6.1-sol` and `gpt-5.5-think-deeper` answered every prompt with
`InputTokenLimitExceeded`, even one line (§39 F105). Two separate causes, neither the prompt
([hypotheses §40](docs/hypotheses.md)):
- **The scenario.** GPT-6.1 Sol is refused under `OfficeWebIncludedCopilot` on either transport and
  served under `officeweb`.
- **The Bing plugin** an agent-less turn carries. GPT-6 and GPT-5.5 Think Deeper are refused with it
  and answer without it. The proxy now learns this per model: the first refusal is re-sent once
  without Bing, in a fresh conversation, and later requests leave Bing off for that model.

With `M365_TRANSPORT=streamhub` all of them answer on that account. Through copilot-api (`lean`
harness prompt, `relay_batch`, no code interpreter), Codex on `gpt-6.1-sol` over StreamHub solved
7/7 of the harness-check tasks at 2.1 M365 turns each, where `gpt-5.6-think-deeper` on Chathub
managed 5/8. Under
`officeweb` the scenario no longer picks between models, so `claude-sonnet` is Sonnet 5.5 there, and
StreamHub turns carry no priority-access `metering`, so the proxy can't log or pre-empt those budgets.
Wire details: [API doc §13](docs/m365-copilot-api.md).

### Backends: Chat, Cowork and Code

Every model above runs on M365 Copilot **Chat**. The web app's **Cowork** and **Code** tabs run on a
different service, Copilot's agent runtime, and the proxy can send turns there too. What it gives:
a longer turn (GPT-6.2 Sol read about 885k tokens in one message; Chat's GPT-6.x reads about 272k), and
none of Chat's per-user throttle. What it costs: **every turn is charged to your Copilot credits** (see
[Credit usage](#credit-usage) below).

Model IDs name their backend in parentheses, then the tokens one turn has been seen to hold and
whether turns cost credits:

| ID | backend | model |
|---|---|---|
| `gpt-6.2-sol(chat)_272k` | Chat | the same as `gpt-6.2-sol` |
| `gpt-6.2-astra(chat)_272k_credit` | Chat | GPT-6.2 Astra, a credit-billed Chat model |
| `claude-sonnet-5.5(cowork)_640k_credit` | Cowork | Sonnet 5.5 on the agent runtime |
| `claude-opus-5.5(code)_640k_credit` | Code | Opus 5.5 on the agent runtime |
| `gpt-6.2-sol-substrate(code)_885k_credit` | Code | GPT-6.2 Sol on the agent runtime |

Only the parentheses route: a request may send `claude-sonnet-5.5(cowork)`, or an ID with stale
suffixes. To switch backend, a client switches model; nothing else changes. `GET /v1/models` lists one
such ID per model and backend, with `context_window` set to the window it names, after the plain Chat
IDs, which are unchanged and stay on Chat.

The runtime's models come from its live catalog (read every 10 minutes), which changes: on Nov 19 2026
it listed GPT-5.5, GPT-6.1 Sol, GPT-6.2 Sol (and Fast), GPT-6.2 Astra, Opus 5.5 (and Fast) and Sonnet 5.5,
by that afternoon only the three Claude models, and by evening GPT-6.2 Sol again as
`gpt-6.2-sol-substrate`, with GPT-6.2 Sol Fast and GPT-6.2 Astra. A model it doesn't have gets a 400
`model_not_found`. GPT-6.2 Sol there takes up to about 885k tokens in one message, on Cowork and Code alike:
885,233 o200k tokens answered, 891,591 refused, which GPT-6.2 Astra and Sol Fast refused too; every GPT
model there is labelled `_885k` ([hypotheses §48 H48a](docs/hypotheses.md)).

- `M365_BACKENDS` lists the backends `/v1/models` shows and requests may name; by default all three
  (`chat,cowork,code`). `M365_BACKENDS=chat` keeps a proxy off the runtime: a request naming `cowork`
  or `code` then gets a 400. An ID without parentheses always stays on Chat, so a client spends
  credits only by picking a `(cowork)` or `(code)` model.
- `M365_DEFAULT_BACKEND=cowork` sends an ID without parentheses (`claude-sonnet-5.5`) to that backend
  when it serves the model; other IDs stay on Chat.
- On the runtime the proxy sends a long history whole, passes `reasoning_effort`, skips Chat's tool
  agent and throttle budget, and reports the turn's credits as `usage.x_m365_credits`.
- The runtime lists each conversation as a task in your Cowork or Code sidebar (in the Copilot app's
  **Recent** list too) until it's deleted; there's no temporary mode as on Chat. So the proxy deletes the
  ones it leaves five minutes later, drops a conversation 30 minutes after its last request
  (`M365_RUNTIME_CONVERSATION_TTL_MINUTES`; the next request replays the history into a fresh one), and
  on startup deletes the ones a proxy that's no longer running left (it lists its own in
  `~/.config/opencode-m365/runtime-conversations/`). It deletes nothing else. `M365_SAVE_HISTORY=1`
  keeps them all ([hypotheses §48 F140](docs/hypotheses.md)). An open Copilot app keeps listing a
  deleted task until it reloads or restarts; only Chat models stay out of the list entirely.
- A failed request's conversation isn't continued: the runtime keeps a message once it's posted, so the
  client's retry, the same history again, goes into a fresh conversation (F140).
- Closing a request doesn't stop a run there (the runtime has no stop call the proxy could find), and
  images and files aren't passed on yet.
- **Code's agent works in its own cloud workspace**: with a long Codex history at max effort it ran its own
  tools and answered with no text on three turns of five. The proxy ends such a turn at once with a 502
  `runtime_no_reply`; Cowork and Chat models answer in text. A runtime turn at high effort can take
  minutes, so give Codex `stream_idle_timeout_ms = 900000` (at 300000 it re-sent the whole request every
  5 minutes) ([hypotheses §48 F139](docs/hypotheses.md)).
- The Code tab's **local** sessions, with their "Long context" switch, are a third service the proxy
  can't use: the Copilot app runs them through a bundled runtime on Office's LLM API, whose sign-in the
  proxy's app registration isn't consented for ([hypotheses §48 F136](docs/hypotheses.md)).

In shells, quote IDs with parentheses: `claude --model "m365/claude-sonnet-5.5(cowork)_640k_credit"`.
Wire details: [API doc §14](docs/m365-copilot-api.md).

#### Credit usage

Measured Nov 19 2026 on one premium account, one turn each unless noted
([hypotheses §48 F134, F138](docs/hypotheses.md)). **Code is charged like Cowork**, and the monthly budget
counts both. The charge is the sum of the turn's `cq` events; a title
and a follow-up suggestion on a small model add about 0.005–0.01 each.

| backend | model | turn | credits |
|---|---|---|---|
| Cowork | Sonnet 5.5 | one line, new conversation | 0.04 |
| Cowork | GPT-6.2 Sol | one line, new conversation | 0.9–1.3 (n=3); 9.2 once |
| Cowork | GPT-6.2 Sol | one line, follow-up | 0.4 (n=2) |
| Cowork | Opus 5.5 | tool request with the proxy's framing, new conversation | 4.9 |
| Cowork | GPT-5.5 | the same | 20.6 |
| Code | Sonnet 5.5 | one line, new conversation | 2.6 (n=2) |
| Code | GPT-6.2 Sol | one line, new conversation | 9.5 |
| Code | GPT-6.2 Astra / Sol Fast / Opus 5.5 | one line, new conversation, evening | 38.4 / 9.6 / 4.2 |
| Cowork | GPT-6.2 Astra / Sonnet 5.5 | the same | 37.0 / 5.2 |
| Code | GPT-6.2 Astra, max effort | Codex, 537k-character history, 4 sessions with retries | about 3,200 |
| Cowork | GPT-6.2 Sol | 900k characters (~363k tokens) | 101 |
| Cowork | GPT-6.2 Sol | 2.0M characters (~806k tokens) | 224 |
| Cowork | GPT-6.1 Sol | 2.0M characters | 232 |
| Cowork | GPT-5.5 | 2.0M characters | 506 |
| Cowork | GPT-6.2 Astra | 2.0M characters | 927 |
| Cowork | Sonnet 5.5 | 1.6M characters (~645k tokens) | 236 |
| Cowork | Opus 5.5 | 1.6M characters | 481 |
| Cowork | Sonnet 5.5 | 2.0M characters, refused as too long | 0.01 |
| Cowork or Code | GPT-6.2 Sol (`gpt-6.2-sol-substrate`, evening) | one line to 2.19M characters | 0.02–0.06 (n=6) |
| Cowork | the same | 2.5M or 3.0M characters, refused as too long | 0.03–0.04 |

Per 1,000 tokens of a long turn: GPT-6.2 Sol 0.28, GPT-6.1 Sol 0.29, Sonnet 5.5 0.37, GPT-5.5 0.63,
Opus 5.5 0.75, GPT-6.2 Astra 1.15, measured in the morning. That evening `gpt-6.2-sol-substrate` charged
only its title and suggestion calls, up to 2.19M characters, so prices change too; check a task's cost
before relying on one. A new conversation pays for the runtime's own system prompt (Code's
is larger than Cowork's); a follow-up is cached. `usage.x_m365_credits` counts the charges that arrive
by the end of the turn, so it can miss a late suggestion's (Sonnet 5.5: 0.038 reported, 0.042 in the
task's total). The monthly budget the runtime reports (`/v1/entitlement`, 1,000,000) takes these
charges, Cowork's and Code's, in batches about five minutes apart. On Chat, GPT-6.2 Astra, GPT-6 Astra and Fable mark their turns as
using credits without saying how many ([hypotheses §45 F122](docs/hypotheses.md)); the other Chat
models don't charge credits.

## Image generation

M365 Copilot generates images through a built-in server-side tool, and the core
package exposes it as one call. The picture comes back on a `GraphicArt` frame as
a URL (never as chat text), and the bytes sit behind a separate auth boundary —
`generateImage()` handles both, returning the image with bytes attached:

```ts
import { generateImage } from "@m365-copilot/core";

const [img] = await generateImage("A minimalist flat-design logo of a lighthouse, teal and white.");
// img.data      -> Buffer (real PNG, verified end-to-end)
// img.base64    -> same bytes, ready for an OpenAI-style b64_json response
// img.contentType, img.size, img.orientation
```

Everything the M365 web client can do is reachable — the proxy sends the same image
optionsSets it does. Steer type and aspect with options (they nudge the prompt the
way the GUI's meta-prompting does; the model still makes the final call):

```ts
await generateImage("a lighthouse on a cliff", { orientation: "portrait" });   // landscape | portrait | square
await generateImage("a lighthouse", { style: "icon" });                        // natural | icon | story | designer
```

**You don't have to call `generateImage` at all.** Just like the web client, a plain
chat turn draws when asked — send `"draw me an image of a green teapot"` to
`/v1/chat/completions` (or `ModelSession.run`) with no tools and the image comes back
embedded in the reply as a markdown data-URI. (Image gen is enabled on the agent-less
path only, so it never competes with tool calling; set `M365_NO_IMAGE_GEN=1` to force
pure text.)

Runs its own agent-less session. Uses the same login as chat; the artifact fetch uses
a `designerappservice` token acquired silently from the existing cache. Protocol
write-up: [docs/hypotheses.md §14](docs/hypotheses.md).

> **Separate, scarcer budget.** Image generation draws on its own daily quota, distinct
> from the ~600-message conversation limit and not metered by the chat throttle — treat
> image calls as the expensive ones. When it's exhausted, `generateImage()` throws
> `ImageGenerationError` with `reason: "quota_exceeded"` (map it to HTTP 429); a plain
> chat turn instead returns M365's "can't generate any more images today" message as text.

An OpenAI-compatible `POST /v1/images/generations` endpoint on top of this is the
next step — the core API it needs is already in place.

## Authentication

The default auth flow uses Azure MSAL with PKCE:

1. **Silent refresh** — cached tokens from `~/.config/opencode-m365/msal-cache.json`. The
   normal path; costs nothing and opens nothing.
2. **Automated login** — headless Playwright browser driving the AAD form with stored
   credentials + a TOTP code generated from `mfaSecret`.
3. **Interactive approval** — visible browser, human completes SSO/MFA (§13). Only when
   `M365_ENABLE_INTERACTIVE_APPROVAL=1`, and only after step 2 is unavailable or has
   actually failed. This is the path for tenants where no TOTP seed exists.

On WSL, `M365_EDGE_LOGIN=1` adds a step between 1 and 2: sign in through the Windows Edge
profile ([On WSL: sign in through Windows Edge](#on-wsl-sign-in-through-windows-edge)).
Without the flag nothing changes.

All three redeem the code against `https://login.microsoftonline.com/common/oauth2/nativeclient`
with PKCE. That redirect isn't a stylistic choice: the client is Microsoft's own Copilot app
(the Sydney scopes are granted to no other), so nobody can register a loopback URI — a
generated `http://localhost:<port>` callback is rejected with `AADSTS50011`, and the device-code
grant demands a `client_secret` only Microsoft holds (`AADSTS7000218`). Both measured live in
[§13](docs/hypotheses.md); don't spend probes re-deriving them.

Three token scopes are acquired:
- `substrate.office.com/sydney/*` — For M365 Copilot chat
- `api.powerplatform.com/.default` — For Copilot Studio agent management
- `api.bap.microsoft.com/.default` — For environment discovery

On Windows, `M365_AUTH_MODE=wam` opts into the native Windows authentication broker
instead of browser PKCE. It uses the same client ID and scopes, with no browser or
stored-password fallback. Set `M365_ENABLE_INTERACTIVE_APPROVAL=1` for the first
Windows account-picker sign-in; subsequent acquisitions use the broker silently.
With multiple accounts, `M365_LOGIN_HINT` selects one, or an interactive sign-in
records the selection. Only the selected account ID is saved to
`~/.config/opencode-m365/wam-account.json`; refresh tokens remain managed by WAM,
not the proxy's JSON token cache. This is a supported authentication mechanism,
not an exemption from your organization's Conditional Access policy.

## Environment variables

| Variable | Description |
|---|---|
| `M365_DEBUG` | Set to `1` to enable debug logging to `~/.config/opencode-m365/debug.log` (truncated payloads) |
| `M365_LOG_FILE` | Debug log name, relative to `~/.config/opencode-m365/` (default `debug.log`; an absolute path is used as is). `M365_LOG_FILE=my/log.log` logs to `~/.config/opencode-m365/my/log.log`. |
| `M365_LOG_MAX_BYTES` | The most debug-log history kept on disk: bytes, or a `KB`/`MB` suffix (`M365_LOG_MAX_BYTES=60MB`; default `50MB`, an unreadable value falls back to it). Once the file passes 1.6× the window, the oldest bytes are cut from its head, on a line boundary, and written back through a temporary file and an atomic rename. The file is never emptied or renamed away, because the turn budget replays that history. Windows refuses the rename while another process has the log open (a terminal tailing it); the cut is then written in place, and after a cut that fails the next waits for another tenth of the window. |
| `M365_TRACE` | Set to `1` for full, untruncated debug logging (every WS frame/prompt/response) — implies `M365_DEBUG`. For reverse engineering. |
| `M365_LOG_STDOUT` | Set to `1` to mirror debug lines to the proxy's stdout as well as the log file, so you can watch a run without tailing it in a second terminal. Needs `M365_DEBUG` or `M365_TRACE` — on its own it logs nothing. |
| `M365_DUMP_FRAMES` | Set to `1` to write every WebSocket frame (both directions) to `~/.config/opencode-m365/frames/<requestId>.ndjson`. For offline diffing of new M365 fields. |
| `M365_FRAME_DIR` | Frame dump directory, relative to `~/.config/opencode-m365/` (default `frames`; an absolute path is used as is). `M365_FRAME_DIR=my/frames` dumps to `~/.config/opencode-m365/my/frames/`. |
| `M365_ALLOW_MULTI_TOOL` | Allow the model to emit multiple tool calls per turn (default: only the first is kept) |
| `M365_LONG_ANSWER_GUARD` | Set to `1` to return a long written answer that ends in a single example command as text instead of running the command. Off by default: a single tool call is never reclassified as prose. When on, it applies only if the call is the last thing in the reply and the preamble is at least 1,500 characters of an intentionally limited plain-text subset with a heading or meaningful table header and separator; markup and code conservatively keep the action. Not benched; it can still turn a real action into text, so enable it only if you see an answer's trailing example being run ([hypotheses §53 F154](docs/hypotheses.md)). |
| `M365_NO_EARLY_STOP` | Set to `1` to let a tool turn run to its end after the model starts writing its own `<tool_response>`. By default the proxy stops the turn once that invented tail passes `M365_EARLY_STOP_AFTER` chars (the invented part is cut either way), which saves minutes when the model invents the rest of the session (#65) |
| `M365_EARLY_STOP_AFTER` | How many chars of a model-written `<tool_response>` tail a tool turn may run before the proxy stops it (default `2000`; `0` stops at the tag). M365 keeps a short tail in the conversation and the model seems to follow it: stopping at the tag cost Sonnet 4.6 10% more turns in real pi, the default none measurable ([hypotheses §35](docs/hypotheses.md)) |
| `M365_STREAM_ERROR_MODE` | How a streaming request that fails after its HTTP 200 is reported: `chunk` (an OpenAI-style `error` chunk) or `text` (the reason as the assistant's message, with `finish_reason: "stop"`). Unset, Claude Code and Codex user-agents get `text` and every other client gets `chunk`. Through copilot-api, an error chunk made Claude Code retry the turn ten times, each retry opening fresh M365 conversations ([docs/claude-code-codex.md](docs/claude-code-codex.md)). |
| `HOST` / `NITRO_HOST` | Address the standalone `m365-proxy` binds. Default `127.0.0.1`; `0.0.0.0` listens on every interface. Anyone who reaches the port spends your M365 account, so pair that with `M365_PROXY_KEY`. |
| `M365_PROXY_KEY` / `M365_PROXY_KEY_FILE` | When set, every request except `GET /health` must send the key as `Authorization: Bearer <key>` or `x-api-key: <key>` (401 otherwise). pi and openclaw send their configured `apiKey` that way. The NixOS module's `apiKeyFile` sets the file variant. |
| `M365_CORS_ORIGIN` | Comma-separated browser origins allowed to call the proxy, or `*` for any. Unset, no CORS headers are sent and any request with an `Origin` header gets a 403, which stops web pages (including DNS-rebinding ones) from driving your account. CLI clients send no `Origin` and are unaffected. |
| `M365_MAX_REQUEST_BYTES` / `M365_REQUEST_BODY_TIMEOUT_MS` | Limits on a `POST /v1/chat/completions` body: the most bytes the proxy reads (default `33554432`, 32 MiB) and the most time it waits for all of it (default `30000` ms). A longer or slower body gets a 413 or 408; invalid UTF-8 or JSON gets a 400. |
| `M365_HARNESS_PROMPT` | For Claude Code and Codex user-agents only: `off` (default) sends their prompts as they are; `clean` drops what M365's models read as an injection — Anthropic's billing header, the "You are Claude Code / a Claude agent, built on Anthropic's Claude Agent SDK / a coding agent running in the Codex CLI" lines, and `<system-reminder>` blocks (model ID, token budget, git attribution; the environment and date ones are unwrapped); `lean` also cuts each tool description to ~700 characters. Sonnet 5 in Claude Code went from 0/3 to 3/3 with `lean` ([docs/claude-code-codex.md](docs/claude-code-codex.md), [hypotheses §39](docs/hypotheses.md)). |
| `M365_INJECT_REPLY_TOOL` | Set to `1` to inject a synthetic `reply(text)` tool. Forces every turn to be a tool call, including pure-prose answers. Cleaner contract for the model, +1 tool to the prompt (watch the Disengaged threshold). Confirmed 5/5 compliance on June 9 2026 ([hypotheses §1.1](docs/hypotheses.md)). |
| `M365_NO_CONFAB_RETRY` / `M365_CONFAB_RETRIES` | M365's chat model sometimes produces prose instead of a tool call when it should act — either confabulating an inability ("I can't access the files, please paste them") **or** claiming a completion it never did ("I've replaced the README", with no tool call). By default the proxy detects both and re-prompts forcefully **in the same conversation** (`M365_CONFAB_RETRIES`, default `1`) to force a real action. Set `M365_NO_CONFAB_RETRY=1` to disable. |
| `M365_NO_FENCE_RETRY` | When a tool turn has a tool block the parser can't read (a fence that never closed, an edit without its markers), the proxy asks once, in the same conversation, saying what was wrong and that the model may reply without it. That costs an upstream turn, and the forcing retry above is skipped after it. Set `M365_NO_FENCE_RETRY=1` to disable ([hypotheses §51](docs/hypotheses.md)). |
| `M365_NO_BACKOFF` (alias `M365_NO_AUTO_REAUTH`) | Set to `1` to disable degradation backoff. By default, when empty/throttled responses span several **distinct conversations** in a short window (the thread-rate-throttle signature, [F13](docs/hypotheses.md)), the proxy **paces subsequent turns** (a jittered delay before starting new backend conversations) to let the account self-heal. This replaced the old auto-reauth: a fresh login does **not** clear this throttle (it's `oid`-keyed — [§11 H-R1](docs/hypotheses.md)) and raised our detection profile. A single long pi thread never trips the trigger. |
| `M365_BACKOFF_THRESHOLD` / `M365_BACKOFF_WINDOW_MS` / `M365_BACKOFF_BASE_MS` / `M365_BACKOFF_MAX_MS` | Tune backoff: distinct-conversation empties to trigger (default `3`), the window they must fall in (default `120000`), the initial pacing window (default `90000`), and its escalation cap (default `600000`). |
| `M365_AVOID_THROTTLING` | Set to `1` to keep the account clear of M365's `PerUserThrottled` throttle. A long pi session or a bench sweep trips it by running the account's turn budget dry (~100 turns, refilled at ~1.6 a minute, [hypotheses §24 F58](docs/hypotheses.md)), and it then refuses every turn for about an hour. With this set, the proxy waits before each upstream turn until the budget holds that turn plus a reserve of 20. A streamed request waits on its keepalive chunks, so pi doesn't time out, and the session runs at ~1.6 turns a minute once the budget is low. After a throttled turn the proxy holds new turns for 75 minutes and answers them with a 429 (`m365_throttle_hold`, with `Retry-After`) instead of sending them: each one would keep the throttle alive. The budget is read from the debug logs under `~/.config/opencode-m365`, so with `M365_DEBUG=1` it also counts the bench's and other proxies' turns and survives a restart. Without it, only this process's turns since it started count. The bench uses the same variable ([scripts/bench/README.md](scripts/bench/README.md)). Off by default. [Hypotheses §37](docs/hypotheses.md). |
| `M365_BUDGET_MAX_WAIT_MIN` | The longest `M365_AVOID_THROTTLING` holds a streamed request (default `15`, enough to refill an empty budget). A longer wait, usually a throttle hold, gets the 429 instead. A request that isn't streamed waits at most 2 minutes, since it sends nothing until the answer and clients give up on it after 5. Both limits count the time a request spends behind others waiting their turn. A larger value (e.g. `90`) lets a streamed request sit out a throttle hold instead of failing: pi has no time limit on a stream that keeps sending data. |
| `M365_BUDGET_CAPACITY` / `M365_BUDGET_REFILL` / `M365_BUDGET_RESERVE` / `M365_BUDGET_HOLD_MIN` / `M365_BUDGET_LOGS` | Tune `M365_AVOID_THROTTLING`'s budget model: its size (default `100` turns), refill rate (`1.6` a minute), the reserve kept back (`20`), the hold after a throttled turn (`75` minutes), and more log files or directories to read (`:`-separated). |
| `M365_BROWSER_PROFILE` / `M365_LOGIN_UA` | Override the persistent browser-profile dir and the login User-Agent used for browser authentication (**Playwright only**; the Selenium path never uses a profile). The persistent profile keeps AAD SSO/device cookies so repeat logins are silent and look like a familiar device ([§11 H-R3](docs/hypotheses.md)). |
| `M365_BROWSER_PROVIDER` | Browser driver for automated and interactive login: `playwright` (default) or `selenium`. Selenium requires a reachable Grid and `selenium-webdriver` installed next to the built `.output` (the proxy keeps it external to avoid shipping selenium-manager binaries for every platform). |
| `M365_SELENIUM_URL` | Selenium WebDriver/Grid endpoint (default `http://localhost:4444`); used only with `M365_BROWSER_PROVIDER=selenium`. |
| `M365_SELENIUM_BROWSER` | Browser name requested from Selenium Grid (default `chrome`). Only `chrome` is supported — the code capture reads Chrome performance logs. |
| `M365_AUTH_MODE` | Set to `wam` for native Windows broker authentication (optional `@azure/msal-node-extensions` dependency required). Unset, browser PKCE remains the default. WAM never falls back to browser auth. |
| `M365_LOGIN_HINT` | In WAM mode, select a broker account by its sign-in name; otherwise the saved selection or a single available account is used. Multiple accounts without a selection require the interactive account picker. |
| `M365_WAM_WINDOW_HANDLE` | Optional positive decimal native parent-window handle for the Windows account picker. Used only when WAM interaction is enabled. |
| `M365_ENABLE_INTERACTIVE_APPROVAL` | Set to `1` to allow a **visible** browser window for sign-in when the automated login can't work or fails — the fallback for tenants with no TOTP option (push-only MFA, FIDO2, Okta/Ping/Duo). With Playwright, a visible local browser opens; with Selenium, complete sign-in/MFA through the Grid's VNC/noVNC session; in WAM mode, the native Windows account picker opens instead. You complete SSO/MFA by hand once; tokens refresh silently afterwards. Off by default so headless hosts fail loudly rather than hang. See [If your tenant has no TOTP option](#if-your-tenant-has-no-totp-option). |
| `M365_EDGE_LOGIN` | Set to `1` on WSL to sign in through the Windows Edge profile instead of stored credentials, after silent refresh fails. The only switch for it; `M365_NO_INTERACTIVE=1` vetoes it. `M365_EDGE_PROFILE`, `M365_EDGE_PATH` and `M365_EDGE_USER_DATA` are in [On WSL: sign in through Windows Edge](#on-wsl-sign-in-through-windows-edge). |
| `M365_NO_INTERACTIVE` | Set to `1` to hard-disable any visible browser login or WAM account picker, overriding the flag above. For systemd/CI hosts where a window must never open. |
| `M365_INTERACTIVE_TIMEOUT_MS` | How long to wait for you to finish the interactive sign-in (default `600000`, i.e. 10 minutes). |
| `M365_LOGIN_LOCALE` / `M365_LOGIN_TIMEZONE` | Browser locale and timezone presented during login (defaults `en-GB` / `Europe/Copenhagen`). These are part of the anti-bot-scoring fingerprint ([§11 F25](docs/hypotheses.md)) — set them to match your own machine if AAD starts treating your automated login as a bot. |
| `M365_FORCE_AGENT` | Override which tool requests carry the Copilot Studio tool agent. `1` attaches it to every tool request (and turns off the GPT-6 Sol fallback below); `0` never attaches it. Unset, the proxy decides per model: GPT-5.x, `m365-copilot` and both Opus models take it, the other Claude models and `gpt-6-think-deeper` don't, and `gpt-6-sol` / `gpt-6.1-sol` take it only on a premium account, which the proxy learns from the first request. On a non-premium account `0` saves the probe turn (~3 s) per GPT-6 Sol model per proxy start. |
| `M365_OPUS_FALLBACK_MODEL` | Model to serve `claude-opus` (Opus 5.5) requests with once its priority-access budget is used up, instead of returning a 429 — typically `claude-opus-4.8`, which isn't metered (premium accounts only). Applies until the budget resets; the response's `model` field names the model that answered. Unset by default. |
| `M365_SONNET_FALLBACK_MODEL` | The same for `claude-sonnet-5.5` (Sonnet 5.5) once its priority-access budget is used up — e.g. `claude-sonnet-5` (unmetered) or `claude-sonnet` (Sonnet 4.6, any account). A fallback naming a metered model is ignored. Unset by default. |
| `M365_SCENARIO` / `M365_LICENSE_TYPE` | Override the entitlement the WebSocket is opened under (defaults: `OfficeWebIncludedCopilot` / `Starter`, switching to `OfficeWebPaidCopilot` / `Premium` for the entitlement-gated models — `claude-opus`, `gpt-6-think-deeper`, `claude-sonnet-5` and `claude-sonnet-5.5`; `claude-opus-4.8` and `gpt-6.1-sol` stay on the included one). `scenario` is what gates the model list (and picks Sonnet 4.6 vs 5.5 for the `Claude_Sonnet` tone, Sonnet 4.6 vs 5 for `Claude_Sonnet_5`, Opus 4.8 vs 5.5 for `Claude_Opus`); `licenseType` rides along and unlocks nothing by itself. Forcing the paid scenario on `gpt-6.1-sol` spends its separate GPT-6.1 Sol allowance (40 turns a day, 75 a week), which the proxy doesn't track. |
| `M365_TRANSPORT` | `streamhub` sends every model over StreamHub, the new web client's WebSocket (`copilot.cloud.microsoft`), under its `officeweb` scenario and without the tool agent; unset, every model uses Chathub. For accounts whose Chathub refuses GPT-6 (`InputTokenLimitExceeded` on any prompt). Under it the scenario no longer picks between models: `claude-sonnet` is Sonnet 5.5 there. A non-premium account needs `M365_SCENARIO=OfficeWebIncludedCopilot` with it: `officeweb` refuses it every model, and the included scenario serves it no more models than Chathub does. See [StreamHub](#streamhub-the-new-web-clients-transport). |
| `M365_BACKENDS` | Comma list of the backends whose models `/v1/models` lists and requests may name: `chat`, `cowork`, `code` (default: all three). Cowork and Code run on Copilot's agent runtime and **charge every turn to your Copilot credits**; `M365_BACKENDS=chat` keeps a proxy off them, and a request naming one that isn't listed then gets a 400. Chat requests are always served. See [Backends](#backends-chat-cowork-and-code). |
| `M365_DEFAULT_BACKEND` | Where a model ID without a `(backend)` goes when that backend is in `M365_BACKENDS` and serves the model (default `chat`). `cowork` moves `claude-sonnet-5.5` and the other runtime models there; every other ID stays on Chat. |
| `M365_AETHER_ENDPOINT` | The agent runtime's endpoint for `cowork` and `code`. Unset, the proxy asks the runtime's routing service once per process. |
| `M365_CONVERSATION_TTL_HOURS` | How long the proxy keeps an idle conversation and continues it with only the new messages (default `24`). After that, the next request replays the whole history into a fresh M365 conversation. M365 keeps a conversation for at least 21 h ([hypotheses §46](docs/hypotheses.md)). |
| `M365_RUNTIME_CONVERSATION_TTL_MINUTES` | The same for Cowork and Code conversations, in minutes (default `30`; Chat's TTL under `M365_SAVE_HISTORY=1`). They show as tasks in the Copilot app until deleted, so the proxy drops and deletes one this long after its last request, checking every minute. See [Backends](#backends-chat-cowork-and-code). |
| `M365_TURN_CHUNK_BYTES` | The longest turn the proxy sends M365 whole, in UTF-8 bytes (default `400000`, at least `1024`; `0` sends every turn whole). M365 answers a turn of about 500k characters but doesn't keep it in the conversation, so a longer one goes up in parts: a replayed history as earlier-conversation parts the model acknowledges, then the request with the system prompt and tool framing; a long follow-up as numbered parts ([hypotheses §46, §47](docs/hypotheses.md)). |
| `M365_MAX_TURN_PARTS` | The most M365 turns a long turn may take, its parts and the answered one (default `12`, at least `2`). Each part is a turn on the account's turn budget and, on a metered model, a unit of its allowance. A request that needs more gets a 400 `context_length_exceeded`, so the client compacts. |
| `M365_REPORT_USAGE` | Set to `0` for zero token counts in `usage`. By default they are estimates (see below). |
| `M365_NO_REASONING` | Set to `1` to leave the model's chain of thought out of replies. By default it goes out as `reasoning_content` (see [Chain of thought](#chain-of-thought-reasoning_content)). |
| `M365_TURN_IDLE_MS` | Maximum silence between received frames, including before handshake (default `120000` ms); invalid, nonpositive or timer-overflow values fall back to the default. |
| `M365_RECONNECT_DELAY_MS` | Delay before retrying a recognized network error (default `5000` ms; `0` disables the delay). Invalid, negative or timer-overflow values fall back to the default. |
| `M365_CACHE_FILE` | Override MSAL token cache location. The cache is replaced by renaming a temporary file in the same directory, so the path must be an ordinary file in a writable directory: a single file bind-mounted into a container (or on another filesystem from its directory) fails with `EBUSY`/`EXDEV` and the proxy reports a cache write error instead of carrying on. Mount the cache's directory instead. The error's `cause` carries the OS error code. |
| `M365_SECRETS_FILE` | Override credentials file location |
| `CHROMIUM_PATH` | Path to Chromium binary for automated login |

### Usage / context-window % in responses

M365 reports no token counts, so `prompt_tokens` and `completion_tokens` are the
proxy's estimates: the whole request as the model reads it (history, system
prompt, tool framing) and the reply, at 4 UTF-8 bytes a token (`M365_REPORT_USAGE=0`
for zeros). They let a client see its context fill and compact before its window
runs out; Codex never compacted without them. A client compacts at the window it
is configured with: OpenClaw's generated config gives every model 128,000. How much
context M365 actually gives: GPT-6.x models read about 270k tokens a turn and
summarize older turns; the Claude models read 2M characters or more and keep about
1.6M over a conversation ([hypotheses §47](docs/hypotheses.md)).

The block also carries M365 extension fields with the **per-conversation
message quota**:

```json
"usage": {
  "prompt_tokens": 300548,
  "completion_tokens": 57,
  "total_tokens": 300605,
  "x_m365_conversation_messages": 42,
  "x_m365_conversation_max": 600,
  "x_m365_conversation_pct": 7,
  "x_m365_conversation_remaining": 558,
  "x_m365_content_origin": "DeepLeo",
  "x_m365_turn_count": 42,
  "x_m365_classifier_scores": {
    "BotOffense": 1.27e-7,
    "dea_violation": 2.81e-6
  },
  "x_m365_dea_score": 2.81e-6,
  "x_m365_offense_score": 1.27e-7
}
```

`x_m365_dea_score` is M365's own "disengaged-eligible answer" classifier
score — the closest signal to "am I about to get Disengaged?". Empirically:
clean tool calls sit at ~1 × 10⁻⁸, prose at ~1 × 10⁻⁶, jailbreak-shaped
prompts at ~1 × 10⁻³. Disengaged itself fires at some threshold > 2 × 10⁻³
that we haven't yet pinpointed. Clients can monitor this to back off before
tripping the filter.

On the Cowork and Code backends, `x_m365_credits` is what the request's turns
were charged in Copilot credits.

Clients that ignore unknown extension fields keep working; curious users can
read them. See [docs/hypotheses.md §0](docs/hypotheses.md) for the full
findings dump and [§2](docs/hypotheses.md) for what we tried and didn't find.

## Config files

All stored in `~/.config/opencode-m365/`:

| File | Description |
|---|---|
| `secrets.json` | Login credentials (email, password, mfaSecret) |
| `msal-cache.json` | MSAL token cache (auto-managed) |
| `agent-id.json` | Cached Copilot Studio agent ID |
| `debug.log` | Debug log (when `M365_DEBUG=1`; renamed by `M365_LOG_FILE`) |
| `frames/` | WebSocket frame dumps (when `M365_DUMP_FRAMES=1`; moved by `M365_FRAME_DIR`) |

## Development

```sh
pnpm install
pnpm build            # Build all packages
pnpm run dev          # Start standalone proxy on :4141
pnpm run test:unit    # Run vitest unit tests (no auth/network)
pnpm run test:live    # Run live integration tests against M365
```

## Known limitations

- **M365 "disengages" on large tool payloads** — heavy agent harnesses (e.g. opencode's ~15-tool prompt) get empty `Disengaged` responses. Keep the toolset lean (this is why [pi](https://pi.dev/) works well). A heavy harness can be trimmed to fit, though opencode in particular needs that done in the proxy rather than through its own config, and its tool count has since dropped — see [docs/m365-copilot-api.md](docs/m365-copilot-api.md#the-disengaged-filter).
- Tool calling is emulated (prompt injection + a Copilot Studio agent), not native function calling — robust with the agent, unreliable without it
- The `think-deeper` / `*_Reasoning` models take 10-30s per response
- Hard quota of ~600 messages **per conversation** (mitigated by session reuse + delta sends)
- `claude-opus` needs a paid/premium seat and has its own small priority-access quota (40 turns a day, 75 a week; every tool call is a turn) that resets at midnight UTC (weekly on Monday); exhaustion surfaces as a 429, or as a switch to `M365_OPUS_FALLBACK_MODEL`. `claude-opus-4.8` needs a premium account too, but has no such quota
- `claude-sonnet-5.5` needs a paid/premium seat and has a priority-access quota of its own (80 turns a day, 150 a week), handled the same way (`M365_SONNET_FALLBACK_MODEL`). `claude-sonnet-5` needs the seat but has no quota
- Streaming: **tool-less** responses stream incrementally (deltas forwarded as they arrive). **Tool-calling** turns are still buffered server-side — the raw text has to be parsed for tool-call fences before it can be emitted — so those arrive as a single chunk at the end (with an immediate HTTP 200 + heartbeats so the client never times out waiting)
- **M365 deletes `[word]:` from a reply's final text**, code blocks included, and not every time: `[regex]::Replace(` arrives as `:Replace(`, and a Python `def f(self) -> list[str]:` or `if row[col]:` loses the token and the line break after it. The proxy puts the text back from the streamed deltas where it has them; on Windows it asks for full dotted .NET type names (`[System.Text.RegularExpressions.Regex]::Replace`) and won't run a PowerShell command that still lost one. A short reply may come without deltas, so Python or JavaScript written that way can still arrive broken (usually as a syntax error the model then sees). See [hypotheses §40 F111](docs/hypotheses.md)
- A single reply is capped by M365 at roughly 11-12k characters; a longer file written in one go can end early (finish_reason `length` from 12,000 characters, `M365_OUTPUT_CHAR_CEILING`)

## License

[MIT](LICENSE). Use at your own risk — this speaks to Microsoft's API with your own
credentials, on your own account, and that's between you and your tenant's
acceptable-use policy.
