import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  platform: "win32",
  available: true,
  getAllAccounts: vi.fn(),
  acquireTokenSilent: vi.fn(),
  acquireTokenInteractive: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  construct: vi.fn(),
}));

vi.mock("node:os", () => ({ platform: () => mocks.platform }));
vi.mock("node:fs", () => ({
  readFileSync: mocks.readFileSync,
  writeFileSync: mocks.writeFileSync,
  mkdirSync: mocks.mkdirSync,
}));
vi.mock("./log.js", () => ({
  createLogger: () => ({ info: vi.fn() }),
}));
vi.mock("@azure/msal-node-extensions", () => ({
  NativeBrokerPlugin: class {
    isBrokerAvailable = mocks.available;
  },
}));
vi.mock("@azure/msal-node", () => ({
  PublicClientApplication: class {
    constructor(config: unknown) { mocks.construct(config); }
    getAllAccounts = mocks.getAllAccounts;
    acquireTokenSilent = mocks.acquireTokenSilent;
    acquireTokenInteractive = mocks.acquireTokenInteractive;
  },
}));

import { createWamAuth } from "./wam-auth.js";

const account = { username: "work@example.com", nativeAccountId: "selected" };
const other = { username: "other@example.com", nativeAccountId: "other" };
const token = {
  accessToken: "test-access-token",
  refreshToken: "must-not-be-persisted",
  fromPlatformBroker: true,
  account,
};
const options = {
  clientId: "test-client",
  authority: "https://login.microsoftonline.com/common",
  accountFile: "test-wam-account.json",
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("M365_LOGIN_HINT", "");
  vi.stubEnv("M365_WAM_WINDOW_HANDLE", "");
  mocks.platform = "win32";
  mocks.available = true;
  mocks.readFileSync.mockImplementation(() => { throw new Error("ENOENT"); });
  mocks.getAllAccounts.mockResolvedValue([account]);
  mocks.acquireTokenSilent.mockResolvedValue(token);
  mocks.acquireTokenInteractive.mockResolvedValue(token);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("WAM authentication", () => {
  it("uses the broker's account list and silently acquires each requested scope", async () => {
    const auth = createWamAuth(options);
    await expect(auth.getToken(["chat"], false)).resolves.toBe(token.accessToken);
    await expect(auth.getToken(["images"], false)).resolves.toBe(token.accessToken);
    expect(mocks.construct).toHaveBeenCalledTimes(1);
    expect(mocks.acquireTokenSilent.mock.calls.map(([request]) => request.scopes))
      .toEqual([["chat"], ["images"]]);
    expect(mocks.acquireTokenInteractive).not.toHaveBeenCalled();
    expect(JSON.parse(mocks.writeFileSync.mock.calls[0][1])).toEqual({
      clientId: options.clientId, accountId: account.nativeAccountId,
    });
  });

  it("does not choose an arbitrary account or prompt in silent mode", async () => {
    mocks.getAllAccounts.mockResolvedValue([other, account]);
    await expect(createWamAuth(options).getToken(["chat"], false)).resolves.toBeNull();
    expect(mocks.acquireTokenSilent).not.toHaveBeenCalled();
    expect(mocks.acquireTokenInteractive).not.toHaveBeenCalled();
  });

  it("selects the previously chosen broker account when several accounts exist", async () => {
    mocks.getAllAccounts.mockResolvedValue([other, account]);
    mocks.readFileSync.mockReturnValue(JSON.stringify({
      clientId: options.clientId, accountId: account.nativeAccountId,
    }));
    await createWamAuth(options).getToken(["chat"], false);
    expect(mocks.acquireTokenSilent).toHaveBeenCalledWith({ scopes: ["chat"], account });
  });

  it("uses a login hint before a saved account", async () => {
    vi.stubEnv("M365_LOGIN_HINT", "WORK@EXAMPLE.COM");
    mocks.getAllAccounts.mockResolvedValue([other, account]);
    mocks.readFileSync.mockReturnValue(JSON.stringify({
      clientId: options.clientId, accountId: other.nativeAccountId,
    }));
    await createWamAuth(options).getToken(["chat"], false);
    expect(mocks.acquireTokenSilent).toHaveBeenCalledWith({ scopes: ["chat"], account });
  });

  it("only opens the native account picker when interaction is permitted", async () => {
    mocks.acquireTokenSilent.mockRejectedValue(new Error("interaction required"));
    const auth = createWamAuth(options);
    await expect(auth.getToken(["chat"], false)).resolves.toBeNull();
    expect(mocks.acquireTokenInteractive).not.toHaveBeenCalled();
    await expect(auth.getToken(["chat"], true)).resolves.toBe(token.accessToken);
    expect(mocks.acquireTokenInteractive).toHaveBeenCalledWith({
      scopes: ["chat"], prompt: "select_account",
    });
  });

  it("propagates a native policy refusal without returning a token", async () => {
    mocks.getAllAccounts.mockResolvedValue([]);
    mocks.acquireTokenInteractive.mockRejectedValue(new Error("530084"));
    await expect(createWamAuth(options).getToken(["chat"], true)).rejects.toThrow("530084");
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
  });

  it("passes a native parent window handle to the broker account picker", async () => {
    vi.stubEnv("M365_WAM_WINDOW_HANDLE", "42");
    mocks.getAllAccounts.mockResolvedValue([]);
    await createWamAuth(options).getToken(["chat"], true);
    const request = mocks.acquireTokenInteractive.mock.calls[0][0];
    expect(request.windowHandle.readBigUInt64LE()).toBe(42n);
  });

  it("rejects an invalid parent window handle before opening a prompt", async () => {
    vi.stubEnv("M365_WAM_WINDOW_HANDLE", "not-a-window");
    mocks.getAllAccounts.mockResolvedValue([]);
    await expect(createWamAuth(options).getToken(["chat"], true))
      .rejects.toThrow("positive decimal window handle");
    expect(mocks.acquireTokenInteractive).not.toHaveBeenCalled();
  });

  it("rejects non-broker results even if they contain an access token", async () => {
    mocks.acquireTokenSilent.mockResolvedValue({ ...token, fromPlatformBroker: false });
    await expect(createWamAuth(options).getToken(["chat"], false))
      .rejects.toThrow("native broker access token");
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
  });

  it("rejects an account that does not match an explicit login hint", async () => {
    vi.stubEnv("M365_LOGIN_HINT", account.username);
    mocks.getAllAccounts.mockResolvedValue([]);
    mocks.acquireTokenInteractive.mockResolvedValue({ ...token, account: other });
    await expect(createWamAuth(options).getToken(["chat"], true))
      .rejects.toThrow("does not match M365_LOGIN_HINT");
    expect(mocks.writeFileSync).not.toHaveBeenCalled();
  });

  it("fails closed when the platform or native broker is unavailable", async () => {
    mocks.platform = "linux";
    await expect(createWamAuth(options).getToken(["chat"], true)).rejects.toThrow("requires Windows");
    mocks.platform = "win32";
    mocks.available = false;
    await expect(createWamAuth(options).getToken(["chat"], true))
      .rejects.toThrow("broker is unavailable");
    expect(mocks.construct).not.toHaveBeenCalled();
  });
});
