import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const mocks = vi.hoisted(() => ({ edge: vi.fn(), url: vi.fn(), exchange: vi.fn() }));
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
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
