import { afterEach, describe, expect, it, vi } from "vitest";

const scripted = vi.hoisted(() => ({
  calls: 0, text: "Synthetic answer", messageType: null as string | null,
  result: { value: "Success" } as { value: string; errorCode?: string; message?: string },
  sent: [] as string[], models: [] as string[],
  outcomes: vi.fn(), priorityWall: vi.fn(),
  results: [] as Array<{ value: string; errorCode?: string; message?: string }>,
  messages: [] as Array<string | null>, abortedRoute: vi.fn(),
}));
vi.mock("@m365-copilot/core", async (load) => {
  const actual = await load<typeof import("@m365-copilot/core")>();
  return {
    ...actual, awaitDegradationBackoff: async () => {}, noteRequestOutcome: scripted.outcomes,
    notePriorityAccessExhausted: scripted.priorityWall, activePriorityAccessExhaustion: () => null,
    noteAgentRouteDead: scripted.abortedRoute,
    awaitTurnBudget: async () => ({ waitedMs: 0 }),
    withAccountContext: async (_options: unknown, run: (key: string) => Promise<Response>) => run("synthetic-principal"),
    ModelSession: class {
      turnCount = 0; conversationId = "synthetic-conversation";
      newConversation() { this.turnCount = 0; this.conversationId += "-new"; }
      reset() {} async refreshAgent() { return false; }
      async run(text: string, model: string) {
        scripted.calls++; scripted.sent.push(text); scripted.models.push(model); this.turnCount++;
        const result = scripted.results.shift() ?? scripted.result;
        const messageType = scripted.messages.length ? scripted.messages.shift() : scripted.messageType;
        return {
          fullText: scripted.text, hasContent: scripted.text.length > 0,
          result, messageType, images: [],
          throttle: { current: 1, max: 600 }, contentOrigin: "synthetic", scores: null,
          turnCount: this.turnCount, metering: null,
          async *[Symbol.asyncIterator]() { if (scripted.text) yield scripted.text; },
        };
      }
    },
  };
});
const { SessionPool, handleChatCompletion, ChatCompletionRequest } = await import("./index.js");
const tools = [{ type: "function", function: { name: "bash", description: "Synthetic shell", parameters: { type: "object", properties: { command: { type: "string" } } } } }];
afterEach(() => {
  vi.useRealTimers(); scripted.calls = 0; scripted.text = "Synthetic answer";
  scripted.result = { value: "Success" }; scripted.messageType = null; scripted.sent = [];
  scripted.models = []; scripted.results = []; scripted.messages = []; vi.clearAllMocks(); vi.unstubAllEnvs();
});
async function request(stream: boolean, withTools = false, pool = new SessionPool(), messages = [{ role: "user", content: "Synthetic question" }], model = "claude-sonnet") {
  const body = ChatCompletionRequest.parse({ model, stream, messages, ...(withTools ? { tools } : {}), stream_options: { include_usage: true } });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = handleChatCompletion(body, pool).then(async (response) => ({ status: response.status, headers: response.headers, body: await response.text() }));
  await vi.runAllTimersAsync();
  return pending;
}
interface Frame {
  error?: { type: string; code: string; retryable: boolean; m365_error_code?: string; param?: string };
  choices?: Array<{ delta?: { content?: string } }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number; x_m365_usage_estimated: boolean; x_m365_usage_basis: string; x_m365_conversation_max: number };
}
function frames(text: string): Frame[] {
  return text.split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
}

describe("terminal refusal contract", () => {
  for (const [upstream, code, modelScoped] of [
    ["PremiumModelUnavailableForLicense", "m365_model_not_licensed", true],
    ["ClaudeUnavailableForLicense", "m365_model_not_licensed", true],
    ["InvalidCopilotLicense", "m365_account_not_licensed", false],
    ["UnknownDenial", "m365_forbidden", false],
  ] as const) {
    for (const stream of [false, true]) it(`${upstream} stream=${stream} is terminal, scoped and never an answer`, async () => {
      scripted.result = { value: "ForbiddenRequest", errorCode: upstream, message: "synthetic-private-upstream-detail" };
      scripted.text = "";
      const result = await request(stream);
      const error = stream ? frames(result.body).find((frame) => frame.error)?.error : JSON.parse(result.body).error;
      expect(result.status).toBe(stream ? 200 : 403);
      expect(scripted.calls).toBe(1);
      expect(error).toMatchObject({ type: "permission_error", code, retryable: false, m365_error_code: upstream });
      expect(error.param).toBe(modelScoped ? "claude-sonnet" : undefined);
      expect(result.body).not.toContain("synthetic-private-upstream-detail");
      if (!stream) expect(result.headers.get("x-should-retry")).toBe("false");
      else {
        expect(frames(result.body).filter((frame) => frame.error)).toHaveLength(1);
        expect(frames(result.body).flatMap((frame) => frame.choices ?? []).filter((choice) => choice.delta?.content)).toHaveLength(0);
        expect(result.body.match(/data: \[DONE\]/g)).toHaveLength(1);
      }
    });
  }
  it("explicit throttle is nonretryable without invented Retry-After", async () => {
    scripted.text = ""; scripted.result = { value: "Throttled", errorCode: "PerUserThrottled" };
    const response = await request(false);
    expect(response.status).toBe(429); expect(response.headers.get("x-should-retry")).toBe("false");
    expect(response.headers.has("retry-after")).toBe(false);
    expect(JSON.parse(response.body).error).toMatchObject({ code: "m365_throttled", retryable: false });
    expect(scripted.calls).toBe(1);
  });
  it("Disengaged never triggers automatic softened prompting even with tools", async () => {
    scripted.text = ""; scripted.messageType = "Disengaged";
    const response = await request(false, true);
    expect(response.status).toBe(403); expect(scripted.calls).toBe(1);
    expect(JSON.parse(response.body).error).toMatchObject({ code: "m365_request_declined", retryable: false });
  });
  it("exhausted ordinary empty retries cannot be multiplied by SDK retries", async () => {
    scripted.text = "";
    const response = await request(false);
    expect(response.status).toBe(502); expect(scripted.calls).toBe(3);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(JSON.parse(response.body).error.retryable).toBe(false);
  });
});

describe("additional terminal boundaries", () => {
  it("streaming usage is opt-in while JSON usage is always present", async () => {
    const body = ChatCompletionRequest.parse({ model: "claude-sonnet", stream: true, messages: [{ role: "user", content: "synthetic" }] });
    const response = await handleChatCompletion(body, new SessionPool());
    expect(frames(await response.text()).some(frame => frame.usage)).toBe(false);
  });
  for (const errorCode of [undefined, "bad-code secret", "A".repeat(129)]) {
    it(`omitted or unsafe ForbiddenRequest code stays generic (${errorCode?.length ?? 0})`, async () => {
      scripted.result = { value: "ForbiddenRequest", ...(errorCode ? { errorCode } : {}), message: "synthetic-private-upstream-detail" };
      scripted.text = "";
      const response = await request(false);
      expect(JSON.parse(response.body).error).toMatchObject({ code: "m365_forbidden", retryable: false });
      expect(JSON.parse(response.body).error).not.toHaveProperty("m365_error_code");
      expect(JSON.parse(response.body).error).not.toHaveProperty("param");
      expect(scripted.calls).toBe(1);
      expect(response.body).not.toContain("synthetic-private-upstream-detail");
    });
  }
  it("a late final refusal does not append a success finish to already emitted content", async () => {
    scripted.result = { value: "ForbiddenRequest", errorCode: "ClaudeUnavailableForLicense" };
    scripted.text = "Already emitted incremental answer bytes cannot be retracted.";
    const response = await request(true);
    expect(frames(response.body).filter(frame => frame.error)).toHaveLength(1);
    expect(response.body).not.toContain('"finish_reason":"stop"');
    expect(scripted.calls).toBe(1);
  });
});

describe("authoritative terminal result precedence", () => {
  for (const stream of [false, true]) {
    for (const [value, code, status] of [
      ["Throttled", "m365_throttled", 429],
      ["ForbiddenRequest", "m365_model_not_licensed", 403],
      ["OutOfCredits", "priority_access_exhausted", 429],
    ] as const) it(`${value} beats Disengaged stream=${stream} with authoritative bookkeeping`, async () => {
      vi.stubEnv("M365_OPUS_FALLBACK_MODEL", "");
      scripted.text = ""; scripted.messageType = "Disengaged";
      scripted.result = { value, errorCode: value === "ForbiddenRequest" ? "ClaudeUnavailableForLicense" : "PerUserThrottled" };
      const response = await request(stream, true, new SessionPool(), undefined, "claude-opus");
      const error = stream ? frames(response.body).find(frame => frame.error)?.error : JSON.parse(response.body).error;
      expect(response.status).toBe(stream ? 200 : status);
      expect(error).toMatchObject({ code });
      expect(scripted.calls).toBe(1);
      expect(response.body).not.toContain('"finish_reason":"stop"');
      if (value === "Throttled") {
        expect(error).toMatchObject({ retryable: false });
        expect(scripted.outcomes.mock.calls).toEqual([[true, "synthetic-conversation"]]);
        expect(response.headers.has("retry-after")).toBe(false);
        expect(error).not.toHaveProperty("retry_after");
        if (!stream) expect(response.headers.get("x-should-retry")).toBe("false");
        expect(scripted.priorityWall).not.toHaveBeenCalled();
      } else if (value === "OutOfCredits") {
        expect(scripted.priorityWall).toHaveBeenCalledExactlyOnceWith("opus", expect.objectContaining({ window: "day", resetsAt: expect.any(Date) }));
        expect(scripted.outcomes.mock.calls).toEqual([[false, "synthetic-conversation"]]);
      } else expect(scripted.outcomes).not.toHaveBeenCalled();
    });
    it(`account throttle never takes configured model fallback stream=${stream}`, async () => {
      vi.stubEnv("M365_OPUS_FALLBACK_MODEL", "claude-opus-4.8");
      scripted.text = ""; scripted.messageType = "Disengaged"; scripted.result = { value: "Throttled" };
      const response = await request(stream, true, new SessionPool(), undefined, "claude-opus");
      expect(response.body).toContain("m365_throttled");
      expect(scripted.models).toEqual(["claude-opus"]);
      expect(scripted.outcomes.mock.calls).toEqual([[true, "synthetic-conversation"]]);
    });
    it(`OutOfCredits retains configured fallback despite Disengaged stream=${stream}`, async () => {
      vi.stubEnv("M365_OPUS_FALLBACK_MODEL", "claude-opus-4.8");
      scripted.text = ""; scripted.results = [{ value: "OutOfCredits" }, { value: "ForbiddenRequest" }];
      scripted.messages = ["Disengaged", null];
      const response = await request(stream, true, new SessionPool(), undefined, "claude-opus");
      expect(scripted.models).toEqual(["claude-opus", "claude-opus-4.8"]);
      expect(scripted.priorityWall).toHaveBeenCalledOnce();
      expect(response.body).toContain("m365_forbidden");
    });
    it(`non-authoritative refusal prose cannot enable fallback past Disengaged stream=${stream}`, async () => {
      vi.stubEnv("M365_OPUS_FALLBACK_MODEL", "claude-opus-4.8");
      scripted.text = "You've used your available priority access to the Opus model for today.";
      scripted.messageType = "Disengaged";
      const response = await request(stream, true, new SessionPool(), undefined, "claude-opus");
      expect(response.body).toContain("m365_request_declined");
      expect(scripted.models).toEqual(["claude-opus"]);
      expect(scripted.priorityWall).not.toHaveBeenCalled();
    });
    it(`Disengaged blocks InternalError recovery stream=${stream}`, async () => {
      scripted.text = ""; scripted.messageType = "Disengaged"; scripted.result = { value: "InternalError" };
      const response = await request(stream, true, new SessionPool(), undefined, "gpt-6-sol");
      expect(response.body).toContain("m365_request_declined");
      expect(scripted.calls).toBe(1); expect(scripted.abortedRoute).not.toHaveBeenCalled();
    });
    it(`throttle bookkeeping uses the current conversation after recovery stream=${stream}`, async () => {
      scripted.text = ""; scripted.results = [{ value: "InternalError" }, { value: "Throttled" }];
      scripted.messages = [null, "Disengaged"];
      const response = await request(stream);
      expect(response.body).toContain("m365_throttled");
      expect(scripted.calls).toBe(2);
      expect(scripted.outcomes.mock.calls).toEqual([[true, "synthetic-conversation-new"]]);
    });
  }
});

describe("labeled visible-context usage", () => {
  for (const stream of [false, true]) for (const withTools of [false, true]) {
    it(`nonempty output stream=${stream} tools=${withTools} has honest estimates`, async () => {
      scripted.text = withTools ? "```bash\nls\n```" : "Synthetic answer";
      const response = await request(stream, withTools);
      const usage = stream ? frames(response.body).find((frame) => frame.usage)?.usage : JSON.parse(response.body).usage;
      expect(usage.prompt_tokens).toBeGreaterThan(0); expect(usage.completion_tokens).toBeGreaterThan(0);
      expect(usage.total_tokens).toBe(usage.prompt_tokens + usage.completion_tokens);
      expect(usage.x_m365_usage_estimated).toBe(true);
      expect(usage.x_m365_usage_basis).toBe("visible_context_chars_div_4");
      expect(usage).not.toHaveProperty("completion_tokens_details");
      expect(usage.x_m365_conversation_max).toBe(600);
    });
  }
  it("prompt estimate accounts for full history rather than only continuation delta", async () => {
    const pool = new SessionPool(); const opener = "Synthetic question".repeat(200);
    const first = await request(false, false, pool, [{ role: "user", content: opener }]);
    const second = await request(false, false, pool, [{ role: "user", content: opener }, { role: "assistant", content: "Synthetic answer" }, { role: "user", content: "next" }]);
    expect(scripted.sent[1]).not.toContain(opener);
    expect(JSON.parse(second.body).usage.prompt_tokens).toBeGreaterThan(JSON.parse(first.body).usage.prompt_tokens);
  });
});
