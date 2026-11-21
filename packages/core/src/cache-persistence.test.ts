import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Only the identity provider is synthetic. Persistence and auth callers are real.
const identity = vi.hoisted(() => ({ fail: false, serializations: 0 }));
vi.mock("@azure/msal-node", () => ({
  PublicClientApplication: class {
    getTokenCache() {
      return {
        getAllAccounts: async () => [{ username: "synthetic@example.invalid" }],
        deserialize: () => {},
        serialize: () => { identity.serializations++; return '{"synthetic":"complete"}'; },
      };
    }
    async acquireTokenSilent() {
      if (identity.fail) throw new Error("synthetic expired token");
      return { accessToken: "synthetic-token" };
    }
  },
}));

let root: string;
beforeEach(() => {
  vi.resetModules();
  root = fs.mkdtempSync(join(tmpdir(), "cache-callers-"));
  vi.stubEnv("HOME", root);

  // os.homedir() reads USERPROFILE on Windows: without it these write the real ~/.config/opencode-m365.

  vi.stubEnv("USERPROFILE", root);
  vi.stubEnv("M365_CACHE_FILE", join(root, "blocked", "cache.json"));
  vi.stubEnv("M365_ENABLE_INTERACTIVE_APPROVAL", "1");
  vi.stubEnv("M365_SECRETS_FILE", join(root, "unreadable-secrets"));
  // If persistence falls through into recovery, the real secrets read throws.
  fs.mkdirSync(join(root, "unreadable-secrets"));
  fs.writeFileSync(join(root, "blocked"), "not a directory");
  identity.fail = false;
  identity.serializations = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("native auth cache publication", () => {
  it.each(["getTokenSilent", "getToken", "forceReauth", "getTokenForScope"] as const)(
    "%s rejects local persistence failure rather than succeeding or recovering credentials",
    async (method) => {
      const auth = await import("./auth.js");
      await expect(auth[method](["synthetic-scope"])).rejects.toMatchObject({
        name: "CachePersistenceError",
        message: expect.stringContaining("Cannot persist local cache"),
      });
      expect(identity.serializations).toBe(1);
    },
  );

  it("real document upload propagates auth persistence failure before any chat or upload", async () => {
    const { ModelSession } = await import("./model.js");
    const { CopilotSession } = await import("./session.js");
    const chat = vi.spyOn(CopilotSession.prototype, "chat").mockResolvedValue({} as never);
    const fetch = vi.fn(() => { throw new Error("unexpected network"); });
    vi.stubGlobal("fetch", fetch);
    const model = new ModelSession({ getToken: async () => "synthetic-chat-token", useAgent: false });
    await expect(model.run("read document", "m365-copilot", undefined, false, ["data:application/pdf;base64,JVBERi0="]))
      .rejects.toMatchObject({ name: "CachePersistenceError" });
    expect(identity.serializations).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it("keeps the OS error code on the cause through the auth caller", async () => {
    const { getTokenSilent } = await import("./auth.js");
    const error = await getTokenSilent().then(() => undefined, (e: unknown) => e);
    expect(error).toMatchObject({ name: "CachePersistenceError" });
    expect(String((error as { cause?: { code?: unknown } }).cause?.code)).toMatch(/^(EEXIST|ENOTDIR)$/);
    expect((error as Error).message).not.toContain(root);
    expect(String((error as Error).cause)).not.toContain(root);
  });

  it("still returns null on genuine silent identity failure", async () => {
    identity.fail = true;
    const { getTokenSilent } = await import("./auth.js");
    await expect(getTokenSilent()).resolves.toBeNull();
    expect(identity.serializations).toBe(0);
  });

  it("publishes a complete private MSAL cache at the configured path", async () => {
    const path = join(root, "new", "nested", "cache.json");
    vi.stubEnv("M365_CACHE_FILE", path);
    const { getTokenSilent } = await import("./auth.js");
    await expect(getTokenSilent()).resolves.toBe("synthetic-token");
    expect(fs.readFileSync(path, "utf8")).toBe('{"synthetic":"complete"}');
    if (process.platform !== "win32") {
      expect(fs.statSync(path).mode & 0o777).toBe(0o600);
      expect(fs.statSync(join(root, "new")).mode & 0o777).toBe(0o700);
    }
  });
});
