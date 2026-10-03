import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSession } from "./model.js";
import { CopilotSession } from "./session.js";
import { getOrCreateAgent } from "./agent.js";

vi.mock("./auth.js", () => ({ getToken: vi.fn(() => Promise.resolve("token")) }));
vi.mock("./agent.js", () => ({ getOrCreateAgent: vi.fn() }));
vi.mock("./session.js", () => ({
  CopilotSession: vi.fn(
    class {
      turnCount = 0;
      chat = vi.fn(() => Promise.resolve({}));
    },
  ),
}));

describe("ModelSession agent resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("M365_DISABLE_AGENT", "");
    vi.stubEnv("M365_NO_IMAGE_GEN", "");
    vi.mocked(getOrCreateAgent).mockResolvedValue("agent-id");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("resolves lazily and reuses the result when running", async () => {
    const session = new ModelSession();
    expect(getOrCreateAgent).not.toHaveBeenCalled();
    expect(await session.resolveAgent()).toBe("agent-id");
    expect(await session.resolveAgent()).toBe("agent-id");
    await session.run("hello");
    expect(getOrCreateAgent).toHaveBeenCalledTimes(1);
    expect(CopilotSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: "agent-id" }));
  });

  it("caches unavailable agents", async () => {
    vi.mocked(getOrCreateAgent).mockResolvedValue(null);
    const session = new ModelSession();
    expect(await session.resolveAgent()).toBeNull();
    await session.run("hello");
    expect(getOrCreateAgent).toHaveBeenCalledTimes(1);
    expect(CopilotSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: undefined }));
  });

  it("treats resolution errors as an unavailable agent", async () => {
    vi.mocked(getOrCreateAgent).mockRejectedValue(new Error("unavailable"));
    const session = new ModelSession();
    expect(await session.resolveAgent()).toBeNull();
    expect(await session.resolveAgent()).toBeNull();
    expect(getOrCreateAgent).toHaveBeenCalledTimes(1);
  });

  it("does not provision when the session disables agents", async () => {
    const session = new ModelSession({ useAgent: false });
    expect(await session.resolveAgent()).toBeNull();
    await session.run("hello");
    expect(getOrCreateAgent).not.toHaveBeenCalled();
  });

  it("does not provision or attach an agent when disabled by environment", async () => {
    const session = new ModelSession();
    await session.resolveAgent();
    vi.stubEnv("M365_DISABLE_AGENT", "1");
    expect(await session.resolveAgent()).toBeNull();
    await session.run("hello");
    expect(CopilotSession).toHaveBeenCalledWith(expect.objectContaining({ agentId: undefined }));
    expect(getOrCreateAgent).toHaveBeenCalledTimes(1);
  });

  it("skips resolution for agent-less turns", async () => {
    const session = new ModelSession();
    await session.run("hello", "claude-sonnet", undefined, false);
    expect(getOrCreateAgent).not.toHaveBeenCalled();
  });

  it.each([false, true])("enables images only on agent-less turns (agent=%s)", async (useAgent) => {
    const session = new ModelSession();
    await session.run("draw a bicycle", "m365-copilot", undefined, useAgent);
    const copilot = vi.mocked(CopilotSession).mock.instances.at(-1);
    if (!copilot) throw new Error("Expected a CopilotSession instance");
    expect(vi.mocked(copilot).chat.mock.calls).toContainEqual([
      "token",
      "draw a bicycle",
      "m365-copilot",
      undefined,
      { generateImages: !useAgent },
    ]);
  });

  it("keeps the image-generation opt-out on agent-less turns", async () => {
    vi.stubEnv("M365_NO_IMAGE_GEN", "1");
    await new ModelSession({ useAgent: false }).run("hello");
    const copilot = vi.mocked(CopilotSession).mock.instances.at(-1);
    if (!copilot) throw new Error("Expected a CopilotSession instance");
    expect(vi.mocked(copilot).chat.mock.calls).toContainEqual([
      "token",
      "hello",
      "m365-copilot",
      undefined,
      { generateImages: false },
    ]);
  });

  it("re-resolves after reset", async () => {
    const session = new ModelSession();
    await session.resolveAgent();
    session.reset();
    await session.resolveAgent();
    expect(getOrCreateAgent).toHaveBeenCalledTimes(2);
  });
});
