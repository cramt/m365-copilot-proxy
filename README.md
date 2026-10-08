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
- An M365 account with Copilot access
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

> `apiKey` is a placeholder. The proxy binds to localhost and validates no
> credential — the field exists only because the OpenAI client schema requires it.

To let the model see images — a screenshot, a chart the agent drew, a PNG it `read`s — add
`"input": ["text", "image"]` to each model entry. pi then sends them as `image_url` parts and the proxy
uploads them to M365 the way the web client does.

Then run pi (use `gpt-5.5-think-deeper` — the reliable tool-calling model — and keep the
toolset lean; M365 "disengages" on very large tool payloads, see
[docs/m365-copilot-api.md](docs/m365-copilot-api.md#the-disengaged-filter)):

```sh
pi --models "gpt-5.5-think-deeper" -p --tools read,list,edit,write "your task"
```

This is verified working end-to-end, including multi-tool calls and real file edits.

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
deliberately want proxy chats saved in Copilot history.

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
| `gpt-6-sol` | Gpt_6_Sol_Reasoning | GPT-6 Sol ("GPT 6.0 Sol" in the web UI). **Works on every account**, no paid seat needed; uses the tool agent only on a premium account (see below). Defaults to `relay_batch`: 40/40 on the bench with the agent, 60/60 without, 30/30 driving real pi, at 2.1 turns per bench task either way |
| `gpt-6.1-sol` | Gpt_61_Sol_Reasoning | GPT-6.1 Sol ("GPT-6.1 Sol" in the web UI). **Works on every account**, and uses the tool agent only on a premium account, like `gpt-6-sol`. Defaults to `relay_batch`: 40/40 on the bench, 30/30 driving real pi, at 2.7 turns per bench task with the agent and 2.2 without, and without the agent it keeps out of its sandbox, which `gpt-6-sol` doesn't always (see below) |
| `gpt-5.6-think-deeper` | Gpt_5_6_Reasoning | GPT-5.6 reasoning — 27/30 on the bench, tied with `gpt-5.5-think-deeper` |
| `gpt-5.6` / `gpt-5.6-quick` | Gpt_5_6_Chat | GPT-5.6 fast ("GPT 5.6 Quick response" in the web UI). **Weak at tool calling** — 7/30 on the bench (see below) |
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
| `claude-opus-4.5` | Claude_Opus (included scenario, tool agent) | Claude Opus 4.5. **Premium accounts only**, but **no** priority-access quota. With its default `relay_batch` framing: 20/20 on the bench at 2.3 turns per task, 10/10 driving real pi |
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
serves on the default included scenario on premium and non-premium accounts alike, so the proxy
sends nothing special for it.

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
included scenario, which serves it on premium and non-premium accounts alike, and the tool agent
only on a premium account, which the proxy learns from the first tool request (see above).

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

### Opus (`claude-opus`, `claude-opus-4.5`) — two models, one with a small quota

The `Claude_Opus` tone serves two models, picked by the `scenario` the WebSocket is opened with:

| Model ID | Model | Scenario | Who can use it | Quota |
|---|---|---|---|---|
| `claude-opus` (`claude-opus-5.5`, `claude-opus-5`) | Claude Opus 5.5 | `OfficeWebPaidCopilot` | paid/premium seat | small priority-access quota |
| `claude-opus-4.5` | Claude Opus 4.5 | `OfficeWebIncludedCopilot`, tool agent attached | premium account | none beyond the usual throttling |

The proxy picks the scenario from the model ID, so nothing has to be configured. This is an
**entitlement, not a bypass**: without a paid/premium seat neither model serves. `claude-opus`
then gets a licence-refusal message, and `claude-opus-4.5` a 502 saying it's premium-only. `licenseType`
alone unlocks nothing; override either with `M365_SCENARIO` / `M365_LICENSE_TYPE`.

**`claude-opus-4.5` only works through the Copilot Studio tool agent**, so the proxy attaches the
agent to every request on it, tools or not. Without the agent the route returns a canned apology on
every account, which is why earlier notes in this repo recorded Opus on the included scenario as
dead. It may introduce itself as "Claude Opus 5": that's what its system prompt says, and the model
itself mostly answers "Opus 4.5" (see hypotheses §24).

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
- **Can fall back to Opus 4.5:** with `M365_OPUS_FALLBACK_MODEL=claude-opus-4.5`, a `claude-opus`
  request that hits the wall is sent to `claude-opus-4.5` instead (unmetered, premium accounts only),
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
went 10/10 on the bench with `relay`; it hasn't been benched with `relay_batch` yet.
Override with `M365_FRAMING_VARIANT` as usual. Details: [hypotheses §24](docs/hypotheses.md).

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

The auth flow uses Azure MSAL with PKCE:

1. **Silent refresh** — cached tokens from `~/.config/opencode-m365/msal-cache.json`. The
   normal path; costs nothing and opens nothing.
2. **Automated login** — headless Playwright browser driving the AAD form with stored
   credentials + a TOTP code generated from `mfaSecret`.
3. **Interactive approval** — visible browser, human completes SSO/MFA (§13). Only when
   `M365_ENABLE_INTERACTIVE_APPROVAL=1`, and only after step 2 is unavailable or has
   actually failed. This is the path for tenants where no TOTP seed exists.

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

## Environment variables

| Variable | Description |
|---|---|
| `M365_DEBUG` | Set to `1` to enable debug logging to `~/.config/opencode-m365/debug.log` (truncated payloads) |
| `M365_LOG_FILE` | Debug log name, relative to `~/.config/opencode-m365/` (default `debug.log`; an absolute path is used as is). `M365_LOG_FILE=my/log.log` logs to `~/.config/opencode-m365/my/log.log`. |
| `M365_TRACE` | Set to `1` for full, untruncated debug logging (every WS frame/prompt/response) — implies `M365_DEBUG`. For reverse engineering. |
| `M365_LOG_STDOUT` | Set to `1` to mirror debug lines to the proxy's stdout as well as the log file, so you can watch a run without tailing it in a second terminal. Needs `M365_DEBUG` or `M365_TRACE` — on its own it logs nothing. |
| `M365_DUMP_FRAMES` | Set to `1` to write every WebSocket frame (both directions) to `~/.config/opencode-m365/frames/<requestId>.ndjson`. For offline diffing of new M365 fields. |
| `M365_FRAME_DIR` | Frame dump directory, relative to `~/.config/opencode-m365/` (default `frames`; an absolute path is used as is). `M365_FRAME_DIR=my/frames` dumps to `~/.config/opencode-m365/my/frames/`. |
| `M365_ALLOW_MULTI_TOOL` | Allow the model to emit multiple tool calls per turn (default: only the first is kept) |
| `M365_INJECT_REPLY_TOOL` | Set to `1` to inject a synthetic `reply(text)` tool. Forces every turn to be a tool call, including pure-prose answers. Cleaner contract for the model, +1 tool to the prompt (watch the Disengaged threshold). Confirmed 5/5 compliance on June 9 2026 ([hypotheses §1.1](docs/hypotheses.md)). |
| `M365_NO_CONFAB_RETRY` / `M365_CONFAB_RETRIES` | M365's chat model sometimes produces prose instead of a tool call when it should act — either confabulating an inability ("I can't access the files, please paste them") **or** claiming a completion it never did ("I've replaced the README", with no tool call). By default the proxy detects both and re-prompts forcefully **in the same conversation** (`M365_CONFAB_RETRIES`, default `1`) to force a real action. Set `M365_NO_CONFAB_RETRY=1` to disable. |
| `M365_NO_BACKOFF` (alias `M365_NO_AUTO_REAUTH`) | Set to `1` to disable degradation backoff. By default, when empty/throttled responses span several **distinct conversations** in a short window (the thread-rate-throttle signature, [F13](docs/hypotheses.md)), the proxy **paces subsequent turns** (a jittered delay before starting new backend conversations) to let the account self-heal. This replaced the old auto-reauth: a fresh login does **not** clear this throttle (it's `oid`-keyed — [§11 H-R1](docs/hypotheses.md)) and raised our detection profile. A single long pi thread never trips the trigger. |
| `M365_BACKOFF_THRESHOLD` / `M365_BACKOFF_WINDOW_MS` / `M365_BACKOFF_BASE_MS` / `M365_BACKOFF_MAX_MS` | Tune backoff: distinct-conversation empties to trigger (default `3`), the window they must fall in (default `120000`), the initial pacing window (default `90000`), and its escalation cap (default `600000`). |
| `M365_BROWSER_PROFILE` / `M365_LOGIN_UA` | Override the persistent browser-profile dir and the login User-Agent used for the (rare) automated interactive login. The persistent profile keeps AAD SSO/device cookies so repeat logins are silent and look like a familiar device ([§11 H-R3](docs/hypotheses.md)). |
| `M365_ENABLE_INTERACTIVE_APPROVAL` | Set to `1` to allow a **visible** browser window for sign-in when the automated login can't work or fails — the fallback for tenants with no TOTP option (push-only MFA, FIDO2, Okta/Ping/Duo). You complete SSO/MFA by hand once; tokens refresh silently afterwards. Off by default so headless hosts fail loudly rather than hang. See [If your tenant has no TOTP option](#if-your-tenant-has-no-totp-option). |
| `M365_NO_INTERACTIVE` | Set to `1` to hard-disable any visible browser login, overriding the flag above. For systemd/CI hosts where a window must never open. |
| `M365_INTERACTIVE_TIMEOUT_MS` | How long to wait for you to finish the interactive sign-in (default `600000`, i.e. 10 minutes). |
| `M365_LOGIN_LOCALE` / `M365_LOGIN_TIMEZONE` | Browser locale and timezone presented during login (defaults `en-GB` / `Europe/Copenhagen`). These are part of the anti-bot-scoring fingerprint ([§11 F25](docs/hypotheses.md)) — set them to match your own machine if AAD starts treating your automated login as a bot. |
| `M365_FORCE_AGENT` | Override which tool requests carry the Copilot Studio tool agent. `1` attaches it to every tool request (and turns off the GPT-6 Sol fallback below); `0` never attaches it. Unset, the proxy decides per model: GPT-5.x, `m365-copilot` and both Opus models take it, the other Claude models and `gpt-6-think-deeper` don't, and `gpt-6-sol` / `gpt-6.1-sol` take it only on a premium account, which the proxy learns from the first request. `claude-opus-4.5` carries it on tool-less requests too, since that's its only route (`0` turns that off as well). On a non-premium account `0` saves the probe turn (~3 s) per GPT-6 Sol model per proxy start. |
| `M365_OPUS_FALLBACK_MODEL` | Model to serve `claude-opus` (Opus 5.5) requests with once its priority-access budget is used up, instead of returning a 429 — typically `claude-opus-4.5`, which isn't metered (premium accounts only). Applies until the budget resets; the response's `model` field names the model that answered. Unset by default. |
| `M365_SONNET_FALLBACK_MODEL` | The same for `claude-sonnet-5.5` (Sonnet 5.5) once its priority-access budget is used up — e.g. `claude-sonnet-5` (unmetered) or `claude-sonnet` (Sonnet 4.6, any account). A fallback naming a metered model is ignored. Unset by default. |
| `M365_SCENARIO` / `M365_LICENSE_TYPE` | Override the entitlement the WebSocket is opened under (defaults: `OfficeWebIncludedCopilot` / `Starter`, switching to `OfficeWebPaidCopilot` / `Premium` for the entitlement-gated models — `claude-opus`, `gpt-6-think-deeper`, `claude-sonnet-5` and `claude-sonnet-5.5`; `claude-opus-4.5` and `gpt-6.1-sol` stay on the included one). `scenario` is what gates the model list (and picks Sonnet 4.6 vs 5.5 for the `Claude_Sonnet` tone, Sonnet 4.6 vs 5 for `Claude_Sonnet_5`, Opus 4.5 vs 5.5 for `Claude_Opus`); `licenseType` rides along and unlocks nothing by itself. Forcing the paid scenario on `gpt-6.1-sol` spends its separate GPT-6.1 Sol allowance (40 turns a day, 75 a week), which the proxy doesn't track. |
| `M365_CACHE_FILE` | Override MSAL token cache location |
| `M365_SECRETS_FILE` | Override credentials file location |
| `CHROMIUM_PATH` | Path to Chromium binary for automated login |

### Usage / context-window % in responses

The OpenAI `usage` block in every chat completion response now includes M365
extension fields with the **per-conversation message quota** — the closest
proxy we have to "context-window utilisation" since M365 hides token counts:

```json
"usage": {
  "prompt_tokens": 0,
  "completion_tokens": 0,
  "total_tokens": 0,
  "x_m365_conversation_messages": 42,
  "x_m365_conversation_max": 600,
  "x_m365_conversation_pct": 7,
  "x_m365_conversation_remaining": 558,
  "x_m365_content_origin": "DeepLeo",
  "x_m365_message_type": null,
  "x_m365_turn_count": 3,
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
- `claude-opus` needs a paid/premium seat and has its own small priority-access quota (40 turns a day, 75 a week; every tool call is a turn) that resets at midnight UTC (weekly on Monday); exhaustion surfaces as a 429, or as a switch to `M365_OPUS_FALLBACK_MODEL`. `claude-opus-4.5` needs a premium account too, but has no such quota
- `claude-sonnet-5.5` needs a paid/premium seat and has a priority-access quota of its own (80 turns a day, 150 a week), handled the same way (`M365_SONNET_FALLBACK_MODEL`). `claude-sonnet-5` needs the seat but has no quota
- Streaming: **tool-less** responses stream incrementally (deltas forwarded as they arrive). **Tool-calling** turns are still buffered server-side — the raw text has to be parsed for tool-call fences before it can be emitted — so those arrive as a single chunk at the end (with an immediate HTTP 200 + heartbeats so the client never times out waiting)

## License

[MIT](LICENSE). Use at your own risk — this speaks to Microsoft's API with your own
credentials, on your own account, and that's between you and your tenant's
acceptable-use policy.
