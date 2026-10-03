import * as msal from "@azure/msal-node";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Page } from "playwright";

const CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";
const AUTHORITY = "https://login.microsoftonline.com/common";
const REDIRECT_URI = "https://login.microsoftonline.com/common/oauth2/nativeclient";
const SCOPES = [
  "https://substrate.office.com/sydney/M365Chat.Read",
  "https://substrate.office.com/sydney/sydney.readwrite",
];

import { createLogger } from "./log.js";
const log = createLogger("auth");

const CONFIG_DIR = join(homedir(), ".config", "m365-proxy");

function resolveFile(envVar: string, defaultName: string): string {
  const value = process.env[envVar];
  if (value) return value;
  mkdirSync(CONFIG_DIR, { recursive: true });
  return join(CONFIG_DIR, defaultName);
}

const CACHE_FILE = resolveFile("M365_CACHE_FILE", "msal-cache.json");
const SECRETS_FILE = resolveFile("M365_SECRETS_FILE", "secrets.json");
// Dedicated profile for interactive automation login. Keep separate from a
// daily browser profile to avoid profile-lock conflicts.
const BROWSER_PROFILE_DIR = join(homedir(), ".config", "m365-proxy", "edge-profile");
const SILENT_AUTH_TIMEOUT_MS = 15_000;

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- MSAL cache persistence ---

function loadCache(app: msal.PublicClientApplication) {
  if (existsSync(CACHE_FILE)) {
    try {
      app.getTokenCache().deserialize(readFileSync(CACHE_FILE, "utf-8"));
    } catch {}
  }
}

function saveCache(app: msal.PublicClientApplication) {
  try {
    writeFileSync(CACHE_FILE, app.getTokenCache().serialize());
  } catch {}
}

let _app: msal.PublicClientApplication | null = null;

function getApp(): msal.PublicClientApplication {
  if (!_app) {
    _app = new msal.PublicClientApplication({
      auth: { clientId: CLIENT_ID, authority: AUTHORITY },
    });
    loadCache(_app);
  }
  return _app;
}

// --- PKCE helpers ---

async function buildAuthUrlForScopes(app: msal.PublicClientApplication, scopes: string[]) {
  const cryptoProvider = new msal.CryptoProvider();
  const { verifier, challenge } = await cryptoProvider.generatePkceCodes();

  const authUrl = await app.getAuthCodeUrl({
    scopes,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
  });

  return { authUrl, verifier };
}

// --- Shared browser login ---

const LOGIN_DEBUG_DIR = join(CONFIG_DIR, "login-debug");

interface Credentials {
  email: string;
  password: string;
  mfaSecret: string;
}

/**
 * Resolve a usable Chromium executable. Playwright's bundled chrome-headless-shell
 * is not patched for NixOS (fails on libglib-2.0.so.0), so prefer an explicit
 * CHROMIUM_PATH, then a system browser on PATH. Returns undefined to let
 * Playwright use its bundled browser (works on patched/standard distros).
 */
function resolveChromiumPath(preferEdge = false): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;

  const edgeBins = ["msedge", "microsoft-edge", "microsoft-edge-stable"];
  const chromiumBins = ["chromium", "chromium-browser", "google-chrome", "chrome"];
  const candidateBins = preferEdge
    ? [...edgeBins, ...chromiumBins]
    : [...chromiumBins, ...edgeBins];

  const edgeAppBundles = [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
    "/Applications/Microsoft Edge Dev.app/Contents/MacOS/Microsoft Edge Dev",
    "/Applications/Microsoft Edge Canary.app/Contents/MacOS/Microsoft Edge Canary",
  ];

  if (preferEdge) {
    for (const appPath of edgeAppBundles) {
      if (existsSync(appPath)) {
        log.info(`Resolved Edge app bundle: ${appPath}`);
        return appPath;
      }
    }
  }

  for (const bin of candidateBins) {
    try {
      const found = execSync(`command -v ${bin}`, { stdio: ["ignore", "pipe", "ignore"] })
        .toString()
        .trim();
      if (found) {
        log.info(`Resolved system browser: ${found}`);
        return found;
      }
    } catch {
      // not on PATH, try next
    }
  }

  // macOS app bundles are often not on PATH.
  for (const appPath of edgeAppBundles) {
    if (existsSync(appPath)) {
      log.info(`Resolved Edge app bundle: ${appPath}`);
      return appPath;
    }
  }

  return undefined;
}

function isInteractiveLoginAllowed(): boolean {
  return process.env.M365_NO_INTERACTIVE !== "1";
}

async function capture(page: Page, label: string): Promise<void> {
  try {
    mkdirSync(LOGIN_DEBUG_DIR, { recursive: true });
    await page.screenshot({
      path: join(LOGIN_DEBUG_DIR, `${label}.png`),
      fullPage: true,
    });
    writeFileSync(join(LOGIN_DEBUG_DIR, `${label}.html`), await page.content());
    // Write the URL unconditionally (independent of the debug-log flag).
    writeFileSync(join(LOGIN_DEBUG_DIR, `${label}.url.txt`), page.url());
    log.info(`Captured ${label} — url: ${page.url()}`);
  } catch (error: unknown) {
    log.error(`Failed to capture ${label}: ${getErrorMessage(error)}`);
  }
}

/**
 * Fill a visible input and verify the value actually landed. The converged AAD
 * login page keeps hidden duplicate inputs around, so a naive fill can target a
 * stale hidden node and leave the visible field empty. Refill via typing if so.
 */
async function fillVerified(
  page: Page,
  selector: string,
  value: string,
  label: string,
): Promise<void> {
  const loc = page.locator(`${selector}:visible`).first();
  await loc.waitFor({ state: "visible", timeout: 20000 });
  await loc.click();
  await loc.fill(value);
  let got = await loc.inputValue();
  if (got !== value) {
    log.info(`${label}: fill mismatch (${got.length} chars), retyping`);
    await loc.fill("");
    await loc.pressSequentially(value, { delay: 20 });
    got = await loc.inputValue();
  }
  if (got !== value) {
    throw new Error(`${label}: field still empty after refill`);
  }
}

/** Click the visible primary submit button (Next / Sign in / Verify / Yes). */
async function clickSubmit(page: Page): Promise<void> {
  await page.locator('input[type="submit"]:visible, button[type="submit"]:visible').first().click();
}

/** Drive the Azure AD interactive login form using stored credentials + TOTP. */
async function driveAzureLogin(page: Page, creds: Credentials): Promise<void> {
  const { TOTP } = await import("otpauth");

  await capture(page, "step0-landing");

  log.info("Step: email");
  await fillVerified(page, 'input[name="loginfmt"]', creds.email, "email");
  await clickSubmit(page);
  await capture(page, "step1-after-email");

  log.info("Step: password");
  await fillVerified(page, 'input[name="passwd"]', creds.password, "password");
  await clickSubmit(page);
  await capture(page, "step2-after-password");

  log.info("Step: mfa");
  const otpCode = new TOTP({ secret: creds.mfaSecret }).generate();
  await fillVerified(page, 'input[name="otc"]', otpCode, "otc");
  await clickSubmit(page);
  await capture(page, "step3-after-mfa");

  // "Stay signed in?" — may or may not appear
  log.info("Step: stay-signed-in");
  try {
    await page.locator("#idSIButton9:visible").click({ timeout: 8000 });
  } catch {
    // not shown
  }
}

/**
 * Acquire a token for the given scopes via browser login.
 * - With creds: headless autofill + retry loop.
 * - Without creds: interactive manual login in a visible browser window.
 */
interface BrowserLoginOptions {
  attempts?: number;
  interactive?: boolean;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  if (typeof error === "string") return error;
  return "Unknown error";
}

function isProfileLockError(err: unknown): boolean {
  const message = getErrorMessage(err);
  return /ProcessSingleton|SingletonLock|profile directory\s+is\s+already\s+in\s+use/i.test(
    message,
  );
}

async function runBrowserLogin(
  app: msal.PublicClientApplication,
  scopes: string[],
  creds: Credentials | null,
  options: BrowserLoginOptions = {},
): Promise<string | null> {
  const { chromium } = await import("playwright");
  const interactive = options.interactive ?? false;
  const attempts = options.attempts ?? (interactive ? 1 : 3);
  const usePersistentProfile = interactive && !creds;
  const launchArgs = ["--no-sandbox", "--disable-dev-shm-usage"];

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { authUrl, verifier } = await buildAuthUrlForScopes(app, scopes);
    const executablePath = resolveChromiumPath(interactive);
    let page: Page;
    let closeTarget: { close: () => Promise<void> };
    if (usePersistentProfile) {
      mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
      try {
        const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
          headless: false,
          executablePath,
          args: launchArgs,
        });
        page = await context.newPage();
        closeTarget = context;
        log.info(`Interactive login using persistent profile: ${BROWSER_PROFILE_DIR}`);
      } catch (err: unknown) {
        if (!isProfileLockError(err)) throw err;
        log.info(
          `Interactive profile is locked, falling back to a temporary browser profile: ${getErrorMessage(err)}`,
        );
        const browser = await chromium.launch({
          headless: false,
          executablePath,
          args: launchArgs,
        });
        page = await browser.newPage();
        closeTarget = browser;
      }
    } else {
      const browser = await chromium.launch({
        headless: !interactive,
        executablePath,
        args: launchArgs,
      });
      page = await browser.newPage();
      closeTarget = browser;
    }

    // The nativeclient redirect URI is meant for embedded native hosts to
    // intercept; a real browser follows it one hop further to /common/wrongplace,
    // so the ?code= only exists transiently. Capture it from the navigation
    // request itself rather than waiting for the URL to settle.
    let resolveCode: (code: string) => void;
    const codePromise = new Promise<string>((res) => {
      resolveCode = res;
    });
    page.on("request", (req) => {
      const u = req.url();
      if (u.includes("/oauth2/nativeclient") && u.includes("code=")) {
        const c = new URL(u).searchParams.get("code");
        if (c) {
          log.info("Captured auth code from nativeclient redirect");
          resolveCode(c);
        }
      }
    });

    try {
      log.info(`Browser login attempt ${attempt}/${attempts} for [${scopes.join(", ")}]`);
      await page.goto(authUrl, { waitUntil: "domcontentloaded" });
      if (creds) {
        await driveAzureLogin(page, creds);
      } else {
        log.info("Interactive login: complete sign-in and MFA in the opened browser window");
        await capture(page, "interactive-landing");
      }

      const authCode = await Promise.race([
        codePromise,
        new Promise<string>((_, rej) =>
          setTimeout(
            () => rej(new Error("Timed out waiting for auth code")),
            interactive ? 5 * 60_000 : 30_000,
          ),
        ),
      ]);

      const result = await app.acquireTokenByCode({
        code: authCode,
        scopes,
        redirectUri: REDIRECT_URI,
        codeVerifier: verifier,
      });
      saveCache(app);
      log.info(`Browser login succeeded as ${result.account?.username}`);
      return result.accessToken;
    } catch (err: unknown) {
      await capture(page, `attempt-${attempt}-fail`);
      log.error(`Browser login attempt ${attempt}/${attempts} failed: ${getErrorMessage(err)}`);
      if (creds && attempt < attempts) {
        // Wait for a fresh TOTP window so the next code isn't a reused one.
        await new Promise((r) => setTimeout(r, 31_000));
      }
    } finally {
      await closeTarget.close();
    }
  }
  return null;
}

// --- Token acquisition methods ---

export async function getTokenSilent(): Promise<string | null> {
  const app = getApp();
  const accounts = await app.getTokenCache().getAllAccounts();
  if (accounts.length === 0) return null;

  try {
    log.info(
      `getTokenSilent: trying silent token (${accounts.length} cached account(s), ${SILENT_AUTH_TIMEOUT_MS}ms timeout)`,
    );
    const result = await withTimeout(
      app.acquireTokenSilent({
        scopes: SCOPES,
        account: accounts[0],
      }),
      SILENT_AUTH_TIMEOUT_MS,
      "acquireTokenSilent",
    );
    if (!result?.accessToken) {
      log.info("getTokenSilent: silent acquisition returned no access token");
      return null;
    }
    saveCache(app);
    return result.accessToken;
  } catch (err: unknown) {
    log.info(`getTokenSilent: silent acquisition failed (${getErrorMessage(err)})`);
    return null;
  }
}

async function getTokenFromRefreshToken(scopes: string[]): Promise<string | null> {
  const refreshToken = process.env.M365_REFRESH_TOKEN?.trim();
  if (!refreshToken) return null;

  const app = getApp();
  try {
    const result = await app.acquireTokenByRefreshToken({
      refreshToken,
      scopes,
    });
    if (!result?.accessToken) {
      log.error("M365_REFRESH_TOKEN token exchange returned no access token");
      return null;
    }
    saveCache(app);
    log.info("Token acquired from M365_REFRESH_TOKEN");
    return result.accessToken;
  } catch (err: unknown) {
    log.error(`M365_REFRESH_TOKEN token exchange failed: ${getErrorMessage(err)}`);
    return null;
  }
}

export async function loginAutomated(
  email: string,
  password: string,
  mfaSecret: string,
): Promise<string> {
  const app = getApp();
  log.info("Starting automated login...");
  const token = await runBrowserLogin(app, SCOPES, { email, password, mfaSecret }, { attempts: 1 });
  if (!token) {
    throw new Error(`Automated login failed — see artifacts in ${LOGIN_DEBUG_DIR}`);
  }
  return token;
}

export async function loginInteractive(scopes: string[] = SCOPES): Promise<string> {
  if (!isInteractiveLoginAllowed()) {
    throw new Error("Interactive login disabled by M365_NO_INTERACTIVE=1");
  }
  const app = getApp();
  log.info("Starting interactive browser login (manual sign-in)...");
  const token = await runBrowserLogin(app, scopes, null, { interactive: true, attempts: 1 });
  if (!token) {
    throw new Error(`Interactive login failed — see artifacts in ${LOGIN_DEBUG_DIR}`);
  }
  return token;
}

// Force a fresh login (new tokens), bypassing the silent cache. This is the
// throttle-recovery lever from docs/hypotheses.md §9 F13: account degradation is
// thread-rate, and fresh tokens clear it. Single-flight so concurrent triggers
// share one login instead of racing several browsers against the account.
let inflightReauth: Promise<boolean> | null = null;

export function forceReauth(): Promise<boolean> {
  if (inflightReauth) return inflightReauth;
  inflightReauth = doForceReauth().finally(() => {
    inflightReauth = null;
  });
  return inflightReauth;
}

async function doForceReauth(): Promise<boolean> {
  const secrets = loadSecrets();
  if (!secrets && !isInteractiveLoginAllowed()) {
    log.error("forceReauth: no secrets file and interactive login disabled");
    return false;
  }
  try {
    const app = getApp();
    // Drop cached accounts so nothing can silently reuse the throttled token.
    const accounts = await app.getTokenCache().getAllAccounts();
    for (const acct of accounts) await app.getTokenCache().removeAccount(acct);
    saveCache(app);
    log.info("forceReauth: cleared cached accounts, doing fresh login");
    if (secrets) {
      try {
        await loginAutomated(secrets.email, secrets.password, secrets.mfaSecret);
      } catch (err: unknown) {
        if (!isInteractiveLoginAllowed()) throw err;
        log.info(
          `forceReauth: automated login failed (${getErrorMessage(err)}), prompting interactive sign-in`,
        );
        await loginInteractive();
      }
    } else {
      await loginInteractive();
    }
    log.info("forceReauth: fresh login succeeded");
    return true;
  } catch (err: unknown) {
    log.error(`forceReauth failed: ${getErrorMessage(err)}`);
    return false;
  }
}

function isCredentials(value: unknown): value is Credentials {
  return (
    typeof value === "object" &&
    value !== null &&
    "email" in value &&
    typeof value.email === "string" &&
    value.email.length > 0 &&
    "password" in value &&
    typeof value.password === "string" &&
    value.password.length > 0 &&
    "mfaSecret" in value &&
    typeof value.mfaSecret === "string" &&
    value.mfaSecret.length > 0
  );
}

export function loadSecrets(): {
  email: string;
  password: string;
  mfaSecret: string;
} | null {
  if (!existsSync(SECRETS_FILE)) return null;
  try {
    const data: unknown = JSON.parse(readFileSync(SECRETS_FILE, "utf-8"));
    if (isCredentials(data)) return data;
  } catch {}
  return null;
}

export async function getTokenForScope(scopes: string[]): Promise<string | null> {
  const app = getApp();
  const accounts = await app.getTokenCache().getAllAccounts();
  log.info(`getTokenForScope: ${scopes.join(",")} — ${accounts.length} accounts in cache`);

  if (accounts.length > 0) {
    try {
      const result = await withTimeout(
        app.acquireTokenSilent({
          scopes,
          account: accounts[0],
        }),
        SILENT_AUTH_TIMEOUT_MS,
        "acquireTokenSilent(scoped)",
      );
      if (!result?.accessToken) {
        log.info("getTokenForScope: silent acquisition returned no access token");
      } else {
        saveCache(app);
        return result.accessToken;
      }
    } catch (err: unknown) {
      log.info(`getTokenForScope: silent failed (${getErrorMessage(err)}), trying browser login`);
    }
  }

  const fromRefreshToken = await getTokenFromRefreshToken(scopes);
  if (fromRefreshToken) return fromRefreshToken;

  // Silent unavailable — fall back to browser login.
  const secrets = loadSecrets();
  if (secrets) {
    const automated = await runBrowserLogin(app, scopes, secrets);
    if (automated) return automated;
    if (isInteractiveLoginAllowed()) {
      log.info("getTokenForScope: automated login failed, prompting interactive sign-in");
      return runBrowserLogin(app, scopes, null, { interactive: true, attempts: 1 });
    }
    return null;
  }
  if (!isInteractiveLoginAllowed()) {
    log.error("getTokenForScope: no secrets and interactive login disabled");
    return null;
  }
  return runBrowserLogin(app, scopes, null, { interactive: true, attempts: 1 });
}

// Serialize token acquisition: concurrent callers share one in-flight login
// instead of racing several browser logins against the same account.
let inflightToken: Promise<string> | null = null;

export function getToken(): Promise<string> {
  if (inflightToken) return inflightToken;
  inflightToken = doGetToken().finally(() => {
    inflightToken = null;
  });
  return inflightToken;
}

async function doGetToken(): Promise<string> {
  const silent = await getTokenSilent();
  if (silent) {
    log.info("Token refreshed silently");
    return silent;
  }

  const fromRefreshToken = await getTokenFromRefreshToken(SCOPES);
  if (fromRefreshToken) return fromRefreshToken;

  const secrets = loadSecrets();
  if (secrets) {
    try {
      return await loginAutomated(secrets.email, secrets.password, secrets.mfaSecret);
    } catch (err: unknown) {
      if (isInteractiveLoginAllowed()) {
        log.info(`Automated login failed (${getErrorMessage(err)}), prompting interactive sign-in`);
        return loginInteractive(SCOPES);
      }
      throw err;
    }
  }
  if (isInteractiveLoginAllowed()) {
    return loginInteractive(SCOPES);
  }
  throw new Error(
    "No cached token, no secrets.json, and interactive login is disabled (M365_NO_INTERACTIVE=1).",
  );
}
