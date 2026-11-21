import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => ({ edge: vi.fn(), url: vi.fn(), exchange: vi.fn(), launch: vi.fn() }));
// Present the test host as WSL, so the old implicit WSL detection would fire.
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const readFileSync = ((path: any, ...rest: any[]) =>
    path === "/proc/version" ? "Linux version 5.15.0-microsoft-standard-WSL2" : (fs.readFileSync as any)(path, ...rest)) as typeof fs.readFileSync;
  return { ...fs, readFileSync, default: { ...fs, readFileSync } };
});
vi.mock("playwright", () => ({ chromium: { launchPersistentContext: mocks.launch } }));
vi.mock("./edge-login.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./edge-login.js")>()),
  getAuthCodeViaEdge: mocks.edge,
}));
vi.mock("@azure/msal-node", () => ({
  CryptoProvider: class { generatePkceCodes() { return { verifier: "verifier", challenge: "challenge" }; } createNewGuid() { return "state"; } },
  PublicClientApplication: class {
    getTokenCache() { return { getAllAccounts: async () => [], serialize: () => "{}" }; }
    getAuthCodeUrl = mocks.url;
    acquireTokenByCode = mocks.exchange;
  },
}));
const dir = mkdtempSync(join(tmpdir(), "edge-auth-test-"));
const secretsFile = join(dir, "secrets");
vi.stubEnv("M365_CACHE_FILE", join(dir, "cache"));
vi.stubEnv("M365_SECRETS_FILE", join(dir, "secrets"));
vi.stubEnv("M365_BROWSER_PROFILE", join(dir, "profile"));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("blocks the Edge path for headless and no-interactive callers", async () => {
  vi.stubEnv("M365_EDGE_PATH", process.execPath);
  vi.stubEnv("M365_EDGE_LOGIN", "");
  vi.stubEnv("M365_ENABLE_INTERACTIVE_APPROVAL", "");
  vi.stubEnv("M365_NO_INTERACTIVE", "0");
  const { getTokenForScope } = await import("./auth.js");
  expect(await getTokenForScope(["scope"])).toBeNull();
  vi.stubEnv("M365_EDGE_LOGIN", "1");
  vi.stubEnv("M365_NO_INTERACTIVE", "1");
  expect(await getTokenForScope(["scope"])).toBeNull();
  expect(mocks.edge).not.toHaveBeenCalled();
});
it("exchanges an explicitly opted-in Edge code with its PKCE verifier and state", async () => {
  vi.stubEnv("M365_EDGE_LOGIN", "1");
  vi.stubEnv("M365_NO_INTERACTIVE", "0");
  mocks.url.mockResolvedValue("https://example.invalid/authorize");
  mocks.edge.mockResolvedValue("synthetic-code");
  mocks.exchange.mockResolvedValue({ accessToken: "synthetic-token" });
  const { getTokenForScope } = await import("./auth.js");
  expect(await getTokenForScope(["scope"])).toBe("synthetic-token");
  expect(mocks.url).toHaveBeenCalledWith(expect.objectContaining({ state: "state", codeChallenge: "challenge" }));
  expect(mocks.edge).toHaveBeenCalledWith("https://example.invalid/authorize", "state", expect.any(Number));
  expect(mocks.exchange).toHaveBeenCalledWith(expect.objectContaining({ code: "synthetic-code", codeVerifier: "verifier", scopes: ["scope"] }));
});

// Existing-user policy: Edge is reached only through an explicit M365_EDGE_LOGIN=1. The
// headless login and the M365_ENABLE_INTERACTIVE_APPROVAL fallback keep their order.
const rows = [false, true].flatMap((secrets) => [false, true].flatMap((interactive) =>
  [false, true].map((edgeLogin) => ({ secrets, interactive, edgeLogin }))));
const entries = {
  getTokenForScope: async (m: typeof import("./auth.js")) => await m.getTokenForScope(["scope"]),
  getToken: async (m: typeof import("./auth.js")) => await m.getToken(),
  forceReauth: async (m: typeof import("./auth.js")) => await m.forceReauth(),
};
describe.each(Object.keys(entries) as Array<keyof typeof entries>)("%s on a WSL host with Edge installed", (entry) => {
  it.each(rows)("secrets=$secrets INTERACTIVE_APPROVAL=$interactive EDGE_LOGIN=$edgeLogin", async ({ secrets, interactive, edgeLogin }) => {
    rmSync(secretsFile, { force: true });
    if (secrets) writeFileSync(secretsFile, JSON.stringify({ email: "a@example.invalid", password: "p", mfaSecret: "m" }));
    vi.stubEnv("M365_EDGE_PATH", process.execPath);
    vi.stubEnv("M365_NO_INTERACTIVE", "0");
    vi.stubEnv("M365_ENABLE_INTERACTIVE_APPROVAL", interactive ? "1" : "");
    vi.stubEnv("M365_EDGE_LOGIN", edgeLogin ? "1" : "");
    mocks.url.mockResolvedValue("https://example.invalid/authorize");
    mocks.edge.mockResolvedValue("synthetic-code");
    mocks.exchange.mockResolvedValue({ accessToken: "synthetic-token" });
    mocks.launch.mockRejectedValue(new Error("synthetic: no browser"));
    const auth = await import("./auth.js");
    await entries[entry](auth).catch(() => undefined);
    const launches = mocks.launch.mock.calls.map(([, o]) => o.headless);
    if (edgeLogin) {
      expect(mocks.edge).toHaveBeenCalledTimes(1);
      expect(launches).toEqual([]);
    } else {
      expect(mocks.edge).not.toHaveBeenCalled();
      // Unchanged: automated login when secrets exist, then a visible browser only if approved.
      expect(launches).toEqual([...(secrets ? [true] : []), ...(interactive ? [false] : [])]);
    }
  });
});
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
