import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("./auth.js", () => ({ getTokenForScope: vi.fn().mockResolvedValue("synthetic-token") }));
// What agent.ts logs, kept here instead of in a debug log (the #156 tests read it).
const logLines = vi.hoisted(() => [] as string[]);
vi.mock("./log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./log.js")>()),
  createLogger: () => ({
    info: (...args: unknown[]) => { logLines.push(args.map(String).join(" ")); },
    error: (...args: unknown[]) => { logLines.push(args.map(String).join(" ")); },
    debug: () => {},
  }),
}));
// No agent cache is written or read, unless a #156 test lets agent.ts write the real
// `agent-id.json` under its temporary HOME and read it back (`real`), with `hash` in place
// of the hash it holds when one is set.
const cacheFile = vi.hoisted(() => ({ real: false, hash: undefined as string | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const isCache = (path: unknown) => cacheFile.real && String(path).endsWith("agent-id.json");
  return {
    ...actual,
    existsSync: vi.fn((path: string) => isCache(path) && actual.existsSync(path)),
    readFileSync: vi.fn((path: string) => {
      if (!isCache(path)) return undefined;
      const cached = JSON.parse(actual.readFileSync(path, "utf-8"));
      return JSON.stringify(cacheFile.hash ? { ...cached, instructionsHash: cacheFile.hash } : cached);
    }),
    // The cache's contents go through writeFileSync(fd, …) (atomicWritePrivate).
    writeFileSync: vi.fn((...args: Parameters<typeof actual.writeFileSync>) => (cacheFile.real ? actual.writeFileSync(...args) : undefined)),
  };
});
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
  let root: string;
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks();
    // The cache write (openSync + rename) is real even with writeFileSync mocked: keep it off the real ~/.config.
    root = mkdtempSync(join(tmpdir(), "m365-agent-"));
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
  });
  afterEach(() => {
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

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

describe("the log line of a forced agent refresh (#156)", () => {
  let root: string;
  beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks();
    logLines.length = 0;
    root = mkdtempSync(join(tmpdir(), "m365-agent-"));
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit = {}) => {
      const method = init.method ?? "GET";
      if (input.includes("api.bap.microsoft.com")) return Response.json({ name: "Default-12345678-abcd-4ef0-9876-0123456789ab" });
      if (method === "HEAD") return new Response(null, { status: 200 });
      if (method === "GET") return Response.json([]);
      if (input.includes("/publish?")) return Response.json({ TitleId: "synthetic-title" });
      return Response.json({ bot: { schemaName: "synthetic-bot" } });
    }));
  });
  afterEach(() => {
    cacheFile.real = false;
    cacheFile.hash = undefined;
    vi.unstubAllGlobals(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  /** Provisions the agent with no cache yet, which writes the real `agent-id.json` under
   *  the temporary HOME; later reads of it get `cachedHash` in place of the hash it holds
   *  when one is given. */
  async function provisioned(cachedHash?: string) {
    cacheFile.real = true;
    const agent = await import("./agent.js");
    expect(await agent.getOrCreateAgent()).toBe("synthetic-title.synthetic-bot.gpt.default");
    cacheFile.hash = cachedHash;
    logLines.length = 0;
    return agent;
  }

  /** The agent name and hash the call worked with, from its own log. */
  const wanted = () => logLines.join("\n").match(/agent name: (m365-tool-agent-([0-9a-f]{8}))/)?.slice(1) ?? [];

  it("calls a forced refresh of an up-to-date agent a re-validation, not stale", async () => {
    const agent = await provisioned();
    expect(await agent.getOrCreateAgent({ forceRefresh: true })).toBe("synthetic-title.synthetic-bot.gpt.default");
    const [name, hash] = wanted();
    expect(logLines).toContain(`Forced agent refresh: re-validating ${name} against the tenant (instructions ${hash} unchanged)`);
    expect(logLines.join("\n")).not.toContain("stale");
  });

  it.each([false, true])("still calls a cache with another hash stale (forceRefresh: %s)", async (forceRefresh) => {
    const agent = await provisioned("00000000");
    await agent.getOrCreateAgent({ forceRefresh });
    const [, hash] = wanted();
    expect(logLines).toContain(`Cached agent instructions stale (00000000 != ${hash}), rebuilding`);
    expect(logLines.join("\n")).not.toContain("Forced agent refresh");
  });
});
