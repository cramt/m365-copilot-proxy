import { randomUUID } from "node:crypto";
import { type Message, getMessageContent } from "@m365-copilot/core";
import { estimateTokens } from "./openai.js";

/** Minimal structural message shape. */
export interface SummaryProbeMessage {
  role: string;
  content?: unknown;
}

const SUMMARIZER_SYSTEM_PREFIX = "You are a context summarization assistant.";
const SUMMARY_PROMPT_MARKERS = [
  "Create a structured context checkpoint summary",
  "NEW conversation messages to incorporate into the existing summary",
  "Create a concise checkpoint of the user's request",
];
// How pi's compaction prompts begin (history/update: `<conversation>`, turn prefix: `# Conversation`).
const SUMMARY_PROMPT_OPENINGS = ["<conversation>", "# Conversation"];
const DEFAULT_MODEL = "m365-copilot";

export const HARNESS_SUMMARY_TEXT = [
  "## Goal",
  "Continue the current task from the latest message.",
  "",
  "## Constraints & Preferences",
  "- None recorded in this summary.",
  "",
  "## Progress",
  "### Done",
  "- The proxy retains the full conversation history server-side in its sticky M365 conversation.",
  "",
  "### In Progress",
  "- Continue from the latest message.",
  "",
  "### Blocked",
  "- None.",
  "",
  "## Key Decisions",
  "- None recorded in this summary.",
  "",
  "## Next Steps",
  "1. Continue from the latest message.",
  "",
  "## Critical Context",
  "- Earlier turns are still available to the model; do not re-summarize them.",
].join("\n");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrows an unknown `content` into the `Message` shape `getMessageContent` reads. */
function toMessage(message: SummaryProbeMessage): Message {
  const { content } = message;
  if (typeof content === "string") return { role: message.role, content };
  if (!Array.isArray(content)) return { role: message.role };
  const parts = content.filter(isObject).map((part) => ({
    type: typeof part.type === "string" ? part.type : "",
    text: typeof part.text === "string" ? part.text : undefined,
  }));
  return { role: message.role, content: parts };
}

function textOf(message: SummaryProbeMessage): string {
  return getMessageContent(toMessage(message));
}

function lastUserText(messages: ReadonlyArray<SummaryProbeMessage>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return textOf(messages[i]);
  }
  return null;
}

function isSummarizerSystem(message: SummaryProbeMessage): boolean {
  return (
    message.role === "system" && textOf(message).trimStart().startsWith(SUMMARIZER_SYSTEM_PREFIX)
  );
}

/** True when the request is a harness's context-compaction summary request: it has no tools (tools undefined or empty) AND (some system message's text starts with "You are a context summarization assistant." OR the LAST user message starts with "<conversation>" or "# Conversation" and contains one of the marker phrases: "Create a structured context checkpoint summary", "NEW conversation messages to incorporate into the existing summary", "Create a concise checkpoint of the user's request"). */
export function isHarnessSummaryRequest(body: {
  messages: ReadonlyArray<SummaryProbeMessage>;
  tools?: ReadonlyArray<unknown> | null;
}): boolean {
  if ((body.tools?.length ?? 0) > 0) return false;
  if (body.messages.some(isSummarizerSystem)) return true;
  const lastUser = lastUserText(body.messages);
  if (lastUser === null) return false;
  // pi opens every summary prompt with the transcript wrapper, so a pasted file or
  // message that merely contains a marker phrase is not taken for one.
  const opening = lastUser.trimStart();
  if (!SUMMARY_PROMPT_OPENINGS.some((prefix) => opening.startsWith(prefix))) return false;
  return SUMMARY_PROMPT_MARKERS.some((marker) => lastUser.includes(marker));
}

function summaryUsage() {
  const completionTokens = estimateTokens(HARNESS_SUMMARY_TEXT);
  return {
    prompt_tokens: 0,
    completion_tokens: completionTokens,
    total_tokens: completionTokens,
    x_proxy_tokens_estimated: true,
    x_proxy_local_summary: true,
  };
}

function jsonSummaryResponse(
  id: string,
  created: number,
  model: string,
  headers: Record<string, string>,
): Response {
  const body = {
    id,
    object: "chat.completion",
    created,
    model,
    system_fingerprint: null,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: HARNESS_SUMMARY_TEXT },
        logprobs: null,
        finish_reason: "stop",
      },
    ],
    usage: summaryUsage(),
  };
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function sseSummaryResponse(
  id: string,
  created: number,
  model: string,
  includeUsage: boolean,
  headers: Record<string, string>,
): Response {
  const base = { id, object: "chat.completion.chunk", created, model, system_fingerprint: null };
  const frames = [
    { ...base, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
    {
      ...base,
      choices: [{ index: 0, delta: { content: HARNESS_SUMMARY_TEXT }, finish_reason: null }],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      ...(includeUsage ? { usage: summaryUsage() } : {}),
    },
  ];
  const events = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  return new Response(`${events}data: [DONE]\n\n`, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", ...headers },
  });
}

/** An OpenAI chat-completions Response carrying HARNESS_SUMMARY_TEXT, finish_reason "stop", without contacting M365. */
export function harnessSummaryResponse(body: {
  model?: string;
  stream?: boolean | null;
  stream_options?: { include_usage?: boolean | null } | null;
}): Response {
  const model = body.model || DEFAULT_MODEL;
  const headers = {
    "x-proxy-model": model,
    "x-proxy-stream": body.stream ? "1" : "0",
    "x-proxy-local-summary": "1",
    "x-proxy-finish-reason": "stop",
  };
  const id = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  if (!body.stream) return jsonSummaryResponse(id, created, model, headers);
  return sseSummaryResponse(id, created, model, !!body.stream_options?.include_usage, headers);
}
