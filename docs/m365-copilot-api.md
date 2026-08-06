# The M365 Copilot API — field notes from reverse engineering

Microsoft 365 Copilot (the "BizChat" / "Office web" Copilot, **not** the public
Azure OpenAI API) has no documented developer API. It is a **SignalR-over-WebSocket**
service intended to be driven only by Microsoft's own first-party web/desktop clients.
This document records everything we learned wiring it up as an OpenAI-compatible
backend, so the next person (or agent) doesn't have to rediscover it.

Everything here is observed behaviour as of **June 2026**, against the
`substrate.office.com` Sydney backend. Microsoft can change any of it without notice.

> Source of truth in this repo: `packages/core/src/{auth,copilot,session,agent,schemas}.ts`.

---

## 0. TL;DR — the weird parts

If you read nothing else:

1. It's **SignalR over WebSocket** to `wss://substrate.office.com/m365Copilot/Chathub/{oid}@{tid}`, framed with `0x1E` record separators. **Not** HTTP, not OpenAI.
2. The **access token goes in the WebSocket URL query string** (`access_token=...`), not a header.
3. **Node's native `fetch`/`WebSocket` do not work** — you must use the `ws` npm package and send a real browser `Origin` + `User-Agent`, or the server refuses.
4. A **`Metrics` frame must be sent in the same WS payload** as the chat message, or the turn never starts.
5. The **model is selected by a `tone` string** (`magic`, `Gpt_5_4_Reasoning`, …), not a model ID.
6. Auth uses **MSAL PKCE with the `nativeclient` redirect**, which a real browser bounces to `/common/wrongplace` — you must scrape the auth code from the *navigation request*, not wait for the redirect to land.
7. **Tool calling is not native.** It only works reliably if you create a **Copilot Studio agent** and reference it per request; otherwise M365 ignores tool instructions and answers in prose / hallucinates.
8. M365 has a **"Disengaged" safety filter**: large or jailbreak-looking prompts get a `messageType:"Disengaged"` message with **empty content** — which is easy to mistake for rate limiting.

---

## 1. The endpoint

```
wss://substrate.office.com/m365Copilot/Chathub/{oid}@{tid}?{query}
```

- `{oid}` and `{tid}` are the **object id** and **tenant id** from the JWT (`oid`/`tid` claims). Decode the token to get them — see `decodeJwt()` in `copilot.ts`.
- The query string carries session identifiers, feature flags, **and the access token**:

| Param | Value / notes |
|---|---|
| `access_token` | The full Sydney JWT (see §2). Yes, in the URL. |
| `ConversationId` | A UUID you generate; reused across turns to keep server-side context. |
| `chatsessionid` / `clientrequestid` / `X-SessionId` | UUIDs (per-request and per-session). |
| `source` | `"officeweb"` (note: the literal value is double-quoted in the original client). |
| `product` | `Office` |
| `agentHost` | `Bizchat.FullScreen` |
| `scenario` | `OfficeWebIncludedCopilot` |
| `variants` | A long comma-separated list of feature flags (see `VARIANTS` in `copilot.ts`). Most are cargo-culted from a captured session; removing them is untested. |

---

## 2. Authentication

### Client and scopes
- **Client ID:** `c0ab8ce9-e9a0-42e7-b064-33d422df41f1` (a Microsoft first-party app id — *we did not register this*; it's the Office web Copilot client).
- **Authority:** `https://login.microsoftonline.com/common`
- **Redirect URI:** `https://login.microsoftonline.com/common/oauth2/nativeclient`
- **Chat scopes:**
  - `https://substrate.office.com/sydney/M365Chat.Read`
  - `https://substrate.office.com/sydney/sydney.readwrite`
- The resulting token has **audience `https://substrate.office.com/sydney`** and is ~3500 chars.
- **Agent management needs two more scopes** (separate silent/interactive acquisitions):
  - `https://api.powerplatform.com/.default` (Copilot Studio)
  - `https://api.bap.microsoft.com/.default` (environment discovery)

### Flow: MSAL PKCE
We use `@azure/msal-node` `PublicClientApplication` with PKCE. The token cache is persisted to `~/.config/opencode-m365/msal-cache.json` and refreshed silently when possible.

> **The cache is disposable (tested June 2026, `scripts/token-regen-probe.mjs`).** Delete `msal-cache.json` and the next `getToken()` self-heals: silent fails → automated browser login (stored creds + TOTP) → a fresh, working token in **~12s**, no human in the loop. The regenerated token is **functionally identical** — same `aud`/`appid`/`tid`/`oid`/scopes, only `iat`/`exp`/`uti` change. Point auth at a throwaway cache with `M365_CACHE_FILE` to test this without touching the real one.
>
> **Re-auth does NOT clear account throttling** — the fresh token carries the same `oid`, so it lands in the same account-keyed throttle bucket. Throttling is identity-level, not token-level.
>
> **Observed token scopes** (the Sydney token already carries these): `CopilotPlatform{Content.Process,Files.ReadWrite(All),Mail.Read(.Shared),Presence.Read(.All),Sites.Read.All,Teams.ReadWrite.All,User.Read,License...,ProtectionScopes...,DataLossPrevention...}` + `M365Chat.Read` + `sydney.readwrite`. So the auth we hold already has the entitlements behind Files/Mail/Sites/Teams/Presence — the foundation for any Graph "Work" grounding (hypotheses §8 H8.11).

### The `nativeclient` redirect gotcha (this one cost hours)
The `nativeclient` redirect URI is designed to be **intercepted by an embedded native host** (WebView2 etc.) *before the page loads*. A real browser instead follows the redirect one hop further and lands on **`https://login.microsoftonline.com/common/wrongplace`** ("This is not the right page"). So:

- `page.waitForURL("**/oauth2/nativeclient**")` **misses** the auth code — the `?code=` URL exists only transiently before the bounce.
- **Fix:** attach a `page.on("request")` listener and pull `code` out of the *navigation request* to `…/oauth2/nativeclient?code=…`. See `runBrowserLogin()` in `auth.ts`.

### Automated login quirks (Playwright)
- The converged AAD login page keeps **hidden duplicate `<input type=password>` nodes**; a naive `fill()` can target a stale hidden one and submit an empty password. Fill the **visible** `name=`-selected field and verify the value landed (`fillVerified()`).
- Field selectors: email `input[name="loginfmt"]`, password `input[name="passwd"]`, TOTP `input[name="otc"]`.
- On NixOS, Playwright's bundled `chrome-headless-shell` fails (`libglib-2.0.so.0`); point it at a system Chromium via `CHROMIUM_PATH` (`resolveChromiumPath()`).
- TOTP codes are single-use per 30s window — space retries past the window.

---

## 3. Transport: SignalR over WebSocket

### Required headers
The `ws` client must send browser-like headers or the upgrade is rejected:
```
Origin: https://m365.cloud.microsoft
User-Agent: Mozilla/5.0 (… Firefox/148.0)
```
Node's built-in `WebSocket` doesn't let you set these the same way and **does not work** — use the `ws` npm package.

### Framing
SignalR JSON protocol. **Every frame is terminated by a `0x1E` (RS, record separator) byte.** A single WS message can contain multiple `0x1E`-separated frames; split on `0x1E` and parse each non-empty chunk.

### Handshake
On open, send:
```
{"protocol":"json","version":1}\x1E
```
The server replies with `{}` (empty handshake-OK) — sometimes as an empty object, sometimes the first parse just succeeds. After that, send the chat turn.

### Frame types (the `type` field)
| `type` | Meaning |
|---|---|
| `1` | **Invocation / update.** Server→client streaming updates use `target:"update"`. Client→server `Metrics` also uses type 1. |
| `2` | **Stream item** — emitted at the end with the final conversation item; we treat it as "close". |
| `3` | **Completion** — has an optional `error`. |
| `4` | **Invocation (no-result)** — this is what we **send** for the chat turn (`target:"chat"`). |
| `6` | **Ping** — reply with `{"type":6}\x1E` to keep alive. |
| `7` | **Close** — optional `error`. |

See `handleMsg()` in `session.ts` for the dispatch.

---

## 4. Sending a chat turn

You send **two frames in one `ws.send()`**: the chat invocation **and** a `Metrics` frame. Omitting the Metrics frame causes the turn to silently never produce output.

```
<chat invocation JSON>\x1E<metrics JSON>\x1E
```

### The chat invocation (`type: 4`, `target: "chat"`, `invocationId: "0"`)
Key fields inside `arguments[0]` (full shape in `session.ts::sendChat`):

| Field | Notes |
|---|---|
| `message.text` | The actual prompt string. |
| `message.author` | `"user"` |
| `tone` | **Selects the model** — see §5. |
| `source` | `"officeweb"` |
| `streamingMode` | `"ConciseWithPadding"` |
| `isStartOfSession` | `true` on the first turn of a conversation, `false` after. |
| `allowedMessageTypes` | A long allow-list (`Chat`, `Suggestion`, `Progress`, `EndOfRequest`, …). |
| `clientInfo` | `clientPlatform:"mcmcopilot-web"`, `clientAppName:"Office"`, etc. |
| `plugins` | `[{Id:"BingWebSearch",Source:"BuiltIn"}]` **when no agent**. |
| `threadLevelGptId` / `gpts` | Set **instead of** `plugins` when using a Copilot Studio agent (see §10). |
| `locationInfo` / `locale` | The original client sends a real timezone/locale; values seem cosmetic. |

`invocationId` is always `"0"` even across reconnects — each turn is a fresh WebSocket.

### The mandatory Metrics frame (`type: 1`, `target: "Metrics"`)
```json
{
  "arguments": [{ "Timestamps": {
    "ConnectionStart": "<iso>", "UserInputStart": "<iso>",
    "ConnectionEstablished": "<iso>", "UserInputSubmit": "<iso>"
  }}],
  "target": "Metrics",
  "type": 1
}
```
The timestamp values appear cosmetic, but the frame's **presence is required**.

---

## 5. Models are selected by `tone`, not model id

There is no `model` parameter. The `tone` string on the chat message picks the model/mode:

| Our model id | `tone` | Notes |
|---|---|---|
| `m365-copilot` / `auto` | `magic` (auto-routing) | default; routes GPT-5 class |
| `quick` | `Gpt_Quick` | |
| `think-deeper` | `Gpt_Reasoning` | |
| `claude` / `claude-sonnet` | `Claude_Sonnet` | **real Anthropic Claude Sonnet 4.5** (self-identifies) |
| `claude-sonnet-think-deeper` | `Claude_Sonnet_Reasoning` | Claude Sonnet 4.5 + reasoning |
| `claude-opus` | `Claude_Opus` | accepted tone; identity deflected (likely Opus) |
| `gpt-5.5` / `gpt-5.5-quick` | `Gpt_5_5_Chat` | current GPT generation |
| `gpt-5.5-think-deeper` | `Gpt_5_5_Reasoning` | |
| `gpt-5.6-think-deeper` | `Gpt_5_6_Reasoning` | confirmed live 2026-08-06; GPT-5.6 Think deeper |
| `gpt-5.4` / `gpt-5.4-think-deeper` | `Gpt_5_4_Reasoning` | |
| `gpt-5.4-quick` | `Gpt_5_4_Quick` | |
| `gpt-5.3` / `gpt-5.3-quick` | `Gpt_5_3_Quick` | |
| `gpt-5.3-think-deeper` | `Gpt_5_3_Reasoning` | |
| `gpt-5.2` / `gpt-5.2-quick` | `Gpt_5_2_Quick` | |
| `gpt-5.2-think-deeper` | `Gpt_5_2_Reasoning` | |

Mapping lives in `MODEL_TONES` (`copilot.ts`). `*_Reasoning` tones take 10–30s.

**The server validates `tone`.** An unknown tone returns a `type:3` completion error (`Failed to invoke 'Chat'`), so an accepted tone is a real, registered route — that's how the Claude/GPT-5.5/GPT-5.6 tones above were confirmed. Rejected on test: `Anthropic_Claude`, `Claude_Haiku`, `Claude_3_7_Sonnet`, `Gpt_5_6_Chat` (June 2026, before the GPT-5.6 rollout). Accepted-but-NOT-Claude: `Claude_Reasoning` (self-IDs as GPT-5 — don't use). New tones still appear by pattern (`Gpt_5_N_{Quick,Reasoning}`, `Claude_*`).

> ⚠️ **The declarative agent overrides the tone and forces GPT-5.** This is the big one (June 2026, `scripts/tone-probe.mjs`): with **no agent**, `Claude_Sonnet` → real Claude; with the agent attached (`threadLevelGptId`, §10) the *same* tone silently routes to **GPT-5**. So a non-default tone (Claude, and the `*_Reasoning` tones) only takes effect on the **agent-less / plain-chat** path. With a heavy tool prompt a Claude tone + agent goes further and **Disengages persistently** (the `DeepLeo` reasoning pipeline meta-analyses the injected prompt instead of obeying it). Ruled out as causes: prompt wrapper, the `variants` flag list, conversation reuse — isolated cleanly to agent presence.
>
> **Consequence:** Claude (and other non-default tones) are usable for plain chat but **not** for tool calling via our emulation agent — tool requests get GPT regardless. The proxy therefore attaches the agent **only when the request carries tools** (`ModelSession.run(..., useAgent=hasTools)`), so plain chat reaches the model the tone selects. Getting Claude-grade *tool* use needs the native-action / MCP path (no declarative agent) — see `docs/hypotheses.md` §8.

### Code interpreter — a real server-side Python sandbox

Enabling these `optionsSets` on the chat turn unlocks M365's actual Python execution environment (the engine behind the "Analyst" experience):

```
cwc_code_interpreter, cwc_code_interpreter_amsfix, cwc_code_interpreter_citation_fix,
code_interpreter_interactive_charts, code_interpreter_matplotlib_patching
```

…plus `GeneratedCode` (and `GenerateContentQuery`) in `allowedMessageTypes`. The model then **writes and runs real Python** and returns true results — verified with a SHA-256 oracle (a correct digest of a unique string is impossible to fake from memory; M365 emitted a `GeneratedCode` frame running `hashlib.sha256(...).hexdigest()` and returned the correct hash). `contentOrigin: DeepLeo`.

The proxy enables this on the **agent-less path** (so plain chat can compute; the tool/agent path is left alone so it doesn't compete with tool-JSON emission). `CODE_INTERPRETER_OPTIONS_SETS` in `session.ts`; disable with `M365_NO_CODE_INTERPRETER=1`. Note it's M365's sandbox, not the harness's — useful for accuracy (hashing, math, parsing, data transforms), not a substitute for the harness's own tools.

> The `optionsSets` array was previously sent **empty**. Live reference implementations (`kuchris/m365-copilot-openai-proxy`, Microsoft's own `PyRIT`) populate it richly — code interpreter, memory, custom-instructions, image input. See `docs/hypotheses.md` §8 for the full catalogue of flags still on the table.

---

## 6. Receiving a response

Streaming arrives as **`type:1`, `target:"update"`** frames whose `arguments[]` contain one of:

### a) Delta update (incremental text)
```json
{ "writeAtCursor": "partial text", "streamingMode": "Delta" }
```
Concatenate `writeAtCursor` across deltas → the streamed answer.

### b) Message update (full snapshot)
```json
{ "messages": [{ "author": "bot", "text": "full text so far", ... }] }
```
**Only treat a bot message as content when `messageType` is absent.** Messages *with* a `messageType` are control/meta (see below). We keep whichever of (delta-accumulated) vs (message snapshot) text is longer.

The final-state bot message (in either the last update frame or the `type:2` stream item) also carries:

| Field | What it is | Useful for |
|---|---|---|
| `scores: [{ component, score }]` | Per-message classifier scores. Known components: `BotOffense`, `dea_violation`. Values are tiny floats; `dea_violation` correlates with Disengaged firing. | Surface as `usage.x_m365_dea_score`. Lets clients back off before tripping the filter (empirically: clean tool calls ~1e-8, prose ~1e-6, jailbreak-framed ~1e-3, Disengaged > some threshold above 2e-3). |
| `offense` | `Unknown` / `None` / etc. | Coarser version of the score signal. |
| `turnCount` | Authoritative server-side turn count for this conversation. | Cross-check against our local counter. |
| `turnState` | `Completed` (only value observed). | Explicit "this turn is done" signal. |
| `contentOrigin` | `DeepLeo` (reasoning pipeline) / `officeweb` (user echo) / etc. | Tells which back-end answered without parsing text. |
| `gptIdentifiers[].compliantAgentName` | `3PDeclarativeAgent` when our Copilot Studio agent handled it. | Confirms the agent attachment took. |

### c) Throttling update
```json
{ "throttling": {
  "numUserMessagesInConversation": 3,
  "maxNumUserMessagesInConversation": 600,
  "numLongDocSummaryUserMessagesInConversation": 0
}}
```
See §7.

### Control messageTypes you'll see
`Disengaged` (see §9), `ReferencesListComplete`, `Progress`, `InternalSearchQuery`, `RenderCardRequest`, `EndOfRequest`, … — none of these carry the answer text.

### End of turn
A `type:2` (stream item), `type:3` (completion), or `type:7` (close) ends the turn; we close the socket. Reply to `type:6` pings in the meantime.

### Cancelling a turn (the "Stop generating" button)
Captured from the real `m365.cloud.microsoft` client (June 2026, `scripts/cancel-frame-capture.mjs`): clicking **Stop generating** sends a single frame **on the same socket**, then the client closes it:
```
{"arguments":[{}],"invocationId":"1","target":"stop","type":1}\x1E
```
Notes:
- It's a normal **`type:1` invocation** with `target:"stop"` and **`invocationId:"1"`** (distinct from the chat invocation's `"0"`) — *not* a SignalR `CancelInvocation` (type 5) and *not* a bare socket close.
- The server **acks with a `type:3` completion** (no error) and replaces the in-progress bot message with the canned text **"You have stopped this conversation."** — the partial answer is discarded.
- **The cancelled user message still counts** against the 600-msg/conv quota, but its **context persists** server-side (a secret planted in a cancelled turn is recallable next turn). See `docs/hypotheses.md` F11.
- **Implemented (June 2026):** the proxy now propagates an HTTP-client disconnect as an `AbortSignal` (`completions.post.ts` → `handler` → `model.ts` → `session.ts`); on abort it sends this Stop frame and closes (`STOP_FRAME` in `session.ts`). Before this, every turn ran to a terminator before `ws.close()` and a caller's abort orphaned the generation.

### `type:2` stream item — the conversation summary

The final `type:2` frame carries the canonical state of the whole conversation in `item`:

| Field | Notes |
|---|---|
| `messages` | All messages (user + bot, with the final scores attached). |
| `throttling` | Authoritative quota state. |
| `result.{value, message, serviceVersion}` | `value: "Success"` + `message:` the final bot text + the M365 service build (e.g. `1.0.03443.34112`). |
| `turnState` | `Completed`. |
| `conversationExpiryTime` | ~30 days out — the conversation itself has a hard expiry. |
| `conversationTransferToken` | Base64. Decodes to `{"type":"FullConversation","conversationId":"..."}`. Mechanism unclear — possibly a handle for migrating a conversation across sessions/hosts; not yet investigated. |
| `firstNewMessageIndex` | Which message is "new" since the previous turn — could power smarter delta sends. |
| `telemetry.startTime`, `telemetry.userMessageRequestStartTime` | The latter is always null in our captures; might require a feature-flag flip. |

---

## 7. Throttling & quotas

- **600 user messages per conversation** (`maxNumUserMessagesInConversation`). This is the hard cap; it is **per `ConversationId`**, not per day.
- This is why we **reuse one conversation** across an agent session and send **only new messages** on follow-up turns (delta mode) — every `Please continue.` retry also counts against the 600.
- There is also opaque **account-level throttling** (rapid-fire requests can start returning empties). It recovers on its own.

### Account degradation under sustained use (observed June 13 2026)

A full session of heavy use (~80+ messages across probes, bench runs, and logins
in a few hours) drives the account into a **degraded state** that is distinct from
the per-conversation 600 cap (which we never approached — every probe used a fresh
conversation at `1/600`). Characterised behaviour:

- **Onset:** progressive. Early in the session responses were clean; after
  sustained activity, turns increasingly return **`Disengaged` (→ proxy 502) or
  empty replies**, even for benign single-tool prompts and fresh conversations.
- **Signature:** in the benchmark, *work-requiring* tasks (`edit-config`,
  `find-needle` — must read a real file) **Disengaged on every run** once degraded,
  while trivial/ fakeable tasks still returned (prose). So degradation manifests as
  the Disengaged filter firing far more readily, not as an explicit rate-limit error.
- **Recovery:** self-heals with a lull (a clean `pong` returned after a ~15-min
  idle gap mid-session). No action needed; just wait.
- **NOT token-related:** regenerating the MSAL token does **not** clear it — the
  fresh token carries the same `oid`, so it lands in the same identity-keyed bucket
  (see §2, `scripts/token-regen-probe.mjs`). Re-auth is not a recovery lever.
- **NOT the 600 cap:** the per-conversation counter stays low; this is an
  account/identity-level governor.

**Operational implications.**
- Treat a sudden rise in `Disengaged`/empty across *fresh* conversations as
  degradation, not as a content/format problem — **back off and wait**, don't retry
  (retrying burns quota and re-disengages; the proxy now fails fast on Disengaged).
- **It confounds experiments.** A/B results gathered while degraded are unreliable
  (a `Disengaged` can be misread as a format/prompt failure). Run comparative
  experiments (bench A/Bs) on a **rested account**, and pace requests.
- The exact trigger (cumulative volume vs requests-per-minute vs a sliding window)
  is **unquantified** — characterise it with the throttle experiment
  (`docs/experiments.md` E-T1 / `scripts/throttle-probe.mjs`; hypotheses §8 H8.20).

---

## 8. Conversations & sessions

- A "conversation" = a stable `ConversationId` (+ `X-SessionId`). M365 keeps **server-side context** for it.
- Each **turn opens a fresh WebSocket** (with `invocationId:"0"`), but reuses the same `ConversationId`/`sessionId`, so the server threads them together. `isStartOfSession:true` only on turn 0.
- Because the server remembers prior turns, follow-ups should send **only the new messages** (the delta), not the whole history. Re-sending the full history confuses it and burns quota. See `ModelSession`/`CopilotSession` and `SessionPool` (`handler.ts`).

---

## 9. The "Disengaged" filter

The single biggest gotcha for agentic use.

When M365 dislikes a prompt — **looks like a jailbreak / prompt injection**, or carries a heavy tool block — it returns a bot message:

> **Update (June 2026, F10):** *raw size alone does not trigger Disengaged.* 2M chars (~500k tokens) of benign filler never disengaged and never raised `dea_violation`. The trigger is **shape** (jailbreak framing, large *tool-block* count), not byte count. Read the "too large" lore below as "too large **and** tool-block-shaped." See `docs/hypotheses.md` F9/F10.

```json
{ "author": "bot", "messageType": "Disengaged",
  "hiddenText": "> Conversation disengaged", "offense": "None" }
```
…and **no answer text**. `offense` is usually `"None"`, so it's not a content-policy block per se — it's a "I'm not going to engage with this" refusal.

**Why it bites agents:** the response has empty content, which is indistinguishable from rate-limiting unless you specifically look for `messageType:"Disengaged"`. Our handler historically retried it as a rate limit (`Please continue.`), which just disengaged again and burned the 600 quota.

**What triggers it (observed):**
- Large injected tool blocks. Empirically: ~1 tool is fine; **~12 tools is borderline** (disengages once, recovers on retry); a full coding-agent toolset (~15+, e.g. opencode's) disengages **persistently**.
- Aggressive, jailbreak-shaped instructions: fake `<system>`/`<user>`/`<assistant>` turns, "output ONLY JSON", "STRICT RULES", "never describe your intent". These read as manipulation.

**Mitigations:**
- Keep the **toolset lean** (a handful of tools). Lean harnesses like [pi](https://pi.dev/) stay under the threshold; heavy ones trip it.
- Prefer a **Copilot Studio agent** (§10) whose tool-calling instructions live server-side, so the per-request prompt can be gentle instead of a wall of rules.
- Detect `Disengaged` explicitly and surface it rather than retrying blindly.

---

## 10. Tool calling & Copilot Studio agents

M365 Copilot has **no native `tool_calls`**. We emulate it:

1. Inject tool definitions into the prompt as compact text.
2. Instruct the model to emit a JSON object `{"tool":"name","arguments":{…}}` (a fenced ```` ```json ```` block is fine — `parseToolCalls()` strips the fence).
3. Parse that back into OpenAI `tool_calls`. A synthetic `reply` tool lets the model return plain text in the same channel.

**The catch:** with prompt-injection alone, M365 **ignores the instructions and answers in prose, or hallucinates tool *results*.** The thing that actually makes it comply is a **server-side system prompt**, delivered via a **Copilot Studio agent**.

> Empirically, the JSON *format* (bare vs ```` ```json ```` vs ```` ```tool_call ````) barely matters — all ~3/3 compliant **with the agent on**. The agent is the lever, not the syntax.

### Model behaviour under tool calling (measurement traps)
Two behaviours of the chat-tuned model distort any naïve "is it tool-calling yet?" read:

- **It hallucinates success on *fakeable* tasks.** Asked to do something it can answer from
  its own knowledge (write fizzbuzz, count lines), the model emits a confident *"created and
  ran it"* prose claim with **zero tool calls** — it "knows" the answer, so it shortcuts the
  loop. It only reliably calls a tool when the task is **unfakeable** — when proceeding
  *requires* real file/command state it cannot guess (fix a bug it must read first, find a
  value in a file, edit an exact config). So a compliance scoreboard built on fakeable tasks
  flatters the model; weight the unfakeable ones (`needsTool` in `scripts/bench/tasks.mjs`).
  This is the §9 F-series "create-from-scratch still fakes it" gap.
- **The harness's own system prompt changes compliance.** The same model is *more* compliant
  under the bench's short, blunt system prompt than under pi's longer, polished assistant
  prompt — a strategy can score well on the bench and still confabulate turn-1 ("I can't
  access the files, please paste them") under real pi (§9 F14). Consequence: the bench picks
  the *direction*, but a win isn't real until a live **pi/openclaw** run confirms the model
  actually drives the loop end-to-end.

### Creating the agent (`agent.ts`)
1. **Discover the environment** via the BAP API:
   `GET https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform/environments/~default?api-version=2023-06-01`
   → `name` like `Default-<tenantGuid>`.
2. **Build the Power Platform host.** The subdomain is `default<envId>.df.environment.api.powerplatform.com` where `envId` is the tenant GUID with dashes stripped. **DNS quirk:** the full-length label often doesn't resolve; the working host has the **last 2 characters trimmed**. We probe candidates and use the first that resolves (`getEnvironmentUrl()`).
3. **Create a bot** via the Copilot Studio `minimalBots` API (`…/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`), with the tool-calling instructions as the GPT component's `instructions` text.
4. **Publish** it → returns a `TitleId`.
5. The usable **agent id** is `T_{titleId}.{botId}.gpt.default`, cached in `~/.config/opencode-m365/agent-id.json`.

### Referencing the agent in a chat turn
Instead of `plugins`, set on the chat message:
```json
"threadLevelGptId": { "id": "<agentId>", "source": "MOS3" },
"gpts": [{ "id": "<agentId>", "source": "MOS3", "version": "1.0.0",
           "clientOverrides": { "capabilities": [], "deepResearchModels@odata.type": "Collection(String)" } }]
```

### Versioning the agent by instructions hash
The agent's instructions are **baked in at create time** and can't be cheaply updated in place (the update API needs a `changeToken` only returned by *create*; `updateBotInstructions()` is dead code). So instead of editing in place, the agent is **versioned by name**:

- Name = `m365-tool-agent-<hash>`, where `<hash>` = first 8 hex of `sha256(getAgentInstructions())`.
- `getOrCreateAgent()` computes the wanted name, looks for it via `listBots`, and **creates a fresh agent** if absent (instructions are baked into `createBot`). The local cache (`agent-id.json`) stores `instructionsHash`; a mismatch forces a rebuild.
- Stale `m365-tool-agent-*` bots are **never deleted** — we removed the cleanup pass entirely (multi-host safety, see below). A few orphaned lightweight bots per instruction change are harmless.
- Hosts sharing a tenant compute the **same name for the same instructions**, so they converge on one agent with no coordination.
- **Empirically verified:** Copilot Studio reflects the `displayName` we set → `shortBotName` **byte-for-byte** (hyphens, length, case all preserved), which is what makes name-based lookup reliable.

> ✅ Multi-host footgun (resolved by design): editing the instructions changes the hash, so a host on the new build creates a new agent — but it **never deletes the old one**, so hosts still running the old build keep working. (This is *why* there's no cleanup: the previous deletion pass would pull an in-use agent out from under another host mid-conversation.)

> ⚠️ **The deleted-agent trap (observed live, June 2026; now largely moot).** This was *caused* by the cleanup pass, which has since been **removed** — agents are never auto-deleted, so this trap can now only occur if a bot is deleted manually. Kept for diagnostics. A long-lived host (e.g. the systemd service) resolves its agent **once** at first request and keeps the id in memory for the whole process lifetime — `ModelSession.cachedAgentId` is only set when `=== undefined`, and `reset()` does **not** clear it. So a host **cannot self-heal**: once its agent is deleted from the tenant, every subsequent request keeps sending `threadLevelGptId` pointing at a **bot that no longer exists**, and M365 returns an **instant empty reply** (`hasContent=false`, `throttle=null`, ~0.7 s). Symptoms: plain chat hangs (old builds retried empties forever; see quirk #16), tool chat reports a bogus **"rate limited"**. Meanwhile the browser UI works fine because its session is independent of this agent/token state, and `getToken()` is healthy — which makes it look like a token/throttle problem when it is neither.
>
> **How to tell it apart:** an empty reply with `throttle: null` returning in well under a second is a dead/invalid agent, **not** throttling (real throttling carries `throttle.current >= throttle.max`). Confirm by listing tenant bots (`scripts/listbots-probe.mjs`) and checking the host's `agent-id.json` `botId` is still present.
>
> **Immediate fix:** restart the host (`systemctl restart m365-copilot-proxy`) — it re-resolves/recreates the agent at startup. **Avoid recurrence:** now automatic — agents are never auto-deleted, so an agent only disappears if someone deletes it by hand. **Durable code fix:** clear `cachedAgentId` on an empty reply (and in `reset()`) so the next `run()` re-resolves the agent and the host recovers without a restart.

### Agent types: declarative (`minimalBots`) vs Studio/Dataverse — and why you can't bind a model
A natural idea is "give each model its own agent with the right system prompt." **You can't, with our agent type.** Reverse-engineering the real Copilot Studio UI (drive it with Playwright, capture its network — see `scripts/studio-dig.mjs`) shows there are **two different species of agent**:

| | **Declarative agent (ours)** | **Studio / PVA bot** |
|---|---|---|
| Created via | `copilotstudio/minimalBots/api` | Dataverse + `powervirtualagents/bots/<id>/api/botcomponents` |
| Stored in | M365/MOS3 declarative-agent layer | **Dataverse** (`<org>.crm4.dynamics.com/api/data/v9.2/bots`) |
| Plugs into BizChat | ✅ (this is the whole point) | ❓ (untested) |
| Has a **model field** | ❌ none (only `aISettings.useModelKnowledge` + `gptCapabilities`) | likely (the Studio "model picker" targets these) |
| Shows in `bots` Dataverse table | ❌ (table is **empty** for us) | ✅ |

Evidence (`scripts/dataverse-bot-probe.mjs`, with a `<org>.crm4.dynamics.com/.default` token):
- `GET bots(<ourBotId>)` → **404, "Entity 'bot' Does Not Exist"**.
- Listing **all** Dataverse `bots` → **0 rows**. Our `minimalBots` agents simply aren't Dataverse bots.
- Copilot Studio *does* ship an agent-model feature — its ECS config (`ecs.office.com/config/v1/CopilotStudio`) exposes `displayModelPicker=true`, `AgentModelSelectionV2`, `isReasoningCardEnabled=true`, even `cuaAnthropicModels` with `modelHint: "sonnet4-6"/"opus4-6"`. But that picker operates on **full Studio/Dataverse bots**, which we neither have nor create.
- `msdyn_aimodels` exists but is **AI Builder** (invoice/receipt/sentiment/OCR models), unrelated to the Copilot chat LLM.

**Conclusion:** our declarative agent has **no model knob**. The model is *only* the BizChat chat-layer `tone` (§5). Pairing our declarative agent with a non-default **reasoning** tone is an **unsupported combination** — the reasoning pipeline (`contentOrigin: "DeepLeo"`) meta-reasons over the injected prompt instead of obeying it (it will literally critique your few-shot, echo the `{"tool":"<tool_name>"}` template verbatim, and reason itself *out* of using tools). The agent is still attached (`threadLevelGptId` rides along, response is tagged `3PDeclarativeAgent`) — it just loses its grip under a reasoning tone.

**Open frontier:** create a *full* Studio/Dataverse PVA bot (which *can* bind a model) and test whether it's reachable over the same BizChat WS. Different APIs (Dataverse write + PVA `botcomponents` + a different publish path) and unknown BizChat compatibility — filed as the next experiment, not yet done.

---

## 11. Quirks cheat-sheet

| # | Gotcha | Where |
|---|---|---|
| 1 | Token goes in the **WS URL query**, not a header | `copilot.ts`/`session.ts` |
| 2 | Node native `fetch`/`WebSocket` fail; use `ws` + browser `Origin`/`User-Agent` | `session.ts` |
| 3 | Frames terminated by `0x1E` (RS); multiple per WS message | everywhere |
| 4 | **Metrics frame required** in the same send as the chat frame | `sendChat()` |
| 5 | Model chosen by `tone` string, not model id | `MODEL_TONES` |
| 6 | `nativeclient` redirect bounces to `/common/wrongplace`; scrape `code` from the request | `runBrowserLogin()` |
| 7 | Hidden duplicate password inputs on the AAD page | `fillVerified()` |
| 8 | `Disengaged` returns empty content (≠ rate limit) | §9 |
| 9 | Tool calling needs a Copilot Studio agent | §10 |
| 10 | Power Platform env host needs last-2-chars trimmed to resolve DNS | `getEnvironmentUrl()` |
| 11 | 600 messages **per conversation**; reuse + delta to conserve | §7/§8 |
| 12 | Only bot messages **without** `messageType` are real content | `handleMsg()` |
| 13 | **Reasoning tones** (`*_Reasoning`/`DeepLeo`) meta-analyze the prompt and disengage; only `magic` + `*_Quick` work with the agent | §5/§10 |
| 14 | Our `minimalBots` agents are **not** Dataverse bots (that table is empty) and have **no model field** — can't bind a model | §10 |
| 15 | Agent is **versioned by name** (`m365-tool-agent-<sha256-prefix>`); editing instructions auto-provisions a new one + cleans up old | §10 |
| 16 | Empty reply ≠ rate limit unless throttle is at-limit; otherwise fail fast (don't burn 60s of retries) | `handler.ts` |
| 17 | M365 invents `{"confidence":N}` / `{"final":"…"}` JSON and batches calls + premature `✅ SUCCESS`; proxy strips them + enforces one call/turn | `tools.ts`/`handler.ts` |
| 18 | **Deleted-agent trap:** a long-lived host caches its agent id for life (`reset()` won't clear it) and can't self-heal when its bot is cleaned up; dead agent → instant empty reply (`throttle:null`, ~0.7s) misread as "rate limited". Restart, or clear `cachedAgentId` on empty | `model.ts`/§10 |
| 19 | **Cancel** = send `{"type":1,"target":"stop","invocationId":"1","arguments":[{}]}` then close; server acks `type:3` and wipes the partial answer. Still costs 1/600; context persists. **Proxy now sends this on client-abort** | §6/F11 |
| 20 | **I/O is asymmetric:** input is retrieval-backed ≥500k tokens (benign size never Disengages); output soft-caps ~3k tokens by *concluding early*, not truncating — so big writes look complete but aren't. Proxy advertises 128k window + emits `finish_reason:"length"` near the cap | §6/F9/F10 |
| 21 | **The agent overrides `tone` → GPT-5.** A non-default tone (Claude, `*_Reasoning`) only takes effect with NO agent attached; with the agent it silently routes to GPT (or Disengages on heavy tool prompts). Proxy attaches the agent only for tool requests | §5/§10 |
| 22 | **`tone` is server-validated** (unknown → `type:3` error), so an accepted tone is real. `Claude_Sonnet` = real Claude Sonnet 4.5; `Gpt_5_5_*` current gen; `Claude_Reasoning` accepted but actually GPT | §5 |
| 23 | **Code interpreter is real:** `cwc_code_interpreter*` optionsSets + `GeneratedCode` msg type → genuine server-side Python execution. Proxy enables it on the agent-less path | §5 |
| 24 | **`optionsSets` was sent empty** — leaves code-interpreter/memory/custom-instructions/image off the table. Reference impls (PyRIT, kuchris) populate it | §5/hypotheses §8 |

---

## 12. Source map

| File | Responsibility |
|---|---|
| `packages/core/src/auth.ts` | MSAL PKCE, silent refresh, automated Playwright login, token-for-scope |
| `packages/core/src/copilot.ts` | One-shot WS chat, `decodeJwt`, `MODEL_TONES`, `VARIANTS` |
| `packages/core/src/session.ts` | Stateful `CopilotSession` (reconnect per turn, reuse ids), SignalR frame handling |
| `packages/core/src/model.ts` | `ModelSession` — auth + agent + conversation continuity, string-in/stream-out |
| `packages/core/src/agent.ts` | Copilot Studio agent create/publish, BAP env discovery |
| `packages/core/src/schemas.ts` | Zod schemas for SignalR frames & JWT claims |
| `packages/proxy-lib/src/handler.ts` | OpenAI ↔ M365 translation, `SessionPool`, delta mode, tool-call parsing, one-call-per-turn, empty-response fail-fast |
| `packages/core/src/tools.ts` | Tool-definition prompt, real-tool few-shot, `parseToolCalls` (bare + fenced, strips `confidence`/`final`) |

### Reverse-engineering probe scripts (`scripts/`, read-only)

| Script | What it digs |
|---|---|
| `listbots-probe.mjs` | Dumps `minimalBots` list — shows `displayName`→`shortBotName` round-trip, existing agents |
| `agent-model-probe.mjs` | Full `minimalBots` agent definition; hunts for a model field (there is none) |
| `studio-dig.mjs` | Logs into the real Copilot Studio UI (Playwright + TOTP) and **captures every API call** → revealed Dataverse + PVA + ECS layers |
| `dataverse-bot-probe.mjs` | Queries Dataverse (`<org>.crm4.dynamics.com`) directly — proved our agents aren't Dataverse bots |
| `proxy-verify.mjs` | End-to-end proxy check (`--agent --multiturn --manytools`) — reproduces disengagement, verifies the tool loop |
| `frame-dump-probe.mjs` | Sends one chat turn and dumps every field of every WS frame; flags token/usage-shaped keys/values. Hunts for hidden metrics. |
| `tool-compliance-experiment.mjs` | A/B harness over prompt variants × prompts. Scores tool-call compliance and Disengaged rate per variant. Burns ~30 messages. |
| `usage-endpoint-hunt.mjs` | Sweeps Sydney/Power Platform/BAP REST endpoints looking for token-usage / context-window data outside the WebSocket. |
| `variants-bisect.mjs` | Bisects the 40-flag `VARIANTS` query-string list to find which flag controls Disengaged / streaming routing. ~10 messages per target. |
| `toolformat-experiment.mjs` | Older tool-format A/B (bare JSON vs ```` ```json ```` vs ```` ```tool_call ````); kept around for reference. |

Run unsandboxed with `CHROMIUM_PATH` set and `M365_NO_INTERACTIVE=1`. They reuse the stored MSAL cache / automated login. Output (screenshots, captured network) lands in `scripts/*-out/` (gitignored).

### Frame dumping at runtime (`M365_DUMP_FRAMES=1`)

When set, `CopilotSession` appends every WS frame (both `send` and `recv`,
both raw chat invocation and bot updates) to
`~/.config/opencode-m365/frames/<requestId>.ndjson`. Use this in production
to catch a regression mid-flight: ship the suspect NDJSON to a dev box and
diff against a known-good capture. Negligible overhead since the data is
already in memory.

---

*If a future reader finds any of this is now wrong: M365 Copilot is an undocumented,
first-party-only surface and Microsoft changes it freely. Re-capture a real session
from `m365.cloud.microsoft` (browser devtools → WS frames) and diff against the above.*
