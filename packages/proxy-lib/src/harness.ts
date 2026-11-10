// What the proxy does differently for coding-agent harnesses that reach it
// through an Anthropic/Responses gateway (copilot-api) — Claude Code and Codex.

// copilot-api forwards the client's own user-agent upstream: Claude Code sends
// `claude-cli/<version> …`, Codex `codex_exec/…`, `codex_cli_rs/…` or `codex-tui/…`.
const AGENT_HARNESS_USER_AGENT = /^(?:claude-cli|claude-code|codex[_-][a-z_]+)\//i;

export function isAgentHarnessUserAgent(userAgent: string | null | undefined): boolean {
  return !!userAgent && AGENT_HARNESS_USER_AGENT.test(userAgent.trim());
}

/**
 * Whether a failure after a streaming response's HTTP 200 goes out as assistant
 * text instead of an OpenAI-style `error` chunk.
 *
 * copilot-api can't parse the error chunk: through it, Claude Code saw
 * "API Error: 500 Unexpected token 'd'…" and retried the turn ten times in
 * ~150 s. Every retry of a Disengaged turn opens fresh M365 conversations —
 * exactly what the account's thread-rate throttle counts. As text, the turn
 * ends with the reason and nothing retries. `M365_STREAM_ERROR_MODE=text|chunk`
 * forces either; the default keeps the error chunk for every other client.
 */
export function streamErrorsAsText(userAgent: string | null | undefined): boolean {
  const mode = process.env.M365_STREAM_ERROR_MODE?.trim().toLowerCase();
  if (mode === "text") return true;
  if (mode === "chunk") return false;
  return isAgentHarnessUserAgent(userAgent);
}

export interface StreamError {
  message: string;
  type: string;
  code?: string;
  retryAfter?: number;
}

/** The assistant message that stands in for a failed turn. */
export function streamErrorText(err: StreamError): string {
  const retry = err.retryAfter ? ` Retry after ${err.retryAfter}s.` : "";
  return `[m365-proxy: ${err.code ?? err.type}] ${err.message}${retry}`;
}

// copilot-api appends this block to the first system prompt of every Codex
// request it adapts for a non-GPT model. It says `exec_command` doesn't exist
// and asks for JavaScript in `functions__exec` — the opposite of the proxy's
// shell routing, which turns a ```bash block into that JavaScript itself.
const GATEWAY_TOOL_TIPS = /\n*# Tool Call Tips\n(?:(?:- |const results = )[^\n]*(?:\n|$))+\n*/g;

export function stripGatewayToolTips(text: string): string {
  return text.replace(GATEWAY_TOOL_TIPS, (block, offset: number, whole: string) => {
    if (!block.includes("functions__exec")) return block;
    return offset + block.length >= whole.length ? "" : "\n\n";
  });
}

type ContentPart = { type: string; text?: string };
interface SystemMessageLike {
  role: string;
  content?: string | ContentPart[] | null;
}

/** The messages with `fn` applied to the text of every message whose role `applies`;
 *  unchanged messages (and parts) stay the same objects. */
function mapMessageText<M extends SystemMessageLike>(
  messages: M[],
  applies: (role: string) => boolean,
  fn: (text: string) => string,
): M[] {
  return messages.map((m) => {
    if (!applies(m.role) || !m.content) return m;
    if (typeof m.content === "string") {
      const content = fn(m.content);
      return content === m.content ? m : { ...m, content };
    }
    const parts = m.content.map((p) => {
      if (typeof p.text !== "string") return p;
      const text = fn(p.text);
      return text === p.text ? p : { ...p, text };
    });
    return parts.some((p, i) => p !== (m.content as ContentPart[])[i]) ? { ...m, content: parts } : m;
  });
}

/** The messages with copilot-api's tool tips removed from system messages. */
export function stripGatewayToolTipsFromMessages<M extends SystemMessageLike>(messages: M[]): M[] {
  return mapMessageText(messages, (role) => role === "system", stripGatewayToolTips);
}

// Claude Code's and Codex's prompts carry text that M365's models read as an
// identity override or an injected prompt, and refuse on (hypotheses §39 H39d):
// Anthropic's billing header, "You are Claude Code, Anthropic's official CLI" /
// "a Claude agent, built on Anthropic's Claude Agent SDK" / "a coding agent running
// in the Codex CLI", and <system-reminder> blocks in the user turn — one names the
// model ID, one dictates git attribution. Sonnet 5 refused three Claude Code tasks
// out of three quoting exactly those. M365_HARNESS_PROMPT, for harness user-agents:
//   off   — send them as they are (default);
//   clean — drop those lines, unwrap the reminders that hold the environment or
//           the date and drop the others;
//   lean  — clean, and cut each tool description to ~700 characters at a line
//           break (Claude Code's Bash is 10k, mostly git and PR protocol).
export type HarnessPromptMode = "off" | "clean" | "lean";

export function harnessPromptMode(userAgent: string | null | undefined): HarnessPromptMode {
  if (!isAgentHarnessUserAgent(userAgent)) return "off";
  const mode = process.env.M365_HARNESS_PROMPT?.trim().toLowerCase();
  return mode === "clean" || mode === "lean" ? mode : "off";
}

const BILLING_HEADER = /^x-anthropic-billing-header:[^\n]*(?:\n|$)/gm;
const HARNESS_IDENTITY =
  /^You are (?:Claude Code, Anthropic's official CLI for Claude|a Claude agent, built on Anthropic's Claude Agent SDK|a coding agent running in the Codex CLI)\b[^\n]*(?:\n|$)/gm;
const SYSTEM_REMINDER = /<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>\n?/g;
const KEPT_REMINDER = /^(?:# Environment\b|Today's date is\b)/;

/** One message's text without the harness's identity lines and reminders. */
export function cleanHarnessText(text: string): string {
  let changed = false;
  const removed = (keep = "") => { changed = true; return keep; };
  const out = text
    .replace(BILLING_HEADER, () => removed())
    .replace(HARNESS_IDENTITY, () => removed())
    .replace(SYSTEM_REMINDER, (_block, inner: string) => removed(KEPT_REMINDER.test(inner) ? `${inner}\n` : ""));
  return changed ? out.replace(/\n{3,}/g, "\n\n").replace(/^\s+/, "") : text;
}

/** The messages with `cleanHarnessText` applied to every non-assistant message. */
export function cleanHarnessMessages<M extends SystemMessageLike>(messages: M[]): M[] {
  return mapMessageText(messages, (role) => role !== "assistant", cleanHarnessText);
}

const LEAN_DESCRIPTION_CHARS = 700;

/** A tool description cut to `max` characters at the last line break before it. */
export function leanToolDescription(description: string, max = LEAN_DESCRIPTION_CHARS): string {
  if (description.length <= max) return description;
  const cut = description.lastIndexOf("\n", max);
  return description.slice(0, cut > 0 ? cut : max).trimEnd();
}

interface ToolLike {
  function: { description?: string };
}

/** The tools with long descriptions cut by `leanToolDescription`. */
export function leanHarnessTools<T extends ToolLike>(tools: T[] | undefined): T[] | undefined {
  return tools?.map((t) => {
    const description = t.function.description;
    if (!description || description.length <= LEAN_DESCRIPTION_CHARS) return t;
    return { ...t, function: { ...t.function, description: leanToolDescription(description) } };
  });
}
