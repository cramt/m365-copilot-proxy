import { beforeEach, afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  agent: vi.fn(),
  chat: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  constructed: vi.fn(),
}));

vi.mock("./auth.js", () => ({ getToken: mocks.token }));
vi.mock("./agent.js", () => ({ getOrCreateAgent: mocks.agent }));
vi.mock("./log.js", () => ({
  createLogger: () => ({
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  }),
  trunc: (text: string, limit: number) => text.slice(0, limit),
}));
vi.mock("./session.js", () => ({
  CopilotSession: class {
    turnCount = 0;
    constructor(options: unknown) {
      mocks.constructed(options);
    }
    chat(...args: unknown[]) {
      return mocks.chat(...args);
    }
  },
}));

// Bind freshly imported modules to this suite's registered mocks.
vi.resetModules();
const { ModelSession } = await import("./model.js");

beforeEach(() => {
  mocks.token.mockReset().mockResolvedValue("synthetic-token");
  mocks.agent.mockReset().mockResolvedValue("synthetic-agent");
  mocks.chat.mockReset();
  mocks.constructed.mockReset();
  vi.stubEnv("M365_DISABLE_AGENT", "");
  vi.stubEnv("M365_NO_IMAGE_GEN", "1");
});
afterEach(() => vi.unstubAllEnvs());

it("pre-aborted run stops before token, agent and transport work", async () => {
  const controller = new AbortController();
  controller.abort();

  const outcome = await new ModelSession()
    .run("Synthetic request.", "synthetic-model", controller.signal, true)
    .then(
      () => ({ rejected: false, error: undefined }),
      (error: unknown) => ({ rejected: true, error }),
    );
  expect(outcome.rejected).toBe(true);
  expect(controller.signal.aborted).toBe(true);
  expect(outcome.error).toBe(controller.signal.reason);
  expect(mocks.token).not.toHaveBeenCalled();
  expect(mocks.agent).not.toHaveBeenCalled();
  expect(mocks.constructed).not.toHaveBeenCalled();
  expect(mocks.chat).not.toHaveBeenCalled();
});

it("abort during token resolution stops before agent and transport", async () => {
  const controller = new AbortController();
  mocks.token.mockImplementation(() => {
    controller.abort();
    return Promise.resolve("synthetic-token");
  });

  const outcome = await new ModelSession()
    .run("Synthetic request.", "synthetic-model", controller.signal, true)
    .then(
      () => ({ rejected: false, error: undefined }),
      (error: unknown) => ({ rejected: true, error }),
    );
  expect(outcome.rejected).toBe(true);
  expect(controller.signal.aborted).toBe(true);
  expect(outcome.error).toBe(controller.signal.reason);
  expect(mocks.token).toHaveBeenCalledTimes(1);
  expect(mocks.agent).not.toHaveBeenCalled();
  expect(mocks.constructed).not.toHaveBeenCalled();
});

it("abort during agent resolution stops before transport", async () => {
  const controller = new AbortController();
  mocks.agent.mockImplementation(() => {
    controller.abort();
    return Promise.resolve("synthetic-agent");
  });

  const outcome = await new ModelSession()
    .run("Synthetic request.", "synthetic-model", controller.signal, true)
    .then(
      () => ({ rejected: false, error: undefined }),
      (error: unknown) => ({ rejected: true, error }),
    );
  expect(outcome.rejected).toBe(true);
  expect(controller.signal.aborted).toBe(true);
  expect(outcome.error).toBe(controller.signal.reason);
  expect(mocks.agent).toHaveBeenCalledTimes(1);
  expect(mocks.constructed).not.toHaveBeenCalled();
  expect(mocks.chat).not.toHaveBeenCalled();
});

it("transport AbortError is propagated without reconnection", async () => {
  const error = new Error("Synthetic cancellation");
  error.name = "AbortError";
  mocks.chat.mockRejectedValue(error);
  await expect(
    new ModelSession().run("Synthetic request.", "synthetic-model", undefined, false),
  ).rejects.toBe(error);
  expect(mocks.constructed).toHaveBeenCalledTimes(1);
  expect(mocks.chat).toHaveBeenCalledTimes(1);
});

it("ordinary initial transport error retains one reconnect attempt", async () => {
  const stream = { synthetic: true };
  mocks.chat
    .mockRejectedValueOnce(new Error("Synthetic stale session"))
    .mockResolvedValueOnce(stream);
  expect(
    await new ModelSession().run("Synthetic request.", "synthetic-model", undefined, false),
  ).toBe(stream);
  expect(mocks.constructed).toHaveBeenCalledTimes(2);
  expect(mocks.chat).toHaveBeenCalledTimes(2);
});
