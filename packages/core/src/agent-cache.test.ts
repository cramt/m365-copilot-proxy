import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
const fixture = vi.hoisted(() => ({ oid: "00000000-0000-4000-8000-000000000002", guard: false, touches: [] as string[] }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const guarded: Record<string, unknown> = { ...actual };
  for (const name of ["existsSync", "readFileSync", "openSync", "writeFileSync", "renameSync", "lstatSync", "mkdirSync"]) {
    const fn = actual[name as keyof typeof actual] as (...args: any[]) => unknown;
    guarded[name] = (...args: any[]) => {
      if (fixture.guard && args.some(a => typeof a === "string" && /(?:agent-id\.json|opencode-m365[\\/]\.m365-cache-)/.test(a))) {
        fixture.touches.push(name); throw new Error("forbidden shared agent cache access");
      }
      return fn(...args);
    };
  }
  return guarded;
});
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@azure/msal-node", () => ({ PublicClientApplication: class {
  getTokenCache() { return { getAllAccounts: async () => [{}], deserialize: () => {}, serialize: () => "{}" }; }
  // A JWT-shaped token: the account policy keys every run on its tid/oid GUIDs (#107).
  async acquireTokenSilent() {
    const claims = { tid: "00000000-0000-4000-8000-000000000001", oid: fixture.oid };
    return { accessToken: `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic` };
  }
} }));
let root: string;
beforeEach(() => {
  vi.resetModules(); fixture.guard = false; fixture.touches = []; fixture.oid = "00000000-0000-4000-8000-000000000002";
  root = fs.mkdtempSync(join(tmpdir(), "agent-cache-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("M365_CACHE_FILE", join(root, "msal.json"));
  vi.stubEnv("M365_ACCOUNT_POLICY_PATH", join(root, "policy.sqlite"));
  vi.stubGlobal("fetch", vi.fn(async (input: string, options?: RequestInit) => {
    if (input.includes("/~default?")) return Response.json({ name: "Default-123456" });
    if (options?.method === "HEAD") return new Response(null);
    if (input.includes("/publish?")) return Response.json({ TitleId: `synthetic-title-${fixture.oid}` });
    if (options?.method === "POST") return Response.json({ bot: { schemaName: "synthetic-bot" } });
    return Response.json([]);
  }));
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});
it("the real agent provisioning caller publishes a complete private cache", async () => {
  const { getOrCreateAgent } = await import("./agent.js");
  await expect(getOrCreateAgent()).resolves.toBe("synthetic-title-00000000-0000-4000-8000-000000000002.synthetic-bot.gpt.default");
  const path = join(root, ".config", "opencode-m365", "agent-id.json");
  expect(JSON.parse(fs.readFileSync(path, "utf8"))).toMatchObject({ botId: "synthetic-bot" });
  if (process.platform !== "win32") expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  const calls = vi.mocked(fetch).mock.calls.length;
  await expect(getOrCreateAgent()).resolves.toBe("synthetic-title-00000000-0000-4000-8000-000000000002.synthetic-bot.gpt.default");
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  // Replacement must tighten a legacy permissive cache even under a private umask.
  fs.chmodSync(path, 0o644);
  await expect(getOrCreateAgent({ forceRefresh: true })).resolves.toBe("synthetic-title-00000000-0000-4000-8000-000000000002.synthetic-bot.gpt.default");
  if (process.platform !== "win32") expect(fs.statSync(path).mode & 0o777).toBe(0o600);
});
const token = () => `synthetic.${Buffer.from(JSON.stringify({ tid: "00000000-0000-4000-8000-000000000001", oid: fixture.oid })).toString("base64url")}.synthetic`;
it("resolves and reuses each account's agent without shared file access", async () => {
  fixture.guard = true;
  const { ModelSession } = await import("./model.js");
  const { CopilotSession } = await import("./session.js");
  const { currentAccountContext } = await import("./account-policy.js");
  const observed: { account: string; agent: string }[] = [];
  const boundary = vi.spyOn(CopilotSession.prototype, "chat").mockImplementation(async function (this: any) {
    observed.push({ account: currentAccountContext()!.key, agent: this.agentId });
    throw new DOMException("synthetic boundary abort", "AbortError");
  });
  try {
    const a = new ModelSession({ getToken: async () => token() });
    await expect(a.refreshAgent()).resolves.toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes("/publish?"))).toBe(true);
    const afterA = vi.mocked(fetch).mock.calls.length;
    await expect(a.run("A", "m365-copilot")).rejects.toMatchObject({ name: "AbortError", message: "synthetic boundary abort" });
    await expect(new ModelSession({ getToken: async () => token() }).run("A again")).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(afterA);
    fixture.oid = "00000000-0000-4000-8000-000000000003";
    await expect(new ModelSession({ getToken: async () => token() }).run("B")).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThan(afterA);
    const afterB = vi.mocked(fetch).mock.calls.length;
    await expect(new ModelSession({ getToken: async () => token() }).run("B again")).rejects.toMatchObject({ name: "AbortError" });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(afterB);
    expect(observed).toHaveLength(4);
    expect(observed[0]).toEqual(observed[1]); expect(observed[2]).toEqual(observed[3]);
    expect(observed[0].account).not.toBe(observed[2].account);
    expect(observed[0].agent).toBe("synthetic-title-00000000-0000-4000-8000-000000000002.synthetic-bot.gpt.default");
    expect(observed[2].agent).toBe("synthetic-title-00000000-0000-4000-8000-000000000003.synthetic-bot.gpt.default");
    expect(fixture.touches).toEqual([]);
  } finally { boundary.mockRestore(); }
});
it("the real agent caller does not turn cache publication failure into optional-agent absence", async () => {
  const path = join(root, ".config", "opencode-m365", "agent-id.json");
  fs.mkdirSync(path, { recursive: true });
  const { getOrCreateAgent } = await import("./agent.js");
  await expect(getOrCreateAgent()).rejects.toMatchObject({ name: "CachePersistenceError" });
  expect(fs.readdirSync(join(root, ".config", "opencode-m365"))).toEqual(["agent-id.json"]);
});
