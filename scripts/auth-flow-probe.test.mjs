import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertDisposableCachePath,
  buildDryRunPlan,
  createIsolatedCachePlugin,
  parseArgs,
  sanitizeError,
  TimedLoopbackClient,
  tokenSummary,
  writeRedactedReport,
} from "./auth-flow-probe-lib.mjs";

function fakeJwt(payload) {
  const segment = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${segment}.signature`;
}

describe("auth-flow-probe argument parsing", () => {
  it("defaults to an inert browser dry-run across all audiences", () => {
    const options = parseArgs([]);
    expect(options.execute).toBe(false);
    expect(options.method).toBe("browser");
    expect(options.authority).toBe(
      "https://login.microsoftonline.com/common",
    );
    expect(options.audiences).toEqual(["chat", "bap", "powerplatform"]);
  });

  it("accepts the headless device-code matrix", () => {
    const options = parseArgs([
      "--",
      "--method=device-code",
      "--authority",
      "organizations",
      "--audiences=chat,bap",
      "--incremental-interaction",
      "--execute",
    ]);
    expect(options.method).toBe("device-code");
    expect(options.authority).toBe(
      "https://login.microsoftonline.com/organizations",
    );
    expect(options.audiences).toEqual(["chat", "bap"]);
    expect(options.incrementalInteraction).toBe(true);
    expect(options.execute).toBe(true);
  });

  it("rejects unknown options and audiences", () => {
    expect(() => parseArgs(["--surprise"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["--audiences=graph"])).toThrow(/Unknown audience/);
  });
});

describe("auth-flow-probe safety", () => {
  it("refuses the production cache", () => {
    expect(() =>
      assertDisposableCachePath(
        "/safe-home/.config/opencode-m365/msal-cache.json",
        "/safe-home",
      ),
    ).toThrow(/production MSAL cache/);
  });

  it.runIf(process.platform !== "win32")(
    "refuses a symlink alias to the production cache",
    () => {
      const homeDirectory = mkdtempSync(join(tmpdir(), "auth-probe-home-"));
      const productionDirectory = join(
        homeDirectory,
        ".config",
        "opencode-m365",
      );
      const aliasDirectory = join(homeDirectory, "cache-alias");

      mkdirSync(productionDirectory, { recursive: true });
      symlinkSync(productionDirectory, aliasDirectory, "dir");

      expect(() =>
        assertDisposableCachePath(
          join(aliasDirectory, "msal-cache.json"),
          homeDirectory,
        ),
      ).toThrow(/production MSAL cache/);
    },
  );

  it("persists an isolated cache with private permissions and reloads it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "auth-probe-test-"));
    const cacheFile = join(directory, "cache.json");
    const plugin = createIsolatedCachePlugin(cacheFile);

    await plugin.afterCacheAccess({
      cacheHasChanged: true,
      tokenCache: { serialize: () => '{"cache":"opaque"}' },
    });

    expect(readFileSync(cacheFile, "utf8")).toBe('{"cache":"opaque"}');
    if (process.platform !== "win32") {
      expect(statSync(cacheFile).mode & 0o777).toBe(0o600);
    }

    let loaded;
    await plugin.beforeCacheAccess({
      tokenCache: { deserialize: (value) => (loaded = value) },
    });
    expect(loaded).toBe('{"cache":"opaque"}');
  });

  it("writes reports without broad file permissions", () => {
    const directory = mkdtempSync(join(tmpdir(), "auth-report-test-"));
    const reportFile = join(directory, "report.json");
    writeRedactedReport(reportFile, { status: "ok" });
    expect(JSON.parse(readFileSync(reportFile, "utf8"))).toEqual({
      status: "ok",
    });
    if (process.platform !== "win32") {
      expect(statSync(reportFile).mode & 0o777).toBe(0o600);
    }
  });
});

describe("auth-flow-probe redaction", () => {
  it("summarizes a token without retaining the token or full identity", () => {
    const accessToken = fakeJwt({
      appid: "client-id",
      aud: "https://substrate.office.com/sydney",
      oid: "12345678-aaaa-bbbb-cccc-123456789012",
      scp: "scope.b scope.a",
      tid: "87654321-aaaa-bbbb-cccc-210987654321",
    });
    const summary = tokenSummary({
      accessToken,
      account: {
        homeAccountId: "home-account-sensitive",
        tenantId: "87654321-aaaa-bbbb-cccc-210987654321",
        username: "connor@example.com",
      },
      expiresOn: new Date("2026-07-27T00:00:00Z"),
    });

    expect(summary.account.username).toBe("c***@example.com");
    expect(summary.account.homeAccountId).toBe("home-acc…");
    expect(summary.objectId).toBe("12345678…");
    expect(summary.scopes).toEqual(["scope.a", "scope.b"]);
    expect(JSON.stringify(summary)).not.toContain(accessToken);
    expect(JSON.stringify(summary)).not.toContain(
      "12345678-aaaa-bbbb-cccc-123456789012",
    );
  });

  it("redacts emails, GUIDs, JWTs, and authorization codes from errors", () => {
    const error = new Error(
      "user@example.com code=secret 12345678-aaaa-bbbb-cccc-123456789012 eyJaaaaaaaaaaaaaaaaaaaa.eyJbbbbbbbbbbbbbbbbbbbb.signature",
    );
    const safe = sanitizeError(error);
    expect(safe.message).not.toContain("user@example.com");
    expect(safe.message).not.toContain("secret");
    expect(safe.message).not.toContain("12345678-aaaa");
    expect(safe.message).toContain("<redacted-email>");
  });
});

describe("auth-flow-probe dry-run plan", () => {
  it("includes fresh-client verification and optional incremental interaction", () => {
    const options = parseArgs(["--incremental-interaction"]);
    const plan = buildDryRunPlan(options).join("\n");
    expect(plan).toMatch(/Recreate the MSAL client/);
    expect(plan).toMatch(/acquire bap interactively/);
    expect(plan).toMatch(/redacted JSON report/);
  });
});

describe("auth-flow-probe loopback client", () => {
  it("captures an authorization response and closes cleanly", async () => {
    const client = new TimedLoopbackClient(5_000);
    const responsePromise = client.listenForAuthCode("success", "error");

    let redirectUri;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        redirectUri = client.getRedirectUri();
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+$/);

    const callback = await fetch(`${redirectUri}?code=test-code&state=test-state`, {
      redirect: "manual",
    });
    expect(callback.status).toBe(302);
    await expect(responsePromise).resolves.toMatchObject({
      code: "test-code",
      state: "test-state",
    });
    client.closeServer();
  });
});
