# Model observations

Recorded 2026-10-02 from two saved sweeps on the current account. Both were
agent-less. These are observations under specific request conditions, not a
universal model-support matrix. Model IDs can be aliases of the same tone.

## Summary

- Earlier tool sweep: 28 model IDs, 20 HTTP 200 responses, 8 HTTP 502 responses,
  and zero parsed local tool calls. Only `read_file` was exposed.
- Later self-ID sweep: 12 cells, 5 model answers, 5 licence refusals, 1 upstream
  `InternalError` apology, and 1 rejected invalid-tone control. No tools were
  exposed; no throttling or Disengaged frames were observed.
- All paid self-ID attempts returned `ForbiddenRequest` /
  `InvalidCopilotLicense`. Availability on a licensed account remains unverified
  by these runs.
- GPT self-reports named GPT-5 chat or reasoning, not minor versions. They do
  not establish a downgrade or independently identify GPT-5.5 versus GPT-5.6.
- `claude-sonnet-5.5` is not advertised by the proxy. Its name resolves to the
  same paid `Claude_Sonnet` selector as `claude-sonnet-5`; distinct 5.5 support
  remains unverified.

Scenario shorthand below: **Included** = `OfficeWebIncludedCopilot` + `Starter`;
**Paid** = `OfficeWebPaidCopilot` + `Premium`.

## Catalog selection

On 2026-10-02, `/v1/models` was restricted to the 20 included model IDs that
responded in the earlier sweep: 19 GPT IDs and `claude-sonnet-think-deeper`.
The initial selection omitted Claude reasoning because it refused the tool
task; that was corrected because a tool refusal is not a failed model response.
Comparison against all 28 saved rows found no other missing included responder.
The editable `EXPOSED_MODELS` list in
[packages/core/src/copilot.ts](../packages/core/src/copilot.ts) comments out:

- Included Claude chat IDs: `claude`, `claude-sonnet`, `claude-sonnet-4.5`,
  and `claude-sonnet-4.6` (failed upstream).
- Paid IDs: `claude-sonnet-5`, `claude-opus`, `claude-opus-5`, and
  `gpt-6-think-deeper`, unavailable to this account. Earlier evidence on other
  accounts is not invalidated by the current licence refusals.
- Unverified `claude-sonnet-5.5`, which was never advertised.

The tone/scenario mappings are unchanged, so explicit requests can still use
hidden IDs with their original routing. This is discovery filtering, not an
access-control block or automatic account-entitlement detection. Included
GPT-5.6 remains advertised despite its paid-scenario refusal, because it
answered on the included scenario. GPT-5.3 reasoning remains advertised because
its reported filesystem execution failure does not establish a dead model
route. The earlier 28-row table below preserves the original observations;
future catalog sweeps will enumerate the selected 21 IDs instead. Claude
reasoning's local tool support remains unverified despite its HTTP 200 response.

On 2026-10-03, `gpt-6-sol` was restored to discovery using the separate upstream
evidence in hypotheses §23 F49, bringing the catalog to 21 IDs. It was not a cell
in either sweep recorded here; its included scenario and premium-only tool-agent
routing remain unchanged.

## Earlier observation: 28-model tool sweep

Harness: [scripts/proxy-verify.mjs](../scripts/proxy-verify.mjs), `--all-models`,
without `--agent`. One initial request per model ID, non-streaming, with only
the `read_file` function exposed (`path`: absolute file path). The harness
enforces at least 30 seconds between model trials; the saved JSON does not
record the run's exact cooldown or timestamps. Proxy-internal retries may have
occurred, so this is not necessarily one upstream turn per model ID.

Prompt:

```text
Read the file /etc/hostname and tell me the hostname
```

| Model ID | Scenario | HTTP | Response observation | Parsed local tool call |
|---|---|---:|---|---|
| `m365-copilot` | Included | 200 | Reported sandbox hostname | Not observed |
| `auto` | Included | 200 | Reported sandbox hostname | Not observed |
| `quick` | Included | 200 | Reported sandbox hostname | Not observed |
| `think-deeper` | Included | 200 | Reported sandbox hostname | Not observed |
| `claude` | Included | 502 | Empty upstream response | Unverified |
| `claude-sonnet` | Included | 502 | Empty upstream response | Unverified |
| `claude-sonnet-4.5` | Included | 502 | Empty upstream response | Unverified |
| `claude-sonnet-4.6` | Included | 502 | Empty upstream response | Unverified |
| `claude-sonnet-5` | Paid | 502 | Empty upstream response | Unverified |
| `claude-sonnet-think-deeper` | Included | 200 | Refused; said shell/file tools unavailable | Not observed |
| `claude-opus` | Paid | 502 | Empty upstream response | Unverified |
| `claude-opus-5` | Paid | 502 | Empty upstream response | Unverified |
| `gpt-5.5` | Included | 200 | Reported sandbox hostname | Not observed |
| `gpt-5.5-quick` | Included | 200 | Reported sandbox hostname | Not observed |
| `gpt-5.5-think-deeper` | Included | 200 | Reported sandbox hostname | Not observed |
| `gpt-5.6` | Included | 200 | Reported sandbox hostname | Not observed |
| `gpt-5.6-quick` | Included | 200 | Reported sandbox hostname | Not observed |
| `gpt-5.6-think-deeper` | Included | 200 | Reported sandbox hostname | Not observed |
| `gpt-6-think-deeper` | Paid | 502 | Empty upstream response | Unverified |
| `gpt-5.4` | Included | 200 | Reported sandbox hostname | Not observed |
| `gpt-5.4-think-deeper` | Included | 200 | Reported sandbox hostname | Not observed |
| `gpt-5.4-quick` | Included | 200 | Bash fence: `ls -la && cat /etc/hostname` | Not parsed |
| `gpt-5.3` | Included | 200 | Reported sandbox hostname | Not observed |
| `gpt-5.3-quick` | Included | 200 | Reported sandbox hostname | Not observed |
| `gpt-5.3-think-deeper` | Included | 200 | Said filesystem execution failed | Not observed |
| `gpt-5.2` | Included | 200 | Reported sandbox hostname | Not observed |
| `gpt-5.2-quick` | Included | 200 | Reported sandbox hostname | Not observed |
| `gpt-5.2-think-deeper` | Included | 200 | Reported sandbox hostname | Not observed |

The 17 hostname replies contained `SandboxHost-...`, not a result supplied by
the local harness. This does not prove local file access or, by itself, prove
the reported execution actually happened. The GPT-5.4 Quick Bash fence is
potentially routable, but no shell tool was exposed. A shell-enabled follow-up
has not been run as part of these observations.

All saved `followup` fields are null: no parsed tool call triggered the
harness's second turn. No successful local tool loop was demonstrated.
The eight proxy errors were `upstream_empty_response`; their saved error text
does not identify an exact upstream cause. The later licence refusals must not
be retroactively treated as proof of the cause of those earlier 502s.

## Current observation: 12-cell self-ID sweep

Run: **2026-10-02 13:50:11-13:53:42 UTC**. Used the 11 exported default cells
from [scripts/agent-tone-probe.mjs](../scripts/agent-tone-probe.mjs), plus the
resolved `claude-sonnet-5.5` model ID, through
[scripts/_probe-chat.mjs](../scripts/_probe-chat.mjs). The agent-attached probe's
CLI was not used: these turns explicitly sent `agentId: null`.

One raw upstream turn per cell, temporary chats, 15 seconds between fresh
threads, no retries, and a 90-second turn timeout. Raw frames and structured
results were saved. All 12 cells completed; no throttling, Disengaged frames,
or timeouts were observed.

Exact prompt:

```text
Which AI model are you exactly? State your underlying model name and version and the company that made you, in one short sentence. Do not add anything else.
```

| Tone / Model ID | Scenario | Wire result | Response observation |
|---|---|---|---|
| `magic` | Included | `Success` / `DeepLeo` | Self-ID: GPT-5 chat |
| `Gpt_5_5_Chat` | Included | `Success` / `DeepLeo` | Self-ID: GPT-5 chat |
| `Gpt_5_5_Reasoning` | Included | `Success` / `DeepLeo` | Self-ID: GPT-5 reasoning |
| `Gpt_5_6_Chat` | Included | `Success` / `DeepLeo` | Self-ID: GPT-5 chat |
| `Gpt_5_6_Chat` | Paid | `ForbiddenRequest` / `InvalidCopilotLicense` | Licence refusal |
| `Gpt_5_6_Reasoning` | Included | `Success` / `DeepLeo` | Self-ID: GPT-5 reasoning |
| `Gpt_6_Reasoning` | Paid | `ForbiddenRequest` / `InvalidCopilotLicense` | Licence refusal |
| `Claude_Sonnet` | Included | `InternalError` / `BotConnection` | Canned apology; no model self-ID |
| `Claude_Sonnet` | Paid | `ForbiddenRequest` / `InvalidCopilotLicense` | Licence refusal |
| `Claude_Opus` | Paid | `ForbiddenRequest` / `InvalidCopilotLicense` | Licence refusal |
| `Definitely_Not_A_Real_Tone_XYZ` | Included | Type-3 invocation error | Invalid-tone control rejected |
| `claude-sonnet-5.5` (resolved to `Claude_Sonnet`) | Paid | `ForbiddenRequest` / `InvalidCopilotLicense` | Licence refusal |

The chat self-ID replies credited Microsoft. The reasoning replies explicitly
named OpenAI's GPT-5 reasoning model and Microsoft as Copilot's creator. These
are model-generated statements, not independent attestations of version or
manufacturer.

All five licence refusals said:

> It looks like you don't have a valid licence. To get access, please check with your administrator.

The included Sonnet reply said:

> Sorry, I wasn't able to respond to that. Is there something else I can help with?

Quoted text above normalizes typographic apostrophes to ASCII. The Sonnet
apology is a failed connection, not evidence that Sonnet is universally
unsupported. The invalid-tone control confirms rejection of that invalid
selector, not the exact identities of successful routes. This sweep tested no
tool-calling capability.

## Evidence and interpretation

- Earlier saved results:
  `/var/folders/dy/cmh5cgm90xq3r0pk5mr9sbvc0000gp/T/m365-model-sweep-jNOQK3/results.json`.
- Current saved results:
  `/var/folders/dy/cmh5cgm90xq3r0pk5mr9sbvc0000gp/T/m365-selfid-sweep-VCXCi8/results.json`,
  with 12 sibling raw-frame `.jsonl` files. Classifications were checked against
  the raw final results, mapping the helper's `contentOrigin` to the
  classifier's `answerOrigin` to avoid counting BotConnection apologies as
  model answers.
- These evidence paths are machine-local temporary files, not committed
  artifacts; they may be removed by OS cleanup. This document preserves the
  observation tables, not all raw frames or responses.
- Experiment notebook: [docs/hypotheses.md](../docs/hypotheses.md#L3431).
- Routing reference: [docs/m365-copilot-api.md](../docs/m365-copilot-api.md).

Keep **no tool call observed**, **upstream failure**, **account not licensed**,
and **tool calling unsupported** distinct. These sweeps demonstrate the first
three under their stated conditions, not the fourth. Further version and
tool-loop claims require new, appropriately licensed and tool-equipped tests.