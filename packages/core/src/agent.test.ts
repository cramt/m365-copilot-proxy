import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { environmentUrlFromName } from "./agent.js";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("./auth.js", () => ({ getTokenForScope: vi.fn(() => Promise.resolve("token")) }));
vi.mock("./auth.js", () => ({ getTokenForScope: vi.fn(() => Promise.resolve("token")) }));

describe("environmentUrlFromName", () => {
  it("splits the last two env-ID chars into their own DNS label", () => {
    expect(environmentUrlFromName("Default-fa7f56d8-49c4-4327-b816-9a0eeaa273df")).toBe(
      "https://defaultfa7f56d849c44327b8169a0eeaa273.df.environment.api.powerplatform.com",
    );
  });

  // Regression: the old hardcoded `.df.` only worked for IDs ending in "df".
  it("uses the real trailing chars, not a hardcoded `.df.`", () => {
    expect(environmentUrlFromName("Default-906AEFE9-76A7-4F65-B82D-5EC20775D5A1")).toBe(
      "https://default906aefe976a74f65b82d5ec20775d5.a1.environment.api.powerplatform.com",
    );
  });

  it("rejects a degenerate env ID", () => {
    expect(() => environmentUrlFromName("Default-")).toThrow(/Unexpected/);
  });
});

describe("getOrCreateAgent", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("M365_DISABLE_AGENT", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function mockPublish(statusCode: number, message: string) {
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url.includes("environments/~default")) {
        return Promise.resolve(
          Response.json({ name: "Default-fa7f56d8-49c4-4327-b816-9a0eeaa273df" }),
        );
      }
      if (options?.method === "HEAD" || options?.method === "DELETE") {
        return Promise.resolve(new Response());
      }
      if (url.includes("/publish?")) {
        return Promise.resolve(new Response(message, { status: statusCode }));
      }
      if (options?.method === "POST") {
        return Promise.resolve(Response.json({ bot: { schemaName: "bot-id" } }));
      }
      return Promise.resolve(Response.json([]));
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("skips all provisioning when disabled", async () => {
    vi.stubEnv("M365_DISABLE_AGENT", "1");
    const fetchMock = mockPublish(200, '{"TitleId":"title"}');
    const { getOrCreateAgent } = await import("./agent.js");
    expect(await getOrCreateAgent()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caches an extensibility 403 without deleting or recreating the bot", async () => {
    const fetchMock = mockPublish(403, "Copilot extensibility not enabled");
    const { getOrCreateAgent } = await import("./agent.js");
    expect(await getOrCreateAgent()).toBeNull();
    const callsAfterFailure = fetchMock.mock.calls.length;
    expect(await getOrCreateAgent()).toBeNull();
    expect(await getOrCreateAgent({ forceRefresh: true })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFailure);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("/publish?"))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
  });

  it.each([403, 500])("does not cache an unrelated publish failure (%s)", async (statusCode) => {
    const fetchMock = mockPublish(statusCode, "Temporary publish failure");
    const { getOrCreateAgent } = await import("./agent.js");
    expect(await getOrCreateAgent()).toBeNull();
    const callsAfterFailure = fetchMock.mock.calls.length;
    expect(await getOrCreateAgent()).toBeNull();
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFailure);
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(true);
  });

  it("still returns a published agent", async () => {
    mockPublish(200, '{"TitleId":"title"}');
    const { getOrCreateAgent } = await import("./agent.js");
    expect(await getOrCreateAgent()).toBe("title.bot-id.gpt.default");
  });

  it("also caches an extensibility refusal on the recovery publish", async () => {
    const fetchMock = mockPublish(403, "Copilot extensibility not enabled");
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ name: "Default-fa7f56d8-49c4-4327-b816-9a0eeaa273df" }),
      )
      .mockResolvedValueOnce(new Response())
      .mockResolvedValueOnce(Response.json([]))
      .mockResolvedValueOnce(Response.json({ bot: { schemaName: "bot-id" } }))
      .mockResolvedValueOnce(new Response("Legacy bot failure", { status: 500 }));
    const { getOrCreateAgent } = await import("./agent.js");
    expect(await getOrCreateAgent()).toBeNull();
    const callsAfterFailure = fetchMock.mock.calls.length;
    expect(await getOrCreateAgent()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterFailure);
    expect(fetchMock.mock.calls.filter(([url]) => url.includes("/publish?"))).toHaveLength(2);
  });
});
