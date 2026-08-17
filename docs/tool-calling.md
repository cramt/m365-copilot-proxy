# Tool Calling Contract

This proxy translates OpenAI-compatible tool calls to/from M365 Copilot. Because M365 doesn't natively support the OpenAI tool-calling protocol, we prompt-engineer it via a system prompt and enforce the contract at the proxy layer.

## Output Contract

Tool calls are **fenced** (Markdown code blocks) — the JSON `{"tool":...}` format
was removed (it scored 0/5 on real agentic tasks; see [hypotheses §9](./hypotheses.md)).
A tool call is a code fence whose info-string is the tool name:

```
` ``read_file
/etc/hostname
` ``
```

Per-tool shape: the fence info-string is the tool name, scalar args are `key: value`
header lines, one free-form arg is the fence body, and an `old`/`new` pair renders as an
aider-style `SEARCH/REPLACE` diff.

**Shell-routing (the load-bearing trick).** M365's chat model won't "act as an agent" on
demand but *will* reflexively write a ` ```bash ` block. When the toolset includes a shell
tool (`bash`/`shell`/`run`/`run_command`/… — any name), the proxy injects "do the whole step
by writing one ` ```bash ` block" framing and routes that block to the shell tool. This is
what turns 0/5 into real multi-turn loops. See [hypotheses §9 F12](./hypotheses.md).

## Enforcement

The contract is enforced at three layers:

### 1. System Prompt (packages/core/src/tools.ts)

`formatFencedToolDefinitions()` injects the contract into every tool-enabled request:
- "Performing the task with tools is your **PRIMARY JOB**. Answering the user in prose is, and always will be, SECONDARY."
- A fenced block is an **ACTION the runtime executes**, not an example/illustration.
- **Shell-first framing** when a shell tool is present: "do the whole step by writing ONE ` ```bash ` block" (heredocs to create, `sed` to edit, `cat`/`ls`/`grep` to inspect), plus **anti-confabulation** ("you've run nothing yet — never claim commands return no output; your FIRST output is a ` ```bash ` block"). This framing is what made it work through real pi (hypotheses §9 F14).
- "**Never claim success** (`✅`/`SUCCESS`/`Done`) unless a `<tool_response>` proving it already appears above" — M365 loves to declare victory before the build runs.
- "When you do give the final answer, **no preamble/sign-off**".
- **Host-platform note** (`hostPlatformNote`, Windows only): every framing variant above
  teaches POSIX idioms *by name* — heredocs, `sed -i`, `ls`/`grep` — so on Windows the
  prompt instructs the model, on every turn, to emit commands the host cannot run. The note
  states the real platform and gives the PowerShell equivalents. It is empty off Windows, so
  the bench-tuned variants stay byte-for-byte unchanged; `platform` is injectable so the
  Windows branch is testable from a POSIX box. (#7.)

**Shell fence aliases** (`SHELL_LANGS` in `fenced.ts`): a fence only becomes a tool call if
its info-string is a known shell alias — POSIX (` ```bash `/`sh`/`shell`/`zsh`/…), the leaked
`container.*` runtime namespace (§12.13), and Windows (` ```powershell `/`pwsh`/`ps1`/`cmd`/
`bat`). Anything else is demoted to prose. Windows fences were **missing until 2026-08-17**,
so a model correctly told to use PowerShell produced turns that executed nothing — which read
to users as the model ignoring their instructions, and pushed it toward M365's own Linux
sandbox as the only filesystem it could reach (#7, #12). Windows aliases route regardless of
host: the proxy and harness need not share a machine, and a command that runs and fails
returns an error the model can correct from, whereas an unrouted fence loses the turn.

### 2. Copilot Studio Agent System Prompt (packages/core/src/agent.ts)

The most important layer: an auto-created Copilot Studio agent carries tool-calling
instructions in its **server-side** system prompt. Without the agent, M365 ignores the
per-request injection and answers in prose (or hallucinates). See
[m365-copilot-api.md](./m365-copilot-api.md) for why.

These instructions are baked in at agent-creation time and can't be cheaply updated in
place, so the agent is **versioned by name**: it's called `m365-tool-agent-<hash>`, where
`<hash>` is a short SHA-256 of the current instructions. Editing `getAgentInstructions()`
changes the hash, so the next request provisions a fresh agent; old versions are **never
deleted** (multi-host safety — a second proxy may still be using one). Hosts sharing a tenant
compute the same name for the same instructions and converge on one agent with no coordination.

### 3. Behaviour-hardening layer (packages/proxy-lib/src/handler.ts, tools.ts)

The model's output is scrubbed and steered at the proxy regardless of whether it obeyed
the prompt — the durable lever, since M365's chat-RLHF leaks through no matter how the
prompt is tuned. The layers, in handler order:

- **Document guard** (`isProseDocument`): shell-routing turns *every* ` ```bash ` block into
  a tool call — so a model that ANSWERS with a markdown document full of code fences (e.g.
  "here's a simplified README") would get its own answer executed as shell. A response that
  looks like a document (≥2 fences AND ≥120 chars surrounding prose, OR ≥4 fences) is returned
  as **text**, not executed. A single action is never reclassified. (hypotheses §9 F15.)
- **Confabulation retry** (`looksLikeConfabulation`): if a tool request comes back with no
  tool call and give-up prose ("can't access the files", "commands return no output", "the
  file appears empty", "paste the files"), the proxy re-prompts forcefully **in the same
  conversation** to force a real first action. `M365_NO_CONFAB_RETRY` / `M365_CONFAB_RETRIES`.
- **Hallucinated-completion retry** (`looksLikeHallucinatedCompletion`): if the model CLAIMS
  a file mutation ("I've replaced the README") with **no tool call all conversation**, force a
  real write. Gated on "never acted," so it won't misfire on a genuine post-write summary.
- **Tool-result labelling:** each `<tool_response>` is tagged with the command that produced
  it (`<tool_response tool="bash" command="ls -la">`) by correlating `tool_call_id` back to
  the call — so the model reads output in context (a listing vs file contents vs stdout)
  instead of e.g. misreading an `ls` result as an empty file. (hypotheses §9 F16.)
- **Mixed output:** when a response has tool calls AND extra text, the text is **stripped**;
  the client gets only `tool_calls` with `content: null` (stripped text is logged).
- **Invented JSON:** `parseToolCalls()` removes `{"confidence":N}`, **drops** a `{"final":…}`
  riding alongside tool calls (premature success), and **unwraps** a lone `{"final":"…"}`.
- **One call per turn:** keeps only the **first** tool call; M365 batches its whole plan into
  one response, running later steps on guessed state. Override with `M365_ALLOW_MULTI_TOOL`.
- **Empty ≠ rate limit:** an empty reply is treated as throttling only when the throttle is
  **at-limit**; otherwise it fails fast after a couple of quick retries. Repeated empties
  across **distinct conversations** (the thread-rate-throttle signature) trigger **degradation
  backoff** — the proxy paces subsequent turns so the account self-heals. This replaced the
  old auto-reauth: a fresh login does **not** clear this throttle (`oid`-keyed — hypotheses
  §11 H-R1) and raised our detection profile. `M365_NO_BACKOFF` to disable.

> The JSON tool format and the few-shot block were **removed** this cycle (0/5 on real
> agentic tasks). Tool calling is fenced-only; behavioural framing lives in the per-request
> `<tools>` block, not a baked-in few-shot.
