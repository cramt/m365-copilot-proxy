import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getToken: vi.fn() }));
vi.mock("./wam-auth.js", () => ({
  createWamAuth: () => ({ getToken: mocks.getToken }),
}));
vi.mock("node:fs", () => ({
  existsSync: () => false,
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));
vi.mock("@azure/msal-node", () => ({
  PublicClientApplication: class {
    getTokenCache() { return { getAllAccounts: async () => [] }; }
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubEnv("M365_AUTH_MODE", "wam");
  vi.stubEnv("M365_ENABLE_INTERACTIVE_APPROVAL", "1");
  vi.stubEnv("M365_NO_INTERACTIVE", "");
  mocks.getToken.mockResolvedValue("native-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("authentication mode routing", () => {
  it("preserves browser authentication as the default", async () => {
    vi.stubEnv("M365_AUTH_MODE", "");
    vi.stubEnv("M365_NO_INTERACTIVE", "1");
    const auth = await import("./auth.js");
    await expect(auth.getTokenSilent()).resolves.toBeNull();
    await expect(auth.getToken()).rejects.toThrow("No cached token");
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it("routes chat, extra scopes and manual reauthentication through WAM", async () => {
    const auth = await import("./auth.js");
    await expect(auth.getToken()).resolves.toBe("native-token");
    await expect(auth.getTokenForScope(["extra-scope"])).resolves.toBe("native-token");
    await expect(auth.forceReauth()).resolves.toBe(true);
    await expect(auth.loginAutomated("unused", "unused", "unused")).resolves.toBe("native-token");
    expect(mocks.getToken).toHaveBeenCalledWith(["extra-scope"], true);
    expect(mocks.getToken).toHaveBeenCalledTimes(4);
  });

  it("never permits interaction in silent mode or when explicitly vetoed", async () => {
    const auth = await import("./auth.js");
    await auth.getTokenSilent();
    expect(mocks.getToken).toHaveBeenLastCalledWith(expect.any(Array), false);
    vi.stubEnv("M365_NO_INTERACTIVE", "1");
    await auth.getToken();
    expect(mocks.getToken).toHaveBeenLastCalledWith(expect.any(Array), false);
    vi.stubEnv("M365_NO_INTERACTIVE", "");
    vi.stubEnv("M365_ENABLE_INTERACTIVE_APPROVAL", "");
    await auth.getTokenForScope(["extra-scope"]);
    expect(mocks.getToken).toHaveBeenLastCalledWith(["extra-scope"], false);
  });

  it("does not fall back to browser credentials after a WAM failure", async () => {
    mocks.getToken.mockRejectedValue(new Error("530084"));
    const auth = await import("./auth.js");
    await expect(auth.getToken()).rejects.toThrow("530084");
    mocks.getToken.mockResolvedValue(null);
    await expect(auth.getToken()).rejects.toThrow("Browser fallback is disabled");
  });
});
