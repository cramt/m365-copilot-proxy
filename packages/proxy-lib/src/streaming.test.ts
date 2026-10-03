import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Replace core's ModelSession with a scripted fake so we can exercise the handler's
// streaming path with no auth/WebSocket. Everything else in core stays real.
const scripted: {
  deltas: string[];
  fullText?: string;
  /** Script an upstream `result` (e.g. Throttled) on a turn with no content. */
  result?: { value: string; errorCode?: string; message?: string } | null;
  runs: number;
  /** Text of every run() call, in order. */
  texts: string[];
  /** Per-call overrides, consumed front-first (e.g. a Disengaged turn, then an answer). */
  queue: Array<{ fullText: string; messageType?: string | null }>;
  /** The `useAgent` argument of every run() call, in order. */
  agentFlags: Array<boolean | undefined>;
  agentId?: string | null;
  resolutions: number;
} = { deltas: [], runs: 0, texts: [], queue: [], agentFlags: [], resolutions: 0 };

vi.mock("@m365-copilot/core", async (importActual) => {
  const actual = await importActual<typeof import("@m365-copilot/core")>();
  class FakeModelSession {
    turnCount = 0;
    sessionId = "session-test";
    conversationId = "conv-test";
    reset() { }
    newConversation() {
      this.conversationId = "conv-test-2";
    }
    refreshAgent() {
      return Promise.resolve(false);
    }
    resolveAgent() {
      scripted.resolutions++;
      return Promise.resolve(scripted.agentId === undefined ? "agent-test" : scripted.agentId);
    }
    run(text: string, _model?: string, _signal?: AbortSignal, useAgent?: boolean) {
      this.turnCount++; // like the real session: later requests go down the delta path
      scripted.runs++;
      scripted.texts.push(text);
      scripted.agentFlags.push(useAgent);
      const next = scripted.queue.shift();
      const deltas = next ? (next.fullText ? [next.fullText] : []) : scripted.deltas;
      const full = next ? next.fullText : (scripted.fullText ?? deltas.join(""));
      const stream = {
        fullText: full,
        hasContent: full.length > 0,
        result: scripted.result ?? { value: "Success" },
        images: [],
        throttle: { current: 1, max: 600 },
        contentOrigin: "Claude",
        messageType: next?.messageType ?? null,
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
      return Promise.resolve(stream);
    }
  }
  return {
    ...actual,
    ModelSession: FakeModelSession,
    awaitDegradationBackoff: vi.fn(() => Promise.resolve()),
  };
});

const { handleChatCompletion, SessionPool, ChatCompletionRequest } = await import("./index.js");
const { noteRequestOutcome } = await import("@m365-copilot/core");
type JsonObject = Record<string, unknown>;
type RequestMessage = ReturnType<typeof ChatCompletionRequest.parse>["messages"][number];
type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) throw new TypeError("Expected a JSON object");
  return value;
}

function asNumber(value: unknown): number {
  if (typeof value !== "number") throw new TypeError("Expected a number");
  return value;
}

function headerValue(response: Response, name: string): string {
  const value = response.headers.get(name);
  if (value === null) throw new Error(`Missing response header: ${name}`);
  return value;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new TypeError("Expected a JSON array");
  return value;
}

function asString(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Expected a string");
  return value;
}

function objectAt(value: unknown, key: string): JsonObject {
  return asObject(asObject(value)[key]);
}

async function responseJson(response: Response): Promise<unknown> {
  return parseJson(await response.text());
}

function asToolCall(value: unknown): ToolCall {
  const call = asObject(value);
  const type = call.type;
  if (type !== "function") throw new TypeError("Expected a function tool call");
  const functionCall = asObject(call.function);
  return {
    id: asString(call.id),
    type,
    function: {
      name: asString(functionCall.name),
      arguments: asString(functionCall.arguments),
    },
  };
}

function asToolCalls(value: unknown): ToolCall[] {
  return asArray(value).map(asToolCall);
}

describe("model-aware conversation snapshots", () => {
  it("reuses a conversation only for the same model and first user message", () => {
    const pool = new SessionPool();
    const messages = ChatCompletionRequest.parse({
      messages: [{ role: "user", content: "same prompt" }],
    }).messages;
    const sonnet = pool.resolve(messages, "claude-sonnet");
    expect(pool.resolve(messages, "claude-sonnet")).toBe(sonnet);
    expect(pool.resolve(messages, "gpt-6-think-deeper")).not.toBe(sonnet);
    expect(
      pool
        .getActiveConversations()
        .map((snapshot) => snapshot.model)
        .sort(),
    ).toEqual(["claude-sonnet", "gpt-6-think-deeper"]);
  });

  it("publishes usage and proxy headers for completed JSON responses", async () => {
    scripted.result = null;
    scripted.fullText = "Hello";
    scripted.deltas = ["Hello"];
    const pool = new SessionPool();
    const response = await handleChatCompletion(
      ChatCompletionRequest.parse({
        model: "claude-sonnet",
        messages: [{ role: "user", content: "usage" }],
      }),
      pool,
    );
    expect(response.headers.get("x-proxy-session-id")).toBe("session-test");
    expect(response.headers.get("x-proxy-model")).toBe("claude-sonnet");
    expect(response.headers.get("x-proxy-finish-reason")).toBe("stop");
    expect(
      asNumber(
        asObject(parseJson(headerValue(response, "x-proxy-usage"))).x_proxy_model_latency_ms,
      ),
    ).toBeGreaterThanOrEqual(0);
    expect(pool.getActiveConversations()[0].usage).toMatchObject({
      model: "claude-sonnet",
      conversationMessages: 1,
    });
  });

  it("reports streaming usage only after the turn completes", async () => {
    scripted.result = null;
    scripted.fullText = "Hello";
    scripted.deltas = ["Hello"];
    const onComplete = vi.fn((_response: Response) => undefined);
    const pool = new SessionPool();
    const response = await handleChatCompletion(
      ChatCompletionRequest.parse({
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "stream usage" }],
      }),
      pool,
      { onComplete },
    );
    expect(response.headers.get("x-proxy-session-id")).toBe("session-test");
    const text = await response.text();
    expect(text).toContain("x_proxy_model_latency_ms");
    expect(onComplete).toHaveBeenCalledOnce();
    const completedResponse = onComplete.mock.calls[0][0];
    expect(
      asNumber(
        asObject(parseJson(headerValue(completedResponse, "x-proxy-usage"))).x_m365_conversation_remaining,
      ),
    ).toBe(599);
    expect(pool.getActiveConversations()[0].usage?.modelLatencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe("exact-reply system guard", () => {
  it.each([false, true])(
    "enforces the directive without leaking upstream prose (stream=%s)",
    async (stream) => {
      scripted.result = null;
      scripted.fullText = "This is not the requested answer.";
      scripted.deltas = ["This is not ", "the requested answer."];
      const response = await handleChatCompletion(
        ChatCompletionRequest.parse({
          stream,
          messages: [
            { role: "system", content: 'Only reply with "EXACT".' },
            { role: "user", content: "hello" },
          ],
        }),
        new SessionPool(),
      );
      const result = await response.text();
      expect(result).toContain("EXACT");
      expect(result).not.toContain("This is not");
    },
  );

  it("forwards system messages introduced on a follow-up turn", async () => {
    scripted.result = null;
    scripted.fullText = "Hello";
    scripted.deltas = ["Hello"];
    scripted.texts = [];
    const pool = new SessionPool();
    const messages = [{ role: "user", content: "follow-up system" }];
    await handleChatCompletion(ChatCompletionRequest.parse({ messages }), pool);
    messages.push(
      { role: "system", content: "Use concise prose." },
      { role: "user", content: "continue" },
    );
    await handleChatCompletion(ChatCompletionRequest.parse({ messages }), pool);
    expect(scripted.texts[1]).toContain("<system>\nUse concise prose.\n</system>");
  });
});

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
    const chunk = asObject(parseJson(payload));
    const choices = chunk.choices;
    const firstChoice = choices === undefined ? undefined : asArray(choices)[0];
    const deltaValue = firstChoice === undefined ? undefined : asObject(firstChoice).delta;
    const delta = deltaValue === undefined ? undefined : asObject(deltaValue);
    const c = delta?.content;
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
): Promise<{ contents: string[]; errors: JsonObject[] }> {
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
  const errors: JsonObject[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6);
    if (payload === "[DONE]") continue;
    const chunk = asObject(parseJson(payload));
    const choices = chunk.choices;
    const firstChoice = choices === undefined ? undefined : asArray(choices)[0];
    const deltaValue = firstChoice === undefined ? undefined : asObject(firstChoice).delta;
    const delta = deltaValue === undefined ? undefined : asObject(deltaValue);
    const c = delta?.content;
    if (typeof c === "string" && c.length > 0) contents.push(c);
    if (chunk.error !== undefined) errors.push(asObject(chunk.error));
  }
  return { contents, errors };
}

describe("priority-access exhaustion on the streaming path", () => {
  const REFUSAL =
    "You've used your available priority access to the Opus model for today. " +
    "You can choose another available model or wait until tomorrow to use the Opus model again.";
  function refusalDeltas(): string[] {
    const deltas = REFUSAL.match(/.{1,12}/g);
    if (deltas === null) throw new Error("Expected the refusal text to produce chunks");
    return deltas;
  }

  it("never leaks the refusal to the client as content", async () => {
    // Chunked the way M365 actually streams it — the gate must hold the head.
    const { contents } = await streamRaw(refusalDeltas());
    expect(contents.join("")).not.toContain("priority access");
    expect(contents.join("")).toBe("");
  });

  it("emits a machine-readable error chunk, not just prose", async () => {
    const { errors } = await streamRaw(refusalDeltas());
    expect(errors).toHaveLength(1);
    // A streaming client must be able to tell a quota wall from a transient
    // upstream blip without string-matching the message.
    const error = asObject(errors[0]);
    expect(error.code).toBe("priority_access_exhausted");
    expect(error.type).toBe("rate_limit_error");
    expect(asNumber(error.retry_after)).toBeGreaterThan(0);
  });

  it('still streams an ordinary answer that merely starts with "You"', async () => {
    const { contents, errors } = await streamRaw(["You", "r code ", "has a bug."]);
    expect(errors).toHaveLength(0);
    expect(contents.join("")).toBe("Your code has a bug.");
  });
});

describe("the only-the-first-call-ran note", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "bash",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    },
  ];
  const NOTE = "(Note: only the first tool call in your previous reply was actually run.";

  /** One conversation, several requests through the same pool. */
  async function converse(replies: string[]): Promise<string[]> {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = replies.map((fullText) => ({ fullText }));
    const pool = new SessionPool();
    const messages: RequestMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: `fix it ${Math.random()}` },
    ];
    for (let i = 0; i < replies.length; i++) {
      const res = await handleChatCompletion(
        ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, tools, messages }),
        pool,
      );
      const body = asObject(await responseJson(res));
      const message = objectAt(asArray(body.choices)[0], "message");
      const rawToolCalls = message.tool_calls;
      if (rawToolCalls === undefined) break;
      const toolCalls = asToolCalls(rawToolCalls);
      const firstToolCall = toolCalls[0];
      if (firstToolCall === undefined) throw new Error("Expected at least one tool call");
      messages.push({ role: "assistant", content: null, tool_calls: toolCalls }, {
        role: "tool",
        tool_call_id: firstToolCall.id,
        content: `real output ${i}`,
      });
    }
    scripted.queue = [];
    return scripted.texts;
  }

  it("tells the model, with the real result, that its invented tail never ran", async () => {
    const sent = await converse([
      '```bash\ncat config.json\n```\n\n<tool_response>\n{"port": 3000}\n</tool_response>\n\nThe bug is fixed.',
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
    expect(sent[1]).toContain(
      "only the first of the 2 tool calls in your previous reply was run; the other one was not",
    );
  });

  it("adds nothing when the whole reply ran", async () => {
    const sent = await converse(["```bash\nls\n```", "Done."]);
    expect(sent[1]).not.toContain("(Note:");
  });
});

describe("a reply that opens with a tool call and then writes an essay", () => {
  it("runs the opening call and tells the model its essay was written before the result", async () => {
    const tools = [
      {
        type: "function",
        function: {
          name: "bash",
          parameters: { type: "object", properties: { command: { type: "string" } } },
        },
      },
    ];
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [
      {
        fullText:
          "```bash\ncat config.json\n```\n\nThe file `config.json` doesn't exist in my environment, so here is how you could fix it yourself:\n\n## Steps\n\n```bash\nsed -i s/3000/8080/ config.json\n```\n\nThat's all.",
      },
      { fullText: "Done." },
    ];
    const pool = new SessionPool();
    const messages: RequestMessage[] = [{ role: "user", content: `essay ${Math.random()}` }];
    const firstResponse = await handleChatCompletion(
      ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, tools, messages }),
      pool,
    );
    const r1 = asObject(await responseJson(firstResponse));
    const firstMessage = objectAt(asArray(r1.choices)[0], "message");
    const rawToolCalls = firstMessage.tool_calls;
    const callValue = rawToolCalls === undefined ? undefined : asArray(rawToolCalls)[0];
    expect(callValue).toBeDefined();
    const call = asToolCall(callValue);
    expect(call).toBeDefined(); // the old guard returned the essay as text
    expect(asObject(parseJson(call.function.arguments)).command).toBe("cat config.json");
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: asToolCalls(rawToolCalls),
    }, { role: "tool", tool_call_id: call.id, content: '{"port": 3000}' });
    await handleChatCompletion(
      ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, tools, messages }),
      pool,
    );
    expect(scripted.texts[1]).toContain("was written before its result existed");
    expect(scripted.texts[1]).toContain('{"port": 3000}');
    scripted.queue = [];
  });
});

describe("an explicitly Throttled turn (result.value = Throttled)", () => {
  beforeEach(() => {
    vi.stubEnv("M365_NO_BACKOFF", "");
    vi.stubEnv("M365_NO_AUTO_REAUTH", "");
    vi.stubEnv("M365_THROTTLE_RETRY_AFTER_S", "");
    noteRequestOutcome(false, "throttle-test");
  });

  afterEach(() => {
    noteRequestOutcome(false, "throttle-test");
    vi.unstubAllEnvs();
    scripted.result = null;
  });

  // Verbatim from the Sep 28 dumps: no content frames, only this final result.
  const THROTTLED = {
    value: "Throttled",
    errorCode: "PerUserThrottled",
    message:
      "We're temporarily unable to respond to this volume of requests. Please try again later.",
  };

  it("fails fast with a 429 — no quick retries back into the throttle", async () => {
    scripted.deltas = [];
    scripted.fullText = "";
    scripted.result = THROTTLED;
    scripted.runs = 0;
    const body = ChatCompletionRequest.parse({
      model: "claude-sonnet",
      stream: false,
      messages: [{ role: "user", content: "hello throttled" }],
    });
    const res = await handleChatCompletion(body, new SessionPool());
    expect(res.status).toBe(429);
    const err = objectAt(await responseJson(res), "error");
    expect(err.type).toBe("rate_limit_error");
    expect(err.code).toBe("m365_throttled");
    expect(err.param).toBe("PerUserThrottled");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(asNumber(err.retry_after)).toBe(Number(res.headers.get("Retry-After")));
    expect(asString(err.message)).toContain("M365 provides no reset time");
    expect(scripted.runs).toBe(1); // the old path spent 3 attempts here
    scripted.result = null;
  });

  it("allows M365_THROTTLE_RETRY_AFTER_S to extend the local retry delay", async () => {
    scripted.deltas = [];
    scripted.fullText = "";
    scripted.result = THROTTLED;
    vi.stubEnv("M365_THROTTLE_RETRY_AFTER_S", "1800.2");
    try {
      const res = await handleChatCompletion(
        ChatCompletionRequest.parse({
          model: "claude-sonnet",
          messages: [{ role: "user", content: "hello throttled retry-after" }],
        }),
        new SessionPool(),
      );
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBe("1801");
      expect(asNumber(objectAt(await responseJson(res), "error").retry_after)).toBe(1801);
    } finally {
      scripted.result = null;
    }
  });

  it.each(["0", "-1", "NaN", "Infinity", "1"])(
    "does not shorten local backoff with override %s",
    async (override) => {
      scripted.deltas = [];
      scripted.fullText = "";
      scripted.result = THROTTLED;
      vi.stubEnv("M365_THROTTLE_RETRY_AFTER_S", override);
      const response = await handleChatCompletion(
        ChatCompletionRequest.parse({
          model: "claude-sonnet",
          messages: [{ role: "user", content: "invalid throttle retry delay" }],
        }),
        new SessionPool(),
      );
      expect(response.status).toBe(429);
      const delay = Number(response.headers.get("Retry-After"));
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThan(1);
      expect(asNumber(objectAt(await responseJson(response), "error").retry_after)).toBe(delay);
    },
  );

  it("carries the code through the streaming path as an error chunk", async () => {
    scripted.result = THROTTLED;
    scripted.runs = 0;
    const { contents, errors } = await streamRaw([], "");
    expect(contents).toHaveLength(0);
    expect(errors).toHaveLength(1);
    const error = asObject(errors[0]);
    expect(error.code).toBe("m365_throttled");
    expect(error.type).toBe("rate_limit_error");
    expect(error.param).toBe("PerUserThrottled");
    expect(asNumber(error.retry_after)).toBeGreaterThan(0);
    expect(scripted.runs).toBe(1);
    scripted.result = null;
  });
});

describe("Disengage retry keeps a model's <system>-free framing", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "bash",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    },
  ];
  async function disengageThenAnswer(model: string): Promise<string> {
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [
      { fullText: "", messageType: "Disengaged" },
      { fullText: "```bash\nls\n```" },
    ];
    const body = ChatCompletionRequest.parse({
      model,
      stream: false,
      tools,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: `do it ${model}` },
      ],
    });
    const res = await handleChatCompletion(body, new SessionPool());
    expect(res.status).toBe(200);
    expect(scripted.texts).toHaveLength(2);
    scripted.queue = [];
    return scripted.texts[1];
  }

  it("retries Sonnet 5 with relay again, never a <system>-tagged framing", async () => {
    const retry = await disengageThenAnswer("claude-sonnet-5");
    expect(retry).not.toContain("<system>");
    expect(retry).toContain("guide me through this from my terminal");
  });

  it("still retries the <system>-tagged defaults with softened (F22)", async () => {
    const retry = await disengageThenAnswer("gpt-5.5-think-deeper");
    expect(retry).toContain("<system>");
    expect(retry).toContain(
      "You are an automated coding agent working in a real working directory",
    );
  });
});

describe("which requests carry the tool agent (#41)", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "bash",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    },
  ];

  /** The `useAgent` flag the handler passed for one request on `model`. */
  async function agentFlagFor(model: string, withTools = true): Promise<boolean | undefined> {
    scripted.result = null;
    scripted.agentFlags = [];
    scripted.queue = [{ fullText: "```bash\nls\n```" }];
    const body = ChatCompletionRequest.parse({
      model,
      stream: false,
      ...(withTools ? { tools } : {}),
      messages: [{ role: "user", content: `list files ${model} ${Math.random()}` }],
    });
    const res = await handleChatCompletion(body, new SessionPool());
    expect(res.status).toBe(200);
    scripted.queue = [];
    expect(scripted.agentFlags).toHaveLength(1);
    return scripted.agentFlags[0];
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("sends gpt-6-think-deeper tool requests without the agent", async () => {
    expect(await agentFlagFor("gpt-6-think-deeper")).toBe(false);
  });

  it("still sends GPT-5.x tool requests with the agent", async () => {
    expect(await agentFlagFor("gpt-5.5-think-deeper")).toBe(true);
    expect(await agentFlagFor("m365-copilot")).toBe(true);
  });

  it("still sends Claude tool requests without it", async () => {
    expect(await agentFlagFor("claude-sonnet")).toBe(false);
    expect(await agentFlagFor("claude-opus-5[1m]")).toBe(false);
  });

  it("never attaches it to a request without tools", async () => {
    expect(await agentFlagFor("gpt-5.5-think-deeper", false)).toBe(false);
  });

  it("lets M365_FORCE_AGENT=1 put it back", async () => {
    vi.stubEnv("M365_FORCE_AGENT", "1");
    expect(await agentFlagFor("gpt-6-think-deeper")).toBe(true);
  });
});

describe("agent availability and prompt selection", () => {
  const tools = [
    {
      type: "function",
      function: { name: "bash", parameters: { properties: { command: { type: "string" } } } },
    },
    {
      type: "function",
      function: { name: "skill", parameters: { properties: { input: { type: "string" } } } },
    },
  ];

  afterEach(() => {
    scripted.agentId = undefined;
    scripted.queue = [];
    vi.unstubAllEnvs();
  });

  async function request(extra: Record<string, unknown> = {}) {
    scripted.result = null;
    scripted.texts = [];
    scripted.agentFlags = [];
    scripted.resolutions = 0;
    scripted.queue = [{ fullText: "```bash\nls\n```" }];
    const response = await handleChatCompletion(
      ChatCompletionRequest.parse({
        model: "gpt-5.5-think-deeper",
        tools,
        messages: [
          { role: "system", content: "sys" },
          { role: "user", content: "inspect project" },
        ],
        ...extra,
      }),
      new SessionPool(),
    );
    expect(response.status).toBe(200);
    return responseJson(response);
  }

  it("keeps the agent-backed baseline when resolution succeeds", async () => {
    await request();
    expect(scripted.resolutions).toBe(1);
    expect(scripted.texts[0]).toContain("execution core of an automated agent");
    expect(scripted.agentFlags).toEqual([true]);
  });

  it("selects GPT-aware relay when resolution returns no agent", async () => {
    scripted.agentId = null;
    await request();
    expect(scripted.resolutions).toBe(1);
    expect(scripted.texts[0]).toContain("guide me through this from my terminal");
    expect(scripted.texts[0]).toContain("Python code interpreter at /mnt/data");
    expect(scripted.texts[0]).not.toContain("<system>");
    expect(scripted.texts[0]).not.toContain("bash_tool");
    expect(scripted.agentFlags).toEqual([false]);
  });

  it("lets disable-agent take precedence over force-agent", async () => {
    vi.stubEnv("M365_DISABLE_AGENT", "1");
    vi.stubEnv("M365_FORCE_AGENT", "1");
    await request();
    expect(scripted.resolutions).toBe(0);
    expect(scripted.agentFlags).toEqual([false]);
    expect(scripted.texts[0]).toContain("guide me through this from my terminal");
  });

  it("still honors an explicit framing override", async () => {
    scripted.agentId = null;
    vi.stubEnv("M365_FRAMING_VARIANT", "dual_env_sys");
    await request();
    expect(scripted.texts[0]).toContain("<system>");
    expect(scripted.texts[0]).toContain("there are two environments");
    expect(scripted.texts[0]).toContain("Python code interpreter");
  });

  it("omits tools only from definitions and parses against the full request", async () => {
    vi.stubEnv("M365_TOOL_ALLOWLIST", "bash");
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [{ fullText: "```skill\nlookup\n```" }];
    const response = await handleChatCompletion(
      ChatCompletionRequest.parse({
        model: "gpt-5.5-think-deeper",
        tools,
        messages: [{ role: "user", content: "lookup" }],
      }),
      new SessionPool(),
    );
    const body = asObject(await responseJson(response));
    const message = objectAt(asArray(body.choices)[0], "message");
    const toolCall = asToolCall(asArray(message.tool_calls)[0]);
    expect(toolCall.function.name).toBe("skill");
    expect(scripted.texts[0]).not.toContain("```skill");
    expect(scripted.texts[0]).toContain("```bash");
  });

  it("includes a forced tool even when the configured list omits it", async () => {
    vi.stubEnv("M365_TOOL_ALLOWLIST", "bash");
    await request({ tool_choice: { type: "function", function: { name: "skill" } } });
    expect(scripted.texts[0]).toContain("```skill");
  });

  it("keeps relay and GPT sandbox wording on a Disengage retry without an agent", async () => {
    scripted.agentId = null;
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [
      { fullText: "", messageType: "Disengaged" },
      { fullText: "```bash\nls\n```" },
    ];
    const response = await handleChatCompletion(
      ChatCompletionRequest.parse({
        model: "gpt-5.5-think-deeper",
        tools,
        messages: [{ role: "user", content: "inspect" }],
      }),
      new SessionPool(),
    );
    expect(response.status).toBe(200);
    expect(scripted.texts).toHaveLength(2);
    expect(scripted.texts[1]).toContain("Python code interpreter");
    expect(scripted.texts[1]).not.toContain("<system>");
  });

  it("keeps user-voice tags on system messages introduced in a tool follow-up", async () => {
    scripted.agentId = null;
    scripted.result = null;
    scripted.texts = [];
    scripted.queue = [{ fullText: "```bash\nls\n```" }, { fullText: "Checked." }];
    const pool = new SessionPool();
    const messages = [{ role: "user", content: "inspect follow-up" }];
    await handleChatCompletion(
      ChatCompletionRequest.parse({ model: "gpt-5.5-think-deeper", tools, messages }),
      pool,
    );
    messages.push(
      { role: "system", content: "Use concise prose." },
      { role: "user", content: "continue" },
    );
    await handleChatCompletion(
      ChatCompletionRequest.parse({ model: "gpt-5.5-think-deeper", tools, messages }),
      pool,
    );
    expect(scripted.texts[1]).toContain(
      "<harness_system_prompt>\nUse concise prose.\n</harness_system_prompt>",
    );
    expect(scripted.texts[1]).not.toContain("<system>");
  });
});

describe("OpenAI response shape", () => {
  const bash = {
    name: "bash",
    parameters: { type: "object", properties: { command: { type: "string" } } },
  };

  function chunksOf(sse: string): JsonObject[] {
    return sse
      .split("\n")
      .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
      .map((line) => asObject(parseJson(line.slice(6))));
  }

  it("estimates token usage and carries system_fingerprint (non-stream)", async () => {
    scripted.result = null;
    scripted.fullText = "x".repeat(40);
    scripted.deltas = [scripted.fullText];
    const res = await handleChatCompletion(
      ChatCompletionRequest.parse({
        model: "claude-sonnet",
        messages: [{ role: "user", content: `${"y".repeat(80)} ${Math.random()}` }],
      }),
      new SessionPool(),
    );
    const body = asObject(await responseJson(res));
    const usage = asObject(body.usage);
    expect(body).toHaveProperty("system_fingerprint", null);
    expect(asObject(asArray(body.choices)[0])).toHaveProperty("logprobs", null);
    expect(asNumber(usage.completion_tokens)).toBe(10);
    expect(asNumber(usage.prompt_tokens)).toBeGreaterThan(20);
    expect(asNumber(usage.total_tokens)).toBe(
      asNumber(usage.prompt_tokens) + asNumber(usage.completion_tokens),
    );
    expect(usage.x_proxy_tokens_estimated).toBe(true);
  });

  it("puts estimated usage in the final include_usage chunk", async () => {
    scripted.result = null;
    scripted.fullText = "Hello there";
    scripted.deltas = ["Hello ", "there"];
    const res = await handleChatCompletion(
      ChatCompletionRequest.parse({
        stream: true,
        stream_options: { include_usage: true },
        model: "claude-sonnet",
        messages: [{ role: "user", content: `usage chunk ${Math.random()}` }],
      }),
      new SessionPool(),
    );
    const chunks = chunksOf(await res.text());
    expect(chunks.every((chunk) => chunk.system_fingerprint === null)).toBe(true);
    const last = chunks[chunks.length - 1];
    const usage = asObject(asObject(last).usage);
    expect(asNumber(usage.completion_tokens)).toBe(3);
    expect(asNumber(usage.prompt_tokens)).toBeGreaterThan(0);
  });

  it.each([false, true])(
    "answers a legacy `functions` request with function_call (stream=%s)",
    async (stream) => {
      scripted.result = null;
      scripted.queue = [{ fullText: "```bash\nls\n```" }];
      const res = await handleChatCompletion(
        ChatCompletionRequest.parse({
          model: "claude-sonnet",
          stream,
          functions: [bash],
          messages: [{ role: "user", content: `legacy ${stream} ${Math.random()}` }],
        }),
        new SessionPool(),
      );
      let finishReason: unknown;
      let toolCalls: unknown;
      let functionCall: unknown;
      let streamHasToolCalls = false;
      if (stream) {
        const chunks = chunksOf(await res.text());
        scripted.queue = [];
        const callChunk = chunks.find((chunk) => {
          const choices = chunk.choices;
          if (choices === undefined) return false;
          const firstChoice = asArray(choices)[0];
          if (firstChoice === undefined) return false;
          return objectAt(firstChoice, "delta").function_call !== undefined;
        });
        if (callChunk === undefined) throw new Error("Missing function-call stream chunk");
        const callDelta = objectAt(asArray(callChunk.choices)[0], "delta");
        functionCall = callDelta.function_call;
        streamHasToolCalls = chunks.some((chunk) => {
          const choices = chunk.choices;
          if (choices === undefined) return false;
          const firstChoice = asArray(choices)[0];
          if (firstChoice === undefined) return false;
          return objectAt(firstChoice, "delta").tool_calls !== undefined;
        });
        const lastChunk = asObject(chunks[chunks.length - 1]);
        finishReason = asObject(asArray(lastChunk.choices)[0]).finish_reason;
      } else {
        const body = asObject(await responseJson(res));
        scripted.queue = [];
        const choice = asObject(asArray(body.choices)[0]);
        const message = asObject(choice.message);
        finishReason = choice.finish_reason;
        toolCalls = message.tool_calls;
        functionCall = message.function_call;
      }
      const call = asObject(functionCall);
      expect(finishReason).toBe("function_call");
      expect(toolCalls).toBeUndefined();
      expect(call.name).toBe("bash");
      expect(asObject(parseJson(asString(call.arguments))).command).toBe("ls");
      expect(streamHasToolCalls).toBe(false);
    },
  );
});
