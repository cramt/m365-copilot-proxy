import { describe, it, expect, vi } from "vitest";

// Replace core's ModelSession with a scripted fake so we can exercise the handler's
// streaming path with no auth/WebSocket. Everything else in core stays real.
const scripted: {
  deltas: string[];
  fullText?: string;
  runs: number;
  /** Text of every run() call, in order. */
  texts: string[];
  /** Per-call replies, consumed front-first; when empty, `deltas`/`fullText` apply. */
  queue: Array<{ fullText: string }>;
} = { deltas: [], runs: 0, texts: [], queue: [] };

vi.mock("@m365-copilot/core", async (importActual) => {
  const actual = await importActual<typeof import("@m365-copilot/core")>();
  class FakeModelSession {
    turnCount = 0;
    conversationId = "conv-test";
    reset() {}
    newConversation() { this.conversationId = "conv-test-2"; }
    async refreshAgent() { return false; }
    async run(text: string) {
      this.turnCount++; // like the real session: later requests go down the delta path
      scripted.runs++;
      scripted.texts.push(text);
      const next = scripted.queue.shift();
      const deltas = next ? (next.fullText ? [next.fullText] : []) : scripted.deltas;
      const full = next ? next.fullText : (scripted.fullText ?? deltas.join(""));
      const stream = {
        fullText: full,
        hasContent: full.length > 0,
        images: [],
        throttle: { current: 1, max: 600 },
        contentOrigin: "Claude",
        messageType: null as string | null,
        messageId: "m1",
        scores: null,
        turnCount: 1,
        turnState: "Completed",
        async *[Symbol.asyncIterator]() {
          for (const d of deltas) {
            await Promise.resolve(); // yield to the event loop between deltas
            yield d;
          }
        },
      };
      return stream;
    }
  }
  return { ...actual, ModelSession: FakeModelSession };
});

const { handleChatCompletion, SessionPool, ChatCompletionRequest } = await import("./index.js");

/** Drive one streaming request and collect the ordered content-delta strings. */
async function streamContents(deltas: string[], fullText?: string): Promise<string[]> {
  scripted.deltas = deltas;
  scripted.fullText = fullText;
  const body = ChatCompletionRequest.parse({
    model: "m365-copilot",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  });
  const res = await handleChatCompletion(body, new SessionPool());
  expect(res.status).toBe(200);
  const text = await res.text();

  const contents: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    const chunk = JSON.parse(payload);
    const c = chunk.choices?.[0]?.delta?.content;
    if (typeof c === "string" && c.length > 0) contents.push(c);
  }
  return contents;
}

describe("incremental streaming (non-tool path)", () => {
  it("forwards deltas as separate chunks, not one buffered blob", async () => {
    const contents = await streamContents(["Hello", ", ", "world", "!"]);
    // Genuinely incremental: each delta is its own chunk.
    expect(contents.length).toBeGreaterThan(1);
    // Lossless and in-order: reconstructs the full answer exactly once.
    expect(contents.join("")).toBe("Hello, world!");
  });

  it("emits the trailing remainder once when the final text outruns the delta stream", async () => {
    // Deltas cover a prefix ("Hello wor"); the authoritative full text is longer —
    // the renderer must send the "ld" tail exactly once, never re-send the prefix.
    const contents = await streamContents(["Hello ", "wor"], "Hello world");
    expect(contents.join("")).toBe("Hello world");
    // No duplicated prefix.
    expect(contents.join("").match(/Hello/g)?.length).toBe(1);
  });
});

/** Drive one streaming request and collect content deltas AND error chunks. */
async function streamRaw(
  deltas: string[],
  fullText?: string,
): Promise<{ contents: string[]; errors: any[] }> {
  scripted.deltas = deltas;
  scripted.fullText = fullText;
  const body = ChatCompletionRequest.parse({
    model: "claude-opus",
    stream: true,
    messages: [{ role: "user", content: "hello" }],
  });
  const res = await handleChatCompletion(body, new SessionPool());
  const text = await res.text();

  const contents: string[] = [];
  const errors: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    const chunk = JSON.parse(payload);
    const c = chunk.choices?.[0]?.delta?.content;
    if (typeof c === "string" && c.length > 0) contents.push(c);
    if (chunk.error) errors.push(chunk.error);
  }
  return { contents, errors };
}

describe("priority-access exhaustion on the streaming path", () => {
  const REFUSAL =
    "You've used your available priority access to the Opus model for today. " +
    "You can choose another available model or wait until tomorrow to use the Opus model again.";

  it("never leaks the refusal to the client as content", async () => {
    // Chunked the way M365 actually streams it — the gate must hold the head.
    const deltas = REFUSAL.match(/.{1,12}/g)!;
    const { contents } = await streamRaw(deltas);
    expect(contents.join("")).not.toContain("priority access");
    expect(contents.join("")).toBe("");
  });

  it("emits a machine-readable error chunk, not just prose", async () => {
    const { errors } = await streamRaw(REFUSAL.match(/.{1,12}/g)!);
    expect(errors).toHaveLength(1);
    // A streaming client must be able to tell a quota wall from a transient
    // upstream blip without string-matching the message.
    expect(errors[0].code).toBe("priority_access_exhausted");
    expect(errors[0].type).toBe("rate_limit_error");
    expect(errors[0].retry_after).toBeGreaterThan(0);
  });

  it("still streams an ordinary answer that merely starts with \"You\"", async () => {
    const { contents, errors } = await streamRaw(["You", "r code ", "has a bug."]);
    expect(errors).toHaveLength(0);
    expect(contents.join("")).toBe("Your code has a bug.");
  });
});

describe("the only-the-first-call-ran note", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  const NOTE = "(Note: only the first tool call in your previous reply was actually run.";

  /** One conversation, several requests through the same pool. */
  async function converse(replies: string[]): Promise<string[]> {
    scripted.texts = [];
    scripted.queue = replies.map((fullText) => ({ fullText }));
    const pool = new SessionPool();
    const messages: any[] = [{ role: "system", content: "sys" }, { role: "user", content: `fix it ${Math.random()}` }];
    for (let i = 0; i < replies.length; i++) {
      const res = await handleChatCompletion(ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, tools, messages }), pool);
      const msg = (await res.json()).choices[0].message;
      if (!msg.tool_calls) break;
      messages.push({ role: "assistant", content: null, tool_calls: msg.tool_calls });
      messages.push({ role: "tool", tool_call_id: msg.tool_calls[0].id, content: `real output ${i}` });
    }
    scripted.queue = [];
    return scripted.texts;
  }

  it("tells the model, with the real result, that its invented tail never ran", async () => {
    const sent = await converse([
      "```bash\ncat config.json\n```\n\n<tool_response>\n{\"port\": 3000}\n</tool_response>\n\nThe bug is fixed.",
      "```bash\nsed -i s/3000/8080/ config.json\n```",
      "Done.",
    ]);
    expect(sent).toHaveLength(3);
    expect(sent[1].startsWith(NOTE)).toBe(true);
    expect(sent[1]).toContain("real output 0");
    expect(sent[2]).not.toContain("(Note:"); // once only: turn 2 was executed in full
  });

  it("says how many batched calls were dropped by one-call-per-turn", async () => {
    const sent = await converse(["```bash\nls\n```\n\n```bash\ncat a.txt\n```", "Done."]);
    expect(sent[1]).toContain("only the first of the 2 tool calls in your previous reply was run; the other one was not");
  });

  it("adds nothing when the whole reply ran", async () => {
    const sent = await converse(["```bash\nls\n```", "Done."]);
    expect(sent[1]).not.toContain("(Note:");
  });
});
