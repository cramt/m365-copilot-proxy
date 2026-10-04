import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  handleChatCompletion: vi.fn(),
  recordCompletionMetric: vi.fn(),
  logCompletionStatus: vi.fn(),
  syncActiveSessions: vi.fn(),
}));

vi.mock("@m365-copilot/proxy-lib", () => ({
  ChatCompletionRequest: { parse: (body: unknown) => body },
  handleChatCompletion: mocks.handleChatCompletion,
  invalidRequestError: vi.fn(),
}));
vi.mock("./server-pool", () => ({
  pool: { getActiveConversations: () => [] },
}));
vi.mock("./metrics", () => ({
  recordCompletionMetric: mocks.recordCompletionMetric,
  logCompletionStatus: mocks.logCompletionStatus,
  syncActiveSessions: mocks.syncActiveSessions,
}));

type Route = (event: object) => Promise<Response>;
let route: Route;

beforeAll(async () => {
  vi.stubGlobal("defineEventHandler", (handler: Route) => handler);
  vi.stubGlobal("readBody", () =>
    Promise.resolve({
      model: "test-model",
      stream: true,
      messages: [{ role: "user", content: "test" }],
    }),
  );
  const handler = (await import("./routes/v1/chat/completions.post")).default;
  route = (event) => handler(event as never);
});

afterAll(() => vi.unstubAllGlobals());
beforeEach(() => vi.clearAllMocks());

function mockStream(error?: { type: string; message: string }) {
  mocks.handleChatCompletion.mockImplementation(
    (
      _body: unknown,
      _pool: unknown,
      opts: {
        onComplete: (response: Response, error?: { type: string; message: string }) => void;
      },
    ) => {
      const headers = new Headers({
        "content-type": "text/event-stream",
        "x-proxy-stream": "1",
        "x-proxy-model": "test-model",
      });
      const response = new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await Promise.resolve();
            response.headers.set(
              "x-proxy-usage",
              JSON.stringify({
                prompt_tokens: 12,
                completion_tokens: 7,
                total_tokens: 19,
                x_proxy_model_latency_ms: 42,
                x_m365_message_type: "Answer",
              }),
            );
            response.headers.set("x-proxy-finish-reason", "stop");
            opts.onComplete(response, error);
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { headers },
      );
      return Promise.resolve(response);
    },
  );
}

describe("streaming completion metrics", () => {
  it("records final usage and finish reason after the stream completes", async () => {
    mockStream();
    const response = await route({});
    expect(await response.text()).toBe("data: [DONE]\n\n");
    expect(mocks.recordCompletionMetric).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        stream: true,
        statusCode: 200,
        finishReason: "stop",
        messageType: "Answer",
        responseBytes: Buffer.byteLength("data: [DONE]\n\n"),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        usage: expect.objectContaining({
          prompt_tokens: 12,
          completion_tokens: 7,
          x_proxy_model_latency_ms: 42,
        }),
      }),
    );
  });

  it("records an in-stream error rather than a successful HTTP 200", async () => {
    mockStream({ type: "rate_limit_error", message: "Throttled" });
    const response = await route({});
    await response.text();
    expect(mocks.recordCompletionMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: 200,
        errorType: "rate_limit_error",
        errorMessage: "Throttled",
      }),
    );
  });
});
