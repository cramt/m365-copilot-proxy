import { beforeEach, afterEach, expect, it, vi } from "vitest";

type MockMessage = {
  role: string;
  content?: string | Array<{ text?: string }> | null;
};
type MockResult = { value: string; errorCode?: string; message?: string };

const state = vi.hoisted(() => ({
  queue: [] as Array<{
    text: string;
    result?: { value: string };
    messageType?: string;
  }>,
  models: [] as string[],
  contexts: [] as Array<{ tone?: string }>,
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
    run(text: string, model: string) {
      state.runs++;
      state.texts.push(text);

      this.turnCount++;
      state.models.push(model);
      const next = state.queue.shift();
      const answer = next ? next.text : "Synthetic response.";
      return Promise.resolve({
        fullText: answer,
        hasContent: answer.length > 0,
        result: next?.result ?? { ...state.result },
        images: [],
        throttle: { current: 1, max: 600 },
        metering: null,
        contentOrigin: "Synthetic",
        messageType: next?.messageType ?? null,
        messageId: "synthetic-message",
        scores: null,
        turnCount: 1,
        turnState: "Completed",
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          if (answer) yield answer;
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
    getToneForModel: (model: string) => `tone:${model}`,
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

    priorityAccessExhaustionOf: (result: MockResult | null | undefined) =>
      result?.value === "OutOfCredits"
        ? {
            window: "day",
            resetsAt: new Date(Date.now() + 86400000),
            message: "Synthetic exhaustion.",
          }
        : null,
    notePriorityAccessExhausted: noop,
    activePriorityAccessExhaustion: nil,
    meteredAllowance: nil,
    METERED_BUDGETS: {},
    meteredBudgetOf: (model: string) => (model === "requested-model" ? "opus" : null),
    priorityAccessFallbackModel: () => "fallback-model",
    PRIORITY_ACCESS_FALLBACK_ENV: {},
    couldBePriorityAccessPrefix: no,
    secondsUntilReset: () => 0,
    formatMessages: (
      messages: MockMessage[],
      _tools: unknown,
      _choice: unknown,
      _id: unknown,
      _variant: unknown,
      context: { tone?: string },
    ) => {
      state.contexts.push({ ...context });
      return messages.map((message) => `${message.role}: ${content(message)}`).join("\n");
    },
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
  state.queue = [];
  state.models = [];
  state.contexts = [];
  state.runs = 0;
  state.texts = [];
  state.result = { value: "Success" };
  state.outcomes = [];
  vi.stubEnv("M365_STICKY_SESSION", "all");
  vi.stubEnv("M365_DISABLE_AGENT", "1");
});
afterEach(() => vi.unstubAllEnvs());

it("V4-028 regression: fallback then disengagement retains fallback tone context", async () => {
  vi.stubEnv("M365_NO_DISENGAGE_RETRY", "");
  state.queue = [
    { text: "", result: { value: "OutOfCredits" } },
    { text: "", result: { value: "Success" }, messageType: "Disengaged" },
    { text: "Synthetic final answer.", result: { value: "Success" } },
  ];

  const response = await handleChatCompletion(
    ChatCompletionRequest.parse({
      model: "requested-model",
      tools: [
        {
          type: "function",
          function: {
            name: "bash",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
            },
          },
        },
      ],
      messages: [{ role: "user", content: "Synthetic inspection request." }],
    }),
    new SessionPool(),
  );
  await response.text();

  expect(state.models).toEqual(["requested-model", "fallback-model", "fallback-model"]);
  expect(state.contexts.map((context) => context.tone)).toEqual([
    "tone:requested-model",
    "tone:fallback-model",
    "tone:fallback-model",
  ]);
});
