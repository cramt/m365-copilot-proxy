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
  queue: Array<{ fullText: string; messageType?: string | null; result?: { value: string; errorCode?: string; message?: string }; metering?: Record<string, number> }>;
  agentId?: string | null;
  resolutions: number;
  /** The model argument of every run() call, in order. */
  models: string[];
  /** The `useAgent` argument of every run() call, in order. */
  agentFlags: Array<boolean | undefined>;
  /** How many times the handler rotated to a fresh conversation. */
  newConversations: number;
} = {
  deltas: [],
  runs: 0,
  texts: [],
  queue: [],
  models: [],
  agentFlags: [],
  resolutions: 0,
  newConversations: 0,
};

vi.mock("@m365-copilot/core", async (importActual) => {
  const actual = await importActual<typeof import("@m365-copilot/core")>();
  class FakeModelSession {
    turnCount = 0;
    sessionId = "session-test";
    conversationId = "conv-test";
    reset() {}
    newConversation() {
      this.conversationId = "conv-test-2";
      this.turnCount = 0;
      scripted.newConversations++;
    }
    refreshAgent() {
      return Promise.resolve(false);
    }
    resolveAgent() {
      scripted.resolutions++;
      return Promise.resolve(scripted.agentId === undefined ? "agent-test" : scripted.agentId);
    }
    run(text: string, model?: string, _signal?: AbortSignal, useAgent?: boolean) {
      scripted.models.push(model ?? "");
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
        result: next?.result ?? scripted.result ?? { value: "Success" },
        metering: next?.metering ?? null,
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
const { noteRequestOutcome, resetAgentRoutes, resetPriorityAccessState } = await import("@m365-copilot/core");
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
        asObject(parseJson(headerValue(completedResponse, "x-proxy-usage")))
          .x_m365_conversation_remaining,
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


// The proxy remembers a priority-access wall for the process (until the reset);
// don't let one test's refusal 429 the next test's Opus request.
afterEach(() => resetPriorityAccessState());

/** One request on a fresh pool with a fake clock: an empty upstream turn makes
 *  the handler wait 2 s before each quick retry, and that wait is the handler's
 *  own pacing, not what these tests check. */
async function respond(body: ReturnType<typeof ChatCompletionRequest.parse>): Promise<Response> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const pending = handleChatCompletion(body, new SessionPool());
    await vi.runAllTimersAsync();
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

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
      messages.push(
        { role: "assistant", content: null, tool_calls: toolCalls },
        {
          role: "tool",
          tool_call_id: firstToolCall.id,
          content: `real output ${i}`,
        },
      );
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

  it("names the tool on a follow-up turn, though the tool message carries no name (#50)", async () => {
    // Like pi: the result names its call only by tool_call_id.
    const sent = await converse(["```bash\nls\n```", "Done."]);
    expect(sent[1]).toMatch(/<tool_response name="bash" call_id="[^"]+">\nreal output 0\n<\/tool_response>/);
    expect(sent[1]).not.toContain('name="unknown"');
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
    messages.push(
      {
        role: "assistant",
        content: null,
        tool_calls: asToolCalls(rawToolCalls),
      },
      { role: "tool", tool_call_id: call.id, content: '{"port": 3000}' },
    );
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
    expect(retry).toContain("guide me through this from my terminal, one command at a time");
    expect(retry).not.toContain("put as much as you can into one block");
  });

  it("sends Opus, Sonnet 4.6 and GPT-6 relay_batch on the first try and keeps it on the retry (§24, §25)", async () => {
    for (const model of ["claude-opus-4.5", "claude-opus", "claude-sonnet", "gpt-6-think-deeper"]) {
      const retry = await disengageThenAnswer(model);
      expect(scripted.texts[0]).toContain("put as much as you can into one block");
      expect(scripted.texts[0]).not.toContain("<system>");
      expect(retry).toContain("put as much as you can into one block");
    }
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

  it("still sends Claude Sonnet tool requests without it", async () => {
    expect(await agentFlagFor("claude-sonnet")).toBe(false);
    expect(await agentFlagFor("claude-sonnet-5")).toBe(false);
  });

  it("sends both Opus models' tool requests with it (§24)", async () => {
    expect(await agentFlagFor("claude-opus")).toBe(true);
    expect(await agentFlagFor("claude-opus-5[1m]")).toBe(true);
    expect(await agentFlagFor("claude-opus-4.5")).toBe(true);
  });

  it("never attaches it to a request without tools", async () => {
    expect(await agentFlagFor("gpt-5.5-think-deeper", false)).toBe(false);
    expect(await agentFlagFor("claude-opus", false)).toBe(false);
  });

  it("…except for Opus 4.5, which isn't served without it", async () => {
    expect(await agentFlagFor("claude-opus-4.5", false)).toBe(true);
  });

  it("lets M365_FORCE_AGENT=1 put it back", async () => {
    vi.stubEnv("M365_FORCE_AGENT", "1");
    expect(await agentFlagFor("gpt-6-think-deeper")).toBe(true);
  });

  it("lets M365_FORCE_AGENT=0 take it away", async () => {
    vi.stubEnv("M365_FORCE_AGENT", "0");
    expect(await agentFlagFor("gpt-5.5-think-deeper")).toBe(false);
  });
});

describe("GPT-6 Sol: agent on premium, learned fallback on non-premium (#23)", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "bash",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    },
  ];
  const DEAD = { fullText: "", result: { value: "InternalError" } };
  const CALL = { fullText: "```bash\nls\n```" };

  async function send(model = "gpt-6-sol") {
    scripted.result = null;
    scripted.texts = [];
    scripted.agentFlags = [];
    scripted.newConversations = 0;
    const body = ChatCompletionRequest.parse({
      model,
      stream: false,
      tools,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: `list files ${Math.random()}` },
      ],
    });
    return respond(body);
  }

  afterEach(() => {
    resetAgentRoutes();
    scripted.queue = [];
    vi.unstubAllEnvs();
  });

  it("sends the agent first and keeps it when it serves (premium)", async () => {
    scripted.queue = [CALL];
    const res = await send();
    expect(res.status).toBe(200);
    expect(scripted.agentFlags).toEqual([true]);
    expect(scripted.newConversations).toBe(0);
  });

  it("on the dead route, re-sends the full prompt agent-less in a fresh conversation", async () => {
    scripted.queue = [DEAD, CALL];
    const res = await send();
    expect(res.status).toBe(200);
    const body = asObject(await responseJson(res));
    const choice = asArray(body.choices)[0];
    expect(asToolCalls(objectAt(choice, "message").tool_calls)).toHaveLength(1);
    expect(scripted.agentFlags).toEqual([true, false]);
    expect(scripted.newConversations).toBe(1);
    // The retry is the whole request, not a "Please continue." into nothing.
    expect(scripted.texts[1]).toContain("list files");
    expect(scripted.texts[1]).toContain("Python code interpreter at /mnt/data");
    expect(scripted.texts[1]).toContain("```bash");
  });

  it("remembers it: the next request goes agent-less from the start", async () => {
    scripted.queue = [DEAD, CALL];
    await send();
    scripted.queue = [CALL];
    await send();
    expect(scripted.agentFlags).toEqual([false]);
    expect(scripted.newConversations).toBe(0);
  });

  it("treats InternalError as a transient once the agent has answered (premium, §23)", async () => {
    scripted.queue = [CALL];
    await send(); // the agent answered: this account is premium
    scripted.queue = [DEAD, CALL];
    const res = await send();
    expect(res.status).toBe(200);
    // No fresh conversation, no agent-less switch: the ordinary empty-reply retry.
    expect(scripted.newConversations).toBe(0);
    expect(scripted.agentFlags).toEqual([true, true]);
    expect(scripted.texts[1]).toBe("Please continue.");
    scripted.queue = [CALL];
    await send();
    expect(scripted.agentFlags).toEqual([true]);
  });

  it("doesn't touch tones outside PREMIUM_ONLY_AGENT_TONES", async () => {
    scripted.queue = [DEAD, CALL];
    const res = await send("gpt-5.5-think-deeper");
    expect(res.status).toBe(200);
    expect(scripted.newConversations).toBe(0);
    expect(scripted.agentFlags[1]).toBe(true);
  });

  it("doesn't fall back under M365_FORCE_AGENT=1", async () => {
    vi.stubEnv("M365_FORCE_AGENT", "1");
    scripted.queue = [DEAD, CALL];
    await send();
    expect(scripted.newConversations).toBe(0);
    expect(scripted.agentFlags).toEqual([true, true]);
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

describe("Opus 4.5 on an account that can't serve it (§24)", () => {
  const DEAD = { fullText: "", result: { value: "InternalError" } };

  afterEach(() => {
    resetAgentRoutes();
    scripted.queue = [];
  });

  it("says the model is premium-only instead of 'empty response', and never goes agent-less", async () => {
    scripted.result = null;
    scripted.agentFlags = [];
    scripted.newConversations = 0;
    scripted.queue = [DEAD, DEAD, DEAD];
    const body = ChatCompletionRequest.parse({
      model: "claude-opus-4.5", stream: false,
      messages: [{ role: "user", content: `hello ${Math.random()}` }],
    });
    const res = await respond(body);
    expect(res.status).toBe(502);
    const err = asObject(asObject(await responseJson(res)).error);
    expect(err.code).toBe("model_route_unavailable");
    expect(err.message).toContain("premium");
    // Agent-less is a dead route too, so there is nothing to fall back to.
    expect(scripted.agentFlags).toEqual([true, true, true]);
    expect(scripted.newConversations).toBe(0);
  });

  it("keeps the generic message for other models' empty InternalErrors", async () => {
    scripted.result = null;
    scripted.queue = [DEAD, DEAD, DEAD];
    const body = ChatCompletionRequest.parse({
      model: "claude-opus", stream: false,
      messages: [{ role: "user", content: `hello ${Math.random()}` }],
    });
    const res = await respond(body);
    expect(res.status).toBe(502);
    expect(asObject(asObject(await responseJson(res)).error).type).toBe("upstream_empty_response");
  });
});

describe("Priority access (Opus 5.5, Sonnet 5.5): OutOfCredits, remembering it, metering, the opt-in fallback (#18)", () => {
  const tools = [{ type: "function", function: { name: "bash", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
  const WEEKLY = "You\u2019ve used your available priority access to the Opus model for the week. You can choose another available model or wait until Monday to use the Opus model again.";
  const REFUSAL = { fullText: WEEKLY, result: { value: "OutOfCredits", message: WEEKLY } };
  const CALL = { fullText: "```bash\nls\n```", metering: { ClaudeOpusQueryDaily: 12, ClaudeOpusQuery75: 30 } };

  async function send(model = "claude-opus", content = `list files ${Math.random()}`, stream = false) {
    scripted.result = null;
    scripted.texts = [];
    scripted.models = [];
    scripted.agentFlags = [];
    scripted.newConversations = 0;
    const body = ChatCompletionRequest.parse({
      model, stream, tools,
      messages: [{ role: "system", content: "sys" }, { role: "user", content }],
    });
    return handleChatCompletion(body, pool);
  }
  let pool = new SessionPool();

  afterEach(() => {
    resetPriorityAccessState();
    scripted.queue = [];
    delete process.env.M365_OPUS_FALLBACK_MODEL;
    delete process.env.M365_SONNET_FALLBACK_MODEL;
    pool = new SessionPool();
  });

  it("surfaces the Opus allowances left in usage", async () => {
    scripted.queue = [CALL];
    const res = await send();
    const usage = asObject(asObject(await responseJson(res)).usage);
    expect(usage.x_m365_opus_daily_remaining).toBe(12);
    expect(usage.x_m365_opus_weekly_remaining).toBe(30);
  });

  it("429s an OutOfCredits turn with the weekly reset", async () => {
    scripted.queue = [REFUSAL];
    const res = await send();
    expect(res.status).toBe(429);
    const err = asObject(asObject(await responseJson(res)).error);
    expect(err.code).toBe("priority_access_exhausted");
    expect(err.param).toBe("week");
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("then answers later metered Opus requests itself, without an M365 turn", async () => {
    scripted.queue = [REFUSAL];
    await send();
    const res = await send("claude-opus", "another task");
    expect(res.status).toBe(429);
    expect(scripted.models).toEqual([]); // nothing sent upstream
    // Opus 4.5 isn't metered, so it is unaffected.
    scripted.queue = [CALL];
    expect((await send("claude-opus-4.5", "third task")).status).toBe(200);
    expect(scripted.models).toEqual(["claude-opus-4.5"]);
  });

  it("with M365_OPUS_FALLBACK_MODEL, re-sends the whole request to it in a fresh conversation", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.5";
    scripted.queue = [REFUSAL, { fullText: "```bash\nls\n```" }];
    const res = await send();
    expect(res.status).toBe(200);
    const json = asObject(await responseJson(res));
    expect(objectAt(asArray(json.choices)[0], "message").tool_calls).toHaveLength(1);
    expect(json.model).toBe("claude-opus-4.5"); // says who answered
    expect(scripted.models).toEqual(["claude-opus", "claude-opus-4.5"]);
    expect(scripted.newConversations).toBe(1);
    expect(scripted.agentFlags).toEqual([true, true]);
    expect(scripted.texts[1]).toContain("list files"); // the whole request, not a delta
    expect(scripted.texts[1]).toContain("/home/claude");
  });

  it("…and routes the next requests straight to the fallback until the reset", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.5";
    scripted.queue = [REFUSAL, { fullText: "```bash\nls\n```" }];
    await send();
    scripted.queue = [{ fullText: "```bash\npwd\n```" }];
    const res = await send("claude-opus", "another task");
    expect(res.status).toBe(200);
    expect(scripted.models).toEqual(["claude-opus-4.5"]);
  });

  it("starts a fresh conversation when an ongoing Opus 5.5 conversation moves to the fallback", async () => {
    scripted.queue = [CALL];
    await send("claude-opus", "long task");          // turn 1 served by Opus 5.5
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.5";
    scripted.queue = [REFUSAL, { fullText: "Done." }];
    // the client continues the same conversation with a tool result
    scripted.texts = []; scripted.models = []; scripted.newConversations = 0;
    const body = ChatCompletionRequest.parse({
      model: "claude-opus", stream: false, tools,
      messages: [
        { role: "system", content: "sys" }, { role: "user", content: "long task" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{\"command\":\"ls\"}" } }] },
        { role: "tool", tool_call_id: "c1", content: "a.txt" },
      ],
    });
    const res = await handleChatCompletion(body, pool);
    expect(res.status).toBe(200);
    expect(scripted.models).toEqual(["claude-opus", "claude-opus-4.5"]);
    expect(scripted.texts[1]).toContain("long task");   // full history for the new model
    expect(scripted.texts[1]).toContain("a.txt");
  });

  it("never falls back for an unmetered model's refusal text", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.5";
    scripted.queue = [{ fullText: WEEKLY }];
    const res = await send("gpt-5.5-think-deeper");
    expect(res.status).toBe(429);
    expect(scripted.models).toEqual(["gpt-5.5-think-deeper"]);
  });

  it("falls back on the streaming path too, without leaking the refusal", async () => {
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.5";
    scripted.queue = [REFUSAL, { fullText: "Hello from 4.5" }];
    scripted.result = null; scripted.models = [];
    const body = ChatCompletionRequest.parse({ model: "claude-opus", stream: true, messages: [{ role: "user", content: `hi ${Math.random()}` }] });
    const res = await handleChatCompletion(body, pool);
    const text = await res.text();
    expect(text).toContain("Hello from 4.5");
    expect(text).not.toContain("priority access");
    expect(scripted.models).toEqual(["claude-opus", "claude-opus-4.5"]);
  });

  // Sonnet 5.5 has a budget of its own (§26): ClaudeSonnet55QueryDaily/Weekly.
  const SONNET_DAILY = "You\u2019ve used your available priority access to the Sonnet model for today. You can choose another available model or wait until tomorrow to use the Sonnet model again.";
  const SONNET_REFUSAL = { fullText: SONNET_DAILY, result: { value: "OutOfCredits", message: SONNET_DAILY } };

  it("surfaces Sonnet 5.5's allowances in usage, next to Opus's", async () => {
    scripted.queue = [{ fullText: "```bash\nls\n```", metering: { ClaudeOpusQueryDaily: 12, ClaudeOpusQuery75: 30, ClaudeSonnet55QueryDaily: 79, ClaudeSonnet55QueryWeekly: 149 } }];
    const usage = asObject(asObject(await responseJson(await send("claude-sonnet-5.5"))).usage);
    expect(usage.x_m365_sonnet55_daily_remaining).toBe(79);
    expect(usage.x_m365_sonnet55_weekly_remaining).toBe(149);
    expect(usage.x_m365_opus_daily_remaining).toBe(12);
  });

  it("keeps the Sonnet 5.5 and Opus walls apart", async () => {
    scripted.queue = [SONNET_REFUSAL];
    const res = await send("claude-sonnet-5.5");
    expect(res.status).toBe(429);
    expect(asObject(asObject(await responseJson(res)).error).param).toBe("day");
    // Sonnet 5.5 is answered locally until the reset…
    expect((await send("claude-sonnet-5.5", "another task")).status).toBe(429);
    expect(scripted.models).toEqual([]);
    // …while Opus 5.5, Sonnet 5 and Sonnet 4.6 still go upstream.
    for (const model of ["claude-opus", "claude-sonnet-5", "claude-sonnet"]) {
      scripted.queue = [CALL];
      expect((await send(model, `task for ${model}`)).status).toBe(200);
      expect(scripted.models).toEqual([model]);
    }
  });

  it("with M365_SONNET_FALLBACK_MODEL, re-sends a Sonnet 5.5 request to it", async () => {
    process.env.M365_SONNET_FALLBACK_MODEL = "claude-sonnet-5";
    process.env.M365_OPUS_FALLBACK_MODEL = "claude-opus-4.5"; // the other budget's, unused here
    scripted.queue = [SONNET_REFUSAL, { fullText: "```bash\nls\n```" }];
    const res = await send("claude-sonnet-5.5");
    expect(res.status).toBe(200);
    expect(asObject(await responseJson(res)).model).toBe("claude-sonnet-5");
    expect(scripted.models).toEqual(["claude-sonnet-5.5", "claude-sonnet-5"]);
    expect(scripted.agentFlags).toEqual([false, false]);
  });

  it("remembers an unexpected OutOfCredits under that model alone", async () => {
    scripted.queue = [{ fullText: "Out of credits.", result: { value: "OutOfCredits", message: "Out of credits." } }];
    expect((await send("gpt-6-sol")).status).toBe(429);
    expect((await send("gpt-6-sol", "again")).status).toBe(429);
    expect(scripted.models).toEqual([]);
    scripted.queue = [CALL];
    expect((await send("claude-opus", "opus task")).status).toBe(200);
  });
});
