import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("@azure/msal-node", () => ({ PublicClientApplication: class {
  getTokenCache() { return { getAllAccounts: async () => [{}], deserialize: () => {}, serialize: () => "{}" }; }
  async acquireTokenSilent() { return { accessToken: "synthetic-token" }; }
} }));
let root: string;
beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(join(tmpdir(), "agent-cache-"));
  vi.stubEnv("HOME", root);
  vi.stubEnv("M365_CACHE_FILE", join(root, "msal.json"));
  vi.stubGlobal("fetch", vi.fn(async (input: string, options?: RequestInit) => {
    if (input.includes("/~default?")) return Response.json({ name: "Default-123456" });
    if (options?.method === "HEAD") return new Response(null);
    if (input.includes("/publish?")) return Response.json({ TitleId: "synthetic-title" });
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
  await expect(getOrCreateAgent()).resolves.toBe("synthetic-title.synthetic-bot.gpt.default");
  const path = join(root, ".config", "opencode-m365", "agent-id.json");
  expect(JSON.parse(fs.readFileSync(path, "utf8"))).toMatchObject({ botId: "synthetic-bot" });
  if (process.platform !== "win32") expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  const calls = vi.mocked(fetch).mock.calls.length;
  await expect(getOrCreateAgent()).resolves.toBe("synthetic-title.synthetic-bot.gpt.default");
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  // Replacement must tighten a legacy permissive cache even under a private umask.
  fs.chmodSync(path, 0o644);
  await expect(getOrCreateAgent({ forceRefresh: true })).resolves.toBe("synthetic-title.synthetic-bot.gpt.default");
  if (process.platform !== "win32") expect(fs.statSync(path).mode & 0o777).toBe(0o600);
});
it("the real model run caller stops at cache failure before opening a chat session", async () => {
  const path = join(root, ".config", "opencode-m365", "agent-id.json");
  fs.mkdirSync(path, { recursive: true });
  const { ModelSession } = await import("./model.js");
  const token = `synthetic.${Buffer.from(JSON.stringify({ tid: "synthetic-tenant", oid: "synthetic-user" })).toString("base64url")}.synthetic`;
  const model = new ModelSession({ getToken: async () => token });
  await expect(model.run("synthetic request", "m365-copilot", AbortSignal.abort())).rejects.toMatchObject({ name: "CachePersistenceError" });
});
it("the real model refresh caller propagates cache publication failure", async () => {
  const path = join(root, ".config", "opencode-m365", "agent-id.json");
  fs.mkdirSync(path, { recursive: true });
  const { ModelSession } = await import("./model.js");
  const token = `synthetic.${Buffer.from(JSON.stringify({ tid: "synthetic-tenant", oid: "synthetic-user" })).toString("base64url")}.synthetic`;
  const model = new ModelSession({ getToken: async () => token });
  await expect(model.refreshAgent()).rejects.toMatchObject({ name: "CachePersistenceError" });
});
it("the real agent caller does not turn cache publication failure into optional-agent absence", async () => {
  const path = join(root, ".config", "opencode-m365", "agent-id.json");
  fs.mkdirSync(path, { recursive: true });
  const { getOrCreateAgent } = await import("./agent.js");
  await expect(getOrCreateAgent()).rejects.toMatchObject({ name: "CachePersistenceError" });
  expect(fs.readdirSync(join(root, ".config", "opencode-m365"))).toEqual(["agent-id.json"]);
});
