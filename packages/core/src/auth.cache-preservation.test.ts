import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  accounts: [] as Array<{ username: string }>,
  secrets: false,
  failLaunch: false,
  writes: [] as Array<{ path: string; content: string }>,
  events: [] as string[],
  launches: [] as Array<{ persistent: boolean; headless: boolean }>,
  closes: 0,
}));

vi.mock("node:fs", () => ({
  existsSync: (path: string) => path.endsWith("secrets.json") && state.secrets,
  readFileSync: (path: string) => {
    if (!path.endsWith("secrets.json") || !state.secrets) {
      throw new Error("Unexpected mocked read");
    }
    return JSON.stringify({
      email: "synthetic@example.invalid",
      password: "synthetic-not-a-credential",
      mfaSecret: "synthetic-not-an-mfa-secret",
    });
  },
  writeFileSync: (path: string, content: string) => {
    state.writes.push({ path, content: String(content) });
    state.events.push("write");
  },
  mkdirSync: () => undefined,
}));
vi.mock("node:os", () => ({ homedir: () => "/synthetic-audit-home" }));
vi.mock("node:child_process", () => ({
  execSync: () => {
    throw new Error("Child execution blocked by mock");
  },
}));
vi.mock("./log.js", () => ({
  createLogger: () => ({
    info: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  }),
}));

vi.mock("@azure/msal-node", () => ({
  PublicClientApplication: class {
    getTokenCache() {
      return {
        getAllAccounts: () => Promise.resolve([...state.accounts]),
        removeAccount: (account: { username: string }) => {
          state.events.push("remove");
          state.accounts = state.accounts.filter((item) => item !== account);
          return Promise.resolve();
        },
        serialize: () => JSON.stringify({ accounts: state.accounts }),
        deserialize: () => {
          throw new Error("Real cache loading is forbidden");
        },
      };
    }
    getAuthCodeUrl() {
      return Promise.resolve("https://example.invalid/mock-authorise");
    }
    acquireTokenByCode() {
      return Promise.resolve({
        accessToken: "synthetic-token",
        account: { username: "synthetic@example.invalid" },
      });
    }
    acquireTokenSilent() {
      return Promise.reject(new Error("Silent acquisition not expected in these probes"));
    }
    acquireTokenByRefreshToken() {
      return Promise.reject(new Error("Refresh-token exchange forbidden"));
    }
  },
  CryptoProvider: class {
    generatePkceCodes() {
      return Promise.resolve({ verifier: "synthetic-verifier", challenge: "synthetic-challenge" });
    }
  },
}));

vi.mock("playwright", () => {
  function launch(persistent: boolean, options: { headless: boolean }) {
    state.events.push("launch");
    state.launches.push({ persistent, headless: options.headless });
    if (state.failLaunch) return Promise.reject(new Error("Synthetic browser launch failure"));
    let requestListener: ((request: { url: () => string }) => void) | undefined;
    const page = {
      on: (event: string, callback: typeof requestListener) => {
        if (event === "request") requestListener = callback;
      },
      goto: () => {
        requestListener?.({
          url: () => "https://example.invalid/oauth2/nativeclient?code=synthetic-code",
        });
        return Promise.resolve();
      },
      screenshot: () => Promise.resolve(),
      content: () => Promise.resolve("Synthetic page only"),
      url: () => "https://example.invalid/mock-page",
    };
    return Promise.resolve({
      newPage: () => Promise.resolve(page),
      close: () => {
        state.closes++;
        return Promise.resolve();
      },
    });
  }
  return {
    chromium: {
      launch: (options: { headless: boolean }) => launch(false, options),
      launchPersistentContext: (_path: string, options: { headless: boolean }) =>
        launch(true, options),
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  state.accounts = [];
  state.secrets = false;
  state.failLaunch = false;
  state.writes = [];
  state.events = [];
  state.launches = [];
  state.closes = 0;
  vi.stubEnv("M365_CACHE_FILE", "/synthetic-audit-home/msal-cache.json");
  vi.stubEnv("M365_SECRETS_FILE", "/synthetic-audit-home/secrets.json");
  vi.stubEnv("CHROMIUM_PATH", "/synthetic-browser-not-executed");
  vi.stubEnv("M365_REFRESH_TOKEN", "");
  vi.stubEnv("M365_NO_INTERACTIVE", "");
  vi.stubEnv("M365_ENABLE_INTERACTIVE_APPROVAL", "");
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("V4-014: failed replacement preserves cached accounts without persisting removal", async () => {
  const account = { username: "synthetic@example.invalid" };
  state.accounts = [account];
  state.secrets = true;
  state.failLaunch = true;
  vi.stubEnv("M365_NO_INTERACTIVE", "1");
  const auth = await import("./auth.js");
  expect(await auth.forceReauth()).toBe(false);
  expect(state.accounts).toEqual([account]);
  expect(state.events).not.toContain("remove");
  expect(state.writes.filter((item) => item.path.endsWith("msal-cache.json"))).toEqual([]);
});
