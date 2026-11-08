import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";

vi.mock("./auth.js", () => ({ getTokenForScope: vi.fn().mockResolvedValue("synthetic-token") }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: vi.fn().mockReturnValue(false),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
import { environmentUrlFromName } from "./agent.js";

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

  // A tenant whose `~default` env is a plain GUID: its host has no `default` prefix.
  it("adds the `default` prefix only for Default- names", () => {
    expect(environmentUrlFromName("12345678-abcd-4ef0-9876-0123456789ab")).toBe(
      "https://12345678abcd4ef098760123456789.ab.environment.api.powerplatform.com",
    );
  });

  it("rejects a degenerate env ID", () => {
    expect(() => environmentUrlFromName("Default-")).toThrow(/Unexpected/);
  });
});

describe("agent provisioning policy", () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  function setup(failAt: "create" | "publish" | "retry-publish" | "ordinary") {
    const calls: string[] = [];
    let publishes = 0;
    const deny = () => new Response('{"error":{"code":"CopilotExtensibilityNotEnabled"}}', { status: 403 });
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (input.includes("api.bap.microsoft.com")) return Response.json({ name: "Default-12345678-abcd-4ef0-9876-0123456789ab" });
      if (method === "HEAD") return new Response(null, { status: 200 });
      if (method === "GET") { calls.push("list"); return Response.json([]); }
      if (method === "DELETE") { calls.push("delete"); return new Response(null, { status: 204 }); }
      if (input.includes("/publish?")) {
        calls.push("publish");
        publishes++;
        if (failAt === "publish" || (failAt === "retry-publish" && publishes === 2)) return deny();
        if ((failAt === "ordinary" || failAt === "retry-publish") && publishes === 1) return new Response("broken bot", { status: 500 });
        return Response.json({ TitleId: "synthetic-title" });
      }
      calls.push("create");
      if (failAt === "create") return deny();
      return Response.json({ bot: { schemaName: "synthetic-bot" } });
    }));
    return calls;
  }

  it.each(["create", "publish", "retry-publish"] as const)("remembers policy denial during %s without further provisioning", async (stage) => {
    const calls = setup(stage);
    const { getOrCreateAgent } = await import("./agent.js");
    expect(await getOrCreateAgent()).toBeNull();
    const expected = stage === "create" ? ["list", "create"] : stage === "publish" ? ["list", "create", "publish"] : ["list", "create", "publish", "delete", "create", "publish"];
    expect(calls).toEqual(expected);
    expect(await getOrCreateAgent({ forceRefresh: true })).toBeNull();
    expect(calls).toEqual(expected);
  });

  it("still deletes and recreates after an ordinary publish failure", async () => {
    const calls = setup("ordinary");
    const { getOrCreateAgent } = await import("./agent.js");
    expect(await getOrCreateAgent()).toBe("synthetic-title.synthetic-bot.gpt.default");
    expect(calls).toEqual(["list", "create", "publish", "delete", "create", "publish"]);
  });
});
