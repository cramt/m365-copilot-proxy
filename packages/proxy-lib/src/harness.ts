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

/** The messages with copilot-api's tool tips removed from system messages. */
export function stripGatewayToolTipsFromMessages<M extends SystemMessageLike>(messages: M[]): M[] {
  return messages.map((m) => {
    if (m.role !== "system" || !m.content) return m;
    if (typeof m.content === "string") {
      const content = stripGatewayToolTips(m.content);
      return content === m.content ? m : { ...m, content };
    }
    const parts = m.content.map((p) => {
      if (typeof p.text !== "string") return p;
      const text = stripGatewayToolTips(p.text);
      return text === p.text ? p : { ...p, text };
    });
    return parts.some((p, i) => p !== (m.content as ContentPart[])[i]) ? { ...m, content: parts } : m;
  });
}
