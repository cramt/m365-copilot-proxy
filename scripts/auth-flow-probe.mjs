#!/usr/bin/env node
/**
 * Phase 0 SSO compatibility probe.
 *
 * This is deliberately separate from the production auth path. It is inert
 * unless --execute is supplied and uses a throwaway MSAL cache by default.
 * It never calls M365 chat, never reads secrets.json, and never prints tokens.
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertDisposableCachePath,
  buildDryRunPlan,
  CLIENT_ID,
  createIsolatedCachePlugin,
  NATIVECLIENT_REDIRECT_URI,
  parseArgs,
  sanitizeError,
  SCOPE_SETS,
  TimedLoopbackClient,
  tokenSummary,
  writeRedactedReport,
} from "./auth-flow-probe-lib.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SCRIPT_DIR);
const coreRequire = createRequire(
  new URL("../packages/core/package.json", import.meta.url),
);

const HELP = `Phase 0 Microsoft SSO compatibility probe

Dry-run (default; no network or browser):
  pnpm run probe:auth -- --method=browser

Run one isolated flow:
  pnpm run probe:auth -- --method=browser --execute
  pnpm run probe:auth -- --method=device-code --authority=organizations --execute

Options:
  --method=browser|device-code|nativeclient-visible
  --authority=common|organizations|<tenant-id-or-domain>
  --audiences=chat,bap,powerplatform
  --incremental-interaction   Interact again when a secondary audience cannot be silent
  --silent-only              Test an existing --cache without interaction
  --cache=<absolute-path>    Explicit isolated cache (production path is refused)
  --reuse-cache              Permit an existing explicit cache
  --keep-cache               Retain an auto-created temporary cache after the run
  --login-hint=<email>       Pass a hint to Microsoft; never persisted in the report
  --prompt=select_account|login|none
  --no-open                  Print the browser URL instead of launching it
  --chromium=<path>          Browser for nativeclient-visible
  --browser-profile=<path>   Isolated profile for nativeclient-visible
  --timeout=<seconds>        30-900 (default 180)
  --json-out=<path>          Redacted report destination
  --allow-non-tty            Allow an executing probe without an attached terminal
  --execute                  Required for any Microsoft network/auth interaction
  --help

Safety:
  - The default cache is a new directory under the OS temp directory.
  - ~/.config/opencode-m365/msal-cache.json is always refused.
  - Reports redact account IDs, tenant IDs, usernames, auth codes, and tokens.
  - This probe consumes zero M365 chat messages.
`;

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function printDryRun(options) {
  console.log("DRY RUN — no Microsoft request or browser interaction will occur.\n");
  console.log(`method:     ${options.method}`);
  console.log(`authority:  ${options.authority}`);
  console.log(`audiences:  ${options.audiences.join(", ")}`);
  console.log(`cache:      ${options.cache ? "explicit isolated path" : "temporary"}`);
  console.log("\nplanned steps:");
  buildDryRunPlan(options).forEach((step, index) => {
    console.log(`  ${index + 1}. ${step}`);
  });
  console.log("\nAdd --execute to run this probe.");
}

function createApp(msal, authority, cacheFile) {
  return new msal.PublicClientApplication({
    auth: {
      authority,
      clientId: CLIENT_ID,
    },
    cache: {
      cachePlugin: createIsolatedCachePlugin(cacheFile),
    },
  });
}

async function openSystemBrowser(url, noOpen) {
  if (noOpen) {
    console.log("\nOpen this one-time Microsoft authorization URL in your browser:");
    console.log(url);
    return;
  }

  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "explorer.exe", args: [url] }
        : { file: "xdg-open", args: [url] };

  try {
    await new Promise((resolveSpawn, rejectSpawn) => {
      const child = spawn(command.file, command.args, {
        detached: true,
        stdio: "ignore",
      });
      child.once("error", rejectSpawn);
      child.once("spawn", () => {
        child.unref();
        resolveSpawn();
      });
    });
    console.log("Opened the Microsoft sign-in page in the system browser.");
  } catch (error) {
    console.log(`Could not launch the browser (${sanitizeError(error).message}).`);
    console.log("Open this one-time Microsoft authorization URL manually:");
    console.log(url);
  }
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const timeoutPromise = new Promise((_, rejectTimeout) => {
    timeout = setTimeout(
      () => rejectTimeout(new Error(`${label} timed out after ${timeoutMs / 1000}s`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() =>
    clearTimeout(timeout),
  );
}

async function acquireNativeclientVisible({
  app,
  msal,
  options,
  profileDirectory,
  scopes,
}) {
  const { chromium } = coreRequire("playwright");
  const cryptoProvider = new msal.CryptoProvider();
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
  const authUrl = await app.getAuthCodeUrl({
    authority: options.authority,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    loginHint: options.loginHint ?? undefined,
    prompt: options.prompt,
    redirectUri: NATIVECLIENT_REDIRECT_URI,
    scopes,
  });
  const expectedState = new URL(authUrl).searchParams.get("state");

  mkdirSync(profileDirectory, { recursive: true, mode: 0o700 });
  try {
    chmodSync(profileDirectory, 0o700);
  } catch {
    // Best effort on non-POSIX platforms.
  }

  const context = await chromium.launchPersistentContext(profileDirectory, {
    executablePath:
      options.chromium ?? process.env.CHROMIUM_PATH ?? undefined,
    headless: false,
    args:
      typeof process.getuid === "function" && process.getuid() === 0
        ? ["--no-sandbox"]
        : [],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  let settle;
  const callback = new Promise((resolveCallback, rejectCallback) => {
    settle = { resolveCallback, rejectCallback };
  });

  page.on("request", (request) => {
    try {
      const url = new URL(request.url());
      const isNativeclient =
        url.origin === "https://login.microsoftonline.com" &&
        /\/oauth2\/nativeclient$/i.test(url.pathname);
      if (!isNativeclient) return;

      const returnedState = url.searchParams.get("state");
      if (!expectedState || returnedState !== expectedState) {
        settle.rejectCallback(
          new Error("Microsoft callback state did not match the authorization request"),
        );
        return;
      }

      const oauthError = url.searchParams.get("error");
      if (oauthError) {
        settle.rejectCallback(
          new Error(
            `${oauthError}: ${url.searchParams.get("error_description") ?? "authorization failed"}`,
          ),
        );
        return;
      }

      const code = url.searchParams.get("code");
      if (code) settle.resolveCallback(code);
    } catch {
      // Ignore unrelated/non-URL browser requests.
    }
  });

  try {
    console.log(
      "A visible isolated Chromium window will open. Complete every Microsoft sign-in step yourself.",
    );
    await page.goto(authUrl, { waitUntil: "domcontentloaded" });
    const code = await withTimeout(
      callback,
      options.timeoutMs,
      "nativeclient-visible authorization",
    );
    return app.acquireTokenByCode({
      authority: options.authority,
      code,
      codeVerifier: verifier,
      redirectUri: NATIVECLIENT_REDIRECT_URI,
      scopes,
    });
  } finally {
    await context.close();
  }
}

async function acquireInteractively({
  app,
  msal,
  options,
  profileDirectory,
  scopes,
}) {
  if (options.method === "browser") {
    return app.acquireTokenInteractive({
      authority: options.authority,
      loginHint: options.loginHint ?? undefined,
      loopbackClient: new TimedLoopbackClient(options.timeoutMs),
      openBrowser: (url) => openSystemBrowser(url, options.noOpen),
      prompt: options.prompt,
      scopes,
      successTemplate:
        "<h1>Microsoft sign-in succeeded</h1><p>You can close this window and return to the terminal.</p>",
      errorTemplate:
        "<h1>Microsoft sign-in failed</h1><p>Return to the terminal for a redacted diagnostic.</p>",
    });
  }

  if (options.method === "device-code") {
    return app.acquireTokenByDeviceCode({
      authority: options.authority,
      deviceCodeCallback(response) {
        console.log("\nMicrosoft device sign-in:");
        console.log(response.message);
        console.log(
          "The code is short-lived and is intentionally not written to the JSON report.",
        );
      },
      scopes,
      timeout: Math.ceil(options.timeoutMs / 1000),
    });
  }

  return acquireNativeclientVisible({
    app,
    msal,
    options,
    profileDirectory,
    scopes,
  });
}

async function findAccount(app, homeAccountId) {
  const accounts = await app.getTokenCache().getAllAccounts();
  if (!homeAccountId) {
    if (accounts.length !== 1) {
      throw new Error(
        `Expected exactly one cached account, found ${accounts.length}`,
      );
    }
    return accounts[0];
  }
  const account = accounts.find(
    (candidate) => candidate.homeAccountId === homeAccountId,
  );
  if (!account) {
    throw new Error("The account returned by the interaction is missing from the disk cache");
  }
  return account;
}

function assertSameAccount(expected, actual) {
  if (
    expected.homeAccountId !== actual.homeAccountId ||
    expected.tenantId !== actual.tenantId
  ) {
    throw new Error(
      "Token acquisition switched account or tenant during the compatibility matrix",
    );
  }
}

async function silentAcquire(msal, options, cacheFile, audience, homeAccountId) {
  const app = createApp(msal, options.authority, cacheFile);
  const account = await findAccount(app, homeAccountId);
  const result = await app.acquireTokenSilent({
    account,
    authority: options.authority,
    scopes: SCOPE_SETS[audience],
  });
  return { account, result };
}

async function runMatrix({ msal, options, cacheFile, profileDirectory, report }) {
  let selectedAccount;

  if (options.silentOnly) {
    if (!options.cache || !options.reuseCache) {
      throw new Error("--silent-only requires --cache=<path> and --reuse-cache");
    }
    for (const audience of options.audiences) {
      try {
        const { account, result } = await silentAcquire(
          msal,
          options,
          cacheFile,
          audience,
          selectedAccount?.homeAccountId,
        );
        selectedAccount ??= account;
        assertSameAccount(selectedAccount, account);
        report.audiences[audience] = {
          silent: { ok: true, token: tokenSummary(result) },
        };
        console.log(`[${audience}] silent: OK`);
      } catch (error) {
        report.audiences[audience] = {
          silent: { error: sanitizeError(error), ok: false },
        };
        console.log(`[${audience}] silent: FAILED (${sanitizeError(error).message})`);
      }
    }
    return;
  }

  const firstAudience = options.audiences[0];
  console.log(
    `[${firstAudience}] starting ${options.method} interaction against ${options.authority}`,
  );
  const firstApp = createApp(msal, options.authority, cacheFile);
  const firstResult = await acquireInteractively({
    app: firstApp,
    msal,
    options,
    profileDirectory,
    scopes: SCOPE_SETS[firstAudience],
  });
  if (!firstResult?.account) {
    throw new Error("Interactive acquisition returned no account");
  }
  selectedAccount = firstResult.account;
  report.audiences[firstAudience] = {
    interactive: {
      method: options.method,
      ok: true,
      token: tokenSummary(firstResult),
    },
  };
  console.log(`[${firstAudience}] interactive: OK`);

  const restart = await silentAcquire(
    msal,
    options,
    cacheFile,
    firstAudience,
    selectedAccount.homeAccountId,
  );
  assertSameAccount(selectedAccount, restart.account);
  report.audiences[firstAudience].restartSilent = {
    ok: true,
    token: tokenSummary(restart.result),
  };
  console.log(`[${firstAudience}] fresh-client silent: OK`);

  for (const audience of options.audiences.slice(1)) {
    try {
      const silent = await silentAcquire(
        msal,
        options,
        cacheFile,
        audience,
        selectedAccount.homeAccountId,
      );
      assertSameAccount(selectedAccount, silent.account);
      report.audiences[audience] = {
        silent: { ok: true, token: tokenSummary(silent.result) },
      };
      console.log(`[${audience}] incremental silent: OK`);
      continue;
    } catch (error) {
      report.audiences[audience] = {
        silent: { error: sanitizeError(error), ok: false },
      };
      console.log(
        `[${audience}] incremental silent: FAILED (${sanitizeError(error).message})`,
      );
    }

    if (!options.incrementalInteraction) continue;

    const app = createApp(msal, options.authority, cacheFile);
    const result = await acquireInteractively({
      app,
      msal,
      options,
      profileDirectory,
      scopes: SCOPE_SETS[audience],
    });
    if (!result?.account) {
      throw new Error(`Interactive ${audience} acquisition returned no account`);
    }
    assertSameAccount(selectedAccount, result.account);
    report.audiences[audience].interactive = {
      method: options.method,
      ok: true,
      token: tokenSummary(result),
    };
    console.log(`[${audience}] incremental interaction: OK`);

    const restartResult = await silentAcquire(
      msal,
      options,
      cacheFile,
      audience,
      selectedAccount.homeAccountId,
    );
    assertSameAccount(selectedAccount, restartResult.account);
    report.audiences[audience].restartSilent = {
      ok: true,
      token: tokenSummary(restartResult.result),
    };
    console.log(`[${audience}] post-interaction fresh-client silent: OK`);
  }
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`Argument error: ${error.message}\n`);
  console.error(HELP);
  process.exit(2);
}

if (options.help) {
  console.log(HELP);
  process.exit(0);
}

if (!options.execute) {
  printDryRun(options);
  process.exit(0);
}

if (!process.stdout.isTTY && !options.allowNonTty) {
  console.error(
    "Refusing an interactive authentication probe without a TTY. Re-run in a terminal, or pass --allow-non-tty deliberately.",
  );
  process.exit(2);
}

const msal = coreRequire("@azure/msal-node");
const msalPackage = coreRequire("@azure/msal-node/package.json");
const runId = timestampId();
const reportDirectory = join(REPO_ROOT, "scripts", "auth-flow-probe-out");
mkdirSync(reportDirectory, { recursive: true, mode: 0o700 });
try {
  chmodSync(reportDirectory, 0o700);
} catch {
  // Best effort on platforms that do not support POSIX modes.
}

let reportFile;
try {
  reportFile = assertDisposableCachePath(
    options.jsonOut ?? join(reportDirectory, `run-${runId}.json`),
  );
} catch (error) {
  console.error(sanitizeError(error).message);
  process.exit(2);
}

let temporaryDirectory = null;
let cacheFile;
if (options.cache) {
  try {
    cacheFile = assertDisposableCachePath(options.cache);
  } catch (error) {
    console.error(sanitizeError(error).message);
    process.exit(2);
  }
  if (existsSync(cacheFile) && !options.reuseCache) {
    console.error(
      `Refusing to overwrite existing cache ${cacheFile}. Pass --reuse-cache only when that isolated cache is intentional.`,
    );
    process.exit(2);
  }
  mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 });
} else {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "m365-auth-flow-probe-"));
  chmodSync(temporaryDirectory, 0o700);
  cacheFile = join(temporaryDirectory, "msal-cache.json");
}

if (resolve(reportFile) === resolve(cacheFile)) {
  console.error("--json-out and --cache must be different files.");
  process.exit(2);
}

const profileDirectory =
  options.browserProfile ??
  join(temporaryDirectory ?? dirname(cacheFile), "browser-profile");
const report = {
  audiences: {},
  completedAt: null,
  configuration: {
    audiences: options.audiences,
    authority: options.authority,
    cache: options.cache ? "explicit-isolated" : "temporary",
    incrementalInteraction: options.incrementalInteraction,
    method: options.method,
    prompt: options.prompt ?? null,
    silentOnly: options.silentOnly,
  },
  environment: {
    msalNode: msalPackage.version,
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  },
  error: null,
  runId,
  startedAt: new Date().toISOString(),
  status: "running",
};

console.log("Phase 0 SSO compatibility probe");
console.log(`  method=${options.method}`);
console.log(`  authority=${options.authority}`);
console.log(`  audiences=${options.audiences.join(",")}`);
console.log("  cache=isolated (production cache is not read or written)");
console.log("  chat quota=0 messages\n");

try {
  await runMatrix({
    cacheFile,
    msal,
    options,
    profileDirectory,
    report,
  });
  const failures = options.audiences.some(
    (audience) =>
      !report.audiences[audience]?.restartSilent?.ok &&
      !report.audiences[audience]?.silent?.ok,
  );
  report.status = failures ? "partial" : "succeeded";
  process.exitCode = failures ? 1 : 0;
} catch (error) {
  report.error = sanitizeError(error);
  report.status = "failed";
  process.exitCode = 1;
  console.error(`\nProbe failed: ${report.error.message}`);
} finally {
  report.completedAt = new Date().toISOString();
  writeRedactedReport(reportFile, report);
  console.log(`\nRedacted report: ${reportFile}`);

  if (temporaryDirectory && !options.keepCache) {
    rmSync(temporaryDirectory, { force: true, recursive: true });
    console.log("Temporary token cache removed.");
  } else if (temporaryDirectory) {
    console.log(`Temporary token cache retained at: ${cacheFile}`);
  }
}
