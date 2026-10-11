import { beforeEach, afterEach, expect, it, vi } from "vitest";

type MockMessage = {
  role: string;
  content?: string | Array<{ text?: string }> | null;
};
type MockResult = { value: string; errorCode?: string; message?: string };

const state = vi.hoisted(() => ({
  runs: 0,
  texts: [] as string[],
  result: ((): MockResult => ({ value: "Success" }))(),
  outcomes: [] as boolean[],
}));

vi.mock("@m365-copilot/core", () => {
  const content = (message: MockMessage) =>
    typeof message.content === "string"
      ? message.content
      : (message.content ?? []).map((part) => part.text || "").join("");

  class ModelSession {
    turnCount = 0;
    sessionId = "synthetic-session";
    conversationId = "synthetic-conversation";
    reset() {
      this.turnCount = 0;
    }
    newConversation() {
      this.turnCount = 0;
    }
    resolveAgent() {
      return Promise.resolve(null);
    }
    refreshAgent() {
      return Promise.resolve(false);
    }
    run(text: string) {
      state.runs++;
      state.texts.push(text);
      this.turnCount++;
      return Promise.resolve({
        fullText: "Synthetic response.",
        hasContent: true,
        result: { ...state.result },
        images: [],
        throttle: { current: 1, max: 600 },
        metering: null,
        contentOrigin: "Synthetic",
        messageType: null,
        messageId: "synthetic-message",
        scores: null,
        turnCount: 1,
        turnState: "Completed",
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield "Synthetic response.";
        },
      });
    }
  }

  const noop = () => undefined;
  const no = () => false;
  const nil = () => null;

  return {
    ModelSession,
    createLogger: () => ({ info: noop, error: noop, debug: noop }),
    trunc: (text: string, limit: number) => text.slice(0, limit),
    getToneForModel: () => "Synthetic",
    requestUsesAgent: no,
    modelRequiresAgent: no,
    noteAgentRouteDead: no,
    noteAgentRouteAlive: noop,
    isAgentRouteAlive: no,
    PREMIUM_ONLY_AGENT_TONES: new Set(),
    defaultFramingForModel: () => "baseline",
    currentFramingVariant: () => "baseline",
    transcriptStyleForVariant: () => ({
      framingTag: "system",
      systemTag: "system",
      userTag: "user",
      assistantTag: "assistant",
    }),
    priorityAccessExhaustionOf: nil,
    notePriorityAccessExhausted: noop,
    activePriorityAccessExhaustion: nil,
    meteredAllowance: nil,
    METERED_BUDGETS: {},
    meteredBudgetOf: nil,
    priorityAccessFallbackModel: nil,
    PRIORITY_ACCESS_FALLBACK_ENV: {},
    couldBePriorityAccessPrefix: no,
    secondsUntilReset: () => 0,
    formatMessages: (messages: MockMessage[]) =>
      messages.map((message) => `${message.role}: ${content(message)}`).join("\n"),
    parseToolCalls: () => ({
      hasToolCalls: false,
      toolCalls: [],
      textContent: null,
    }),
    looksLikeConfabulation: no,
    looksLikeHallucinatedCompletion: no,
    looksLikeRemoteArtifactCompletion: no,
    truncateAtFabricatedToolResponse: (text: string) => text,
    textAfterFirstToolCall: () => "",
    isProseDocument: no,
    getMessageContent: content,
    noteRequestOutcome: (failed: boolean) => state.outcomes.push(failed),
    noteUpstreamThrottle: noop,
    getDegradationRetryAfterSeconds: () => 0,
    awaitDegradationBackoff: () => Promise.resolve(),
    getImageArtifactToken: () =>
      Promise.reject(new Error("Artifact authentication forbidden in this fixture")),
    fetchImageBytes: () => Promise.reject(new Error("Artifact download forbidden in this fixture")),
  };
});

// Bind freshly imported modules to this suite's registered mocks.
vi.resetModules();
const { handleChatCompletion, SessionPool } = await import("./handler.js");
const { ChatCompletionRequest } = await import("./schemas.js");

beforeEach(() => {
  state.runs = 0;
  state.texts = [];
  state.result = { value: "Success" };
  state.outcomes = [];
  vi.stubEnv("M365_STICKY_SESSION", "all");
  vi.stubEnv("M365_DISABLE_AGENT", "1");
});
afterEach(() => vi.unstubAllEnvs());

it("V4-027: final header failure still notifies observer and releases queue", async () => {
  const pool = new SessionPool();
  const body = ChatCompletionRequest.parse({
    model: "synthetic-model",
    stream: true,
    messages: [{ role: "user", content: "Synthetic cleanup probe." }],
  });
  const observer = vi.fn();
  // Intentionally capture the original method; originalSet.call below supplies this.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const originalSet = Headers.prototype.set;
  const injected = new Error("Synthetic final header failure");

  const spy = vi.spyOn(Headers.prototype, "set").mockImplementation(function (
    this: Headers,
    name: string,
    value: string,
  ) {
    if (name.toLowerCase() === "x-proxy-finish-reason" && value === "stop") {
      throw injected;
    }
    return originalSet.call(this, name, value);
  });

  try {
    const response = await handleChatCompletion(body, pool, {
      onComplete: observer,
    });

    // Observe the stream rejection immediately so the injected failure
    // is handled rather than becoming an unhandled promise rejection.
    const outcome = await response.text().then(
      (text) => ({ text, error: null }),
      (error: unknown) => ({ text: null, error }),
    );

    expect(outcome.error).toBeNull();
    expect(outcome.text).toContain("data: [DONE]");
    expect(observer).toHaveBeenCalledTimes(1);

    const conversation = pool.resolve(body.messages, body.model, "all");
    expect(conversation.turnQueue.busy).toBe(false);
    expect(state.runs).toBe(1);
  } finally {
    spy.mockRestore();
  }
});

it("control: normal finalisation releases the queue", async () => {
  const pool = new SessionPool();
  const body = ChatCompletionRequest.parse({
    model: "synthetic-model",
    stream: true,
    messages: [{ role: "user", content: "Synthetic normal completion." }],
  });
  const observer = vi.fn();
  const response = await handleChatCompletion(body, pool, {
    onComplete: observer,
  });
  expect(await response.text()).toContain("data: [DONE]");
  expect(observer).toHaveBeenCalledTimes(1);
  expect(pool.resolve(body.messages, body.model, "all").turnQueue.busy).toBe(false);
});

it("V4-031: content-bearing ForbiddenRequest returns a structured failure", async () => {
  state.result = {
    value: "ForbiddenRequest",
    errorCode: "SyntheticDenied",
    message: "Synthetic named failure.",
  };
  const response = await handleChatCompletion(
    ChatCompletionRequest.parse({
      model: "synthetic-model",
      messages: [{ role: "user", content: "Synthetic request." }],
    }),
    new SessionPool(),
  );
  expect(response.status).toBe(403);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ error: { code: "SyntheticDenied" } });
  expect(body).not.toHaveProperty("choices");
  expect(state.runs).toBe(1);
  expect(state.outcomes).not.toContain(false);
});

it("V4-031: streaming named failure emits an error rather than successful completion", async () => {
  state.result = { value: "ForbiddenRequest", errorCode: "SyntheticDenied" };
  const observer = vi.fn();
  const response = await handleChatCompletion(
    ChatCompletionRequest.parse({
      model: "synthetic-model",
      stream: true,
      messages: [{ role: "user", content: "Synthetic streaming request." }],
    }),
    new SessionPool(),
    { onComplete: observer },
  );
  const text = await response.text();
  expect(text).toContain("SyntheticDenied");
  expect(text).toContain("data: [DONE]");
  expect(text).not.toContain('"finish_reason":"stop"');
  expect(observer).toHaveBeenCalledTimes(1);
});
