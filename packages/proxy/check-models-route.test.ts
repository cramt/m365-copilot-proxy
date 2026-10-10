import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  models: ["model-a", "model-b", "model-c"],
  completion: vi.fn(),
  record: vi.fn(),
  log: vi.fn(),
  sync: vi.fn(),
}));

vi.mock("@m365-copilot/proxy-lib", () => ({
  buildModelsPayload: () => ({ data: mocks.models.map((id) => ({ id })) }),
  ChatCompletionRequest: { parse: (body: unknown) => body },
  handleChatCompletion: mocks.completion,
}));
vi.mock("./server-pool", () => ({ pool: { getActiveConversations: () => [] } }));
vi.mock("./metrics", () => ({
  recordCompletionMetric: mocks.record,
  logCompletionStatus: mocks.log,
  syncActiveSessions: mocks.sync,
}));

let route: () => Promise<Response>;

beforeAll(async () => {
  vi.stubGlobal("defineEventHandler", (handler: typeof route) => handler);
  route = (await import("./routes/actions/check-models.post")).default as typeof route;
});
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("check all models pacing", () => {
  it("checks sequentially, waits ten seconds after each completion, and rejects overlap", async () => {
    vi.useFakeTimers();
    const starts: Array<{ model: string; at: number }> = [];
    let finishFirst: ((response: Response) => void) | undefined;
    mocks.completion.mockImplementation((body: { model: string }) => {
      starts.push({ model: body.model, at: Date.now() });
      if (body.model === "model-a") {
        return new Promise<Response>((resolve) => {
          finishFirst = resolve;
        });
      }
      return Promise.resolve(new Response("{}", { status: 200 }));
    });

    const pending = route();
    expect(starts).toHaveLength(1);
    const overlap = await route();
    expect(overlap.status).toBe(409);
    expect(starts).toHaveLength(1);

    finishFirst?.(new Response("{}", { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.record).toHaveBeenCalledTimes(1);
    const completedFirstAt = Date.now();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(starts).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toHaveLength(2);
    expect(starts[1].at - completedFirstAt).toBeGreaterThanOrEqual(10_000);

    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.record).toHaveBeenCalledTimes(2);
    const completedSecondAt = Date.now();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(starts).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(starts).toHaveLength(3);
    expect(starts[2].at - completedSecondAt).toBeGreaterThanOrEqual(10_000);
    expect(((await response.json()) as { results: unknown[] }).results).toHaveLength(3);
    expect(mocks.record).toHaveBeenCalledTimes(3);
  });
});
