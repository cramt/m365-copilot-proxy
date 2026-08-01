import * as msal from "@azure/msal-node";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";

const CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";
const AUTHORITY = "https://login.microsoftonline.com/common";
const REDIRECT_URI =
  "https://login.microsoftonline.com/common/oauth2/nativeclient";
const SCOPES = [
  "https://substrate.office.com/sydney/M365Chat.Read",
  "https://substrate.office.com/sydney/sydney.readwrite",
];

// Generated-image bytes live on designerapp.officeapps.live.com behind SharePoint
// Embedded (§14). The Sydney token 401s there; the artifact wants a token for the
// designerapp *service*. Our own first-party client IS preauthorized for it (the
// web client mints it via refresh_token), so acquireTokenSilent works — confirmed
// fetching a 2.3 MB PNG. Note it's an RSA-OAEP JWE, opaque to us; we pass it through.
const IMAGE_ARTIFACT_SCOPES = [
  "https://designerappservice.officeapps.live.com/.default",
];

/** Token that authorizes fetching a generated-image artifact URL (§14). Silent
 *  from the cached refresh token; falls back to the same automated login as chat. */
export function getImageArtifactToken(): Promise<string | null> {
  return getTokenForScope(IMAGE_ARTIFACT_SCOPES);
}

import { createLogger } from "./log.js";
const log = createLogger("auth");

const CONFIG_DIR = join(homedir(), ".config", "opencode-m365");

function resolveFile(envVar: string, defaultName: string): string {
  if (process.env[envVar]) return process.env[envVar]!;
  mkdirSync(CONFIG_DIR, { recursive: true });
  return join(CONFIG_DIR, defaultName);
}

const CACHE_FILE = resolveFile("M365_CACHE_FILE", "msal-cache.json");
const SECRETS_FILE = resolveFile("M365_SECRETS_FILE", "secrets.json");

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

// --- Shared automated browser login ---

const LOGIN_DEBUG_DIR = join(CONFIG_DIR, "login-debug");

// A PERSISTENT browser profile is the biggest anti-detection lever (docs/hypotheses.md
// §11, H-R3). It keeps the AAD session cookies (`ESTSAUTH*`) and device cookie across
// runs, so after the first login subsequent ones are SSO-silent (no password/TOTP page)
// AND present as a *returning familiar device* — which is exactly what Entra ID's risk
// engine scores as low-risk. A fresh ephemeral context (the old behaviour) looked like a
// brand-new unfamiliar device on every single login. Override with M365_BROWSER_PROFILE.
const BROWSER_PROFILE_DIR = resolveFile("M365_BROWSER_PROFILE", "browser-profile");

// A coherent, non-headless-looking UA that MATCHES the platform we actually run on
// (Linux). The default headless Chromium advertises `HeadlessChrome/<v>` in both
// navigator.userAgent AND the HTTP User-Agent header — a direct "I'm a bot" tell that
// login.microsoftonline.com's device-fingerprinting reads. We override it at the context
// level (fixes both layers). Deliberately NOT spoofing a different OS: a Windows UA on a
// Linux navigator.platform is itself an incoherent, flaggable fingerprint (F25 Config-B).
const LOGIN_USER_AGENT =
  process.env.M365_LOGIN_UA ??
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

interface Credentials {
  email: string;
  password: string;
  mfaSecret: string;
}

/**
 * Resolve a usable Chromium executable. Playwright's bundled chrome-headless-shell
 * is not patched for NixOS (fails on libglib-2.0.so.0), so prefer an explicit
 * CHROMIUM_PATH, then a system chromium on PATH. Returns undefined to let
 * Playwright use its bundled browser (works on patched/standard distros).
 */
function resolveChromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  for (const bin of ["chromium", "chromium-browser", "google-chrome", "chrome"]) {
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
  return undefined;
}

async function capture(page: any, label: string): Promise<void> {
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
  } catch (e: any) {
    log.error(`Failed to capture ${label}: ${e?.message}`);
  }
}

/**
 * Fill a visible input and verify the value actually landed. The converged AAD
 * login page keeps hidden duplicate inputs around, so a naive fill can target a
 * stale hidden node and leave the visible field empty. Refill via typing if so.
 */
async function fillVerified(
  page: any,
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
async function clickSubmit(page: any): Promise<void> {
  await page
    .locator('input[type="submit"]:visible, button[type="submit"]:visible')
    .first()
    .click();
}

/** Whether a field becomes visible within `timeout` ms — lets us skip steps that a
 *  persistent-profile SSO login has already satisfied (no email/password/TOTP prompt). */
async function isVisibleSoon(page: any, selector: string, timeout: number): Promise<boolean> {
  try {
    await page.locator(`${selector}:visible`).first().waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

/**
 * Handle the "Pick an account" picker. A persistent-profile SSO login (H-R3) lands on
 * an account-tile list instead of the email form; we must CLICK our account's tile to
 * proceed, or the page just sits at /authorize and the code never redirects. On the cold
 * path no picker appears, so this is a quick no-op. Returns true if a tile was clicked.
 */
async function clickAccountTileIfPresent(page: any, email: string): Promise<boolean> {
  // No picker on the cold path — bail quickly so we fall through to the email form.
  try {
    await page.locator("#tilesHolder:visible").first().waitFor({ state: "visible", timeout: 5000 });
  } catch {
    return false;
  }
  // The tile's data-test-id is the account address LOWERCASED (the aria-label instead
  // capitalises the local part, and CSS substring matching is case-sensitive — matching
  // aria-label was the bug). Fall back to the first non-menu account tile if the exact
  // id doesn't match (e.g. a differently-cased stored email).
  const tile = page
    .locator(
      `[data-test-id="${email.toLowerCase()}"]:visible, ` +
      `#tilesHolder .tile [role="button"][data-test-id]:not([data-test-id$="-menu-dots"]):visible`,
    )
    .first();
  try {
    await tile.waitFor({ state: "visible", timeout: 5000 });
    await tile.click();
    log.info("Account picker — clicked remembered account tile (SSO)");
    return true;
  } catch {
    return false;
  }
}

/**
 * Drive the Azure AD interactive login form using stored credentials + TOTP.
 * Each step is OPTIONAL: with a persistent profile (H-R3) a returning session is
 * SSO-silent, so the email/password/TOTP prompts may not appear at all and AAD
 * redirects straight through with the auth code. We only fill a step when its field
 * actually shows, so both the cold (fresh-profile) and warm (SSO) paths work.
 */
async function driveAzureLogin(page: any, creds: Credentials): Promise<void> {
  const { TOTP } = await import("otpauth");

  await capture(page, "step0-landing");

  // SSO returning session shows the account picker first — click our tile to proceed.
  // Picking a tile IS the account selection, so skip the email step afterward: the page
  // goes straight to "Enter password", and re-entering the email there matches a stale
  // hidden loginfmt and derails the flow (the password step then never runs).
  const picked = await clickAccountTileIfPresent(page, creds.email);

  if (!picked && (await isVisibleSoon(page, 'input[name="loginfmt"]', 8000))) {
    log.info("Step: email");
    await fillVerified(page, 'input[name="loginfmt"]', creds.email, "email");
    await clickSubmit(page);
    await capture(page, "step1-after-email");
  } else {
    log.info(`Step: email skipped (${picked ? "picked account tile" : "SSO — no email prompt"})`);
  }

  if (await isVisibleSoon(page, 'input[name="passwd"]', 8000)) {
    log.info("Step: password");
    await fillVerified(page, 'input[name="passwd"]', creds.password, "password");
    await clickSubmit(page);
    await capture(page, "step2-after-password");
  } else {
    log.info("Step: password skipped (SSO — no password prompt)");
  }

  if (await isVisibleSoon(page, 'input[name="otc"]', 8000)) {
    log.info("Step: mfa");
    const otpCode = new TOTP({ secret: creds.mfaSecret }).generate();
    await fillVerified(page, 'input[name="otc"]', otpCode, "otc");
    await clickSubmit(page);
    await capture(page, "step3-after-mfa");
  } else {
    log.info("Step: mfa skipped (SSO — no TOTP prompt)");
  }

  // "Stay signed in?" — accepting it persists ESTSAUTHPERSISTENT into our profile,
  // which is what makes the NEXT login SSO-silent + device-familiar. Best-effort.
  log.info("Step: stay-signed-in");
  try {
    await page.locator("#idSIButton9:visible").click({ timeout: 8000 });
  } catch {
    // not shown
  }
}

/**
 * Acquire a token for the given scopes via a headless browser login.
 * Retries up to `attempts` times, capturing screenshots/HTML on each failure.
 * TOTP codes are single-use per 30s window, so retries wait for a fresh window.
 * Returns null if all attempts fail.
 */
async function runBrowserLogin(
  app: msal.PublicClientApplication,
  scopes: string[],
  creds: Credentials,
  attempts = 3,
): Promise<string | null> {
  const { chromium } = await import("playwright");

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { authUrl, verifier } = await buildAuthUrlForScopes(app, scopes);
    // Persistent context (H-R3): reuse one on-disk profile so AAD session/device
    // cookies survive → later logins are SSO-silent + look like a familiar device.
    // Hardening: kill the automation tells the AAD fingerprinter reads — the
    // AutomationControlled blink feature and navigator.webdriver — and present a
    // coherent Linux Chrome UA instead of the default `HeadlessChrome` string.
    const context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
      headless: true,
      executablePath: resolveChromiumPath(),
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
      ],
      userAgent: LOGIN_USER_AGENT,
      locale: "en-GB",
      timezoneId: "Europe/Copenhagen",
      viewport: { width: 1280, height: 800 },
    });
    await context.addInitScript(() => {
      // navigator.webdriver === true is the single loudest automation signal.
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    });
    const page = context.pages()[0] ?? (await context.newPage());

    // The nativeclient redirect URI is meant for embedded native hosts to
    // intercept; a real browser follows it one hop further to /common/wrongplace,
    // so the ?code= only exists transiently. Capture it from the navigation
    // request itself rather than waiting for the URL to settle.
    let resolveCode: (code: string) => void;
    const codePromise = new Promise<string>((res) => {
      resolveCode = res;
    });
    page.on("request", (req: any) => {
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
      // Drive the form CONCURRENTLY with the code race: on the SSO-silent path AAD
      // redirects through with the code before (or without) any form step, so we must
      // not block on driveAzureLogin finishing. On the cold path its form-filling is
      // what produces the redirect. Either way the code arrives via `codePromise`.
      const drive = driveAzureLogin(page, creds).catch((e: any) =>
        log.info(`driveAzureLogin ended early: ${e?.message}`),
      );

      const authCode = await Promise.race([
        codePromise,
        new Promise<string>((_, rej) =>
          setTimeout(() => rej(new Error("Timed out waiting for auth code")), 45000),
        ),
      ]);
      void drive; // fire-and-forget; context.close() below tears down any pending step

      const result = await app.acquireTokenByCode({
        code: authCode,
        scopes,
        redirectUri: REDIRECT_URI,
        codeVerifier: verifier,
      });
      saveCache(app);
      log.info(`Browser login succeeded as ${result.account?.username}`);
      return result.accessToken;
    } catch (err: any) {
      await capture(page, `attempt-${attempt}-fail`);
      log.error(`Browser login attempt ${attempt}/${attempts} failed: ${err.message}`);
      if (attempt < attempts) {
        // Wait for a fresh TOTP window so the next code isn't a reused one.
        await new Promise((r) => setTimeout(r, 31_000));
      }
    } finally {
      await context.close();
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
    const result = await app.acquireTokenSilent({
      scopes: SCOPES,
      account: accounts[0],
    });
    saveCache(app);
    return result.accessToken;
  } catch {
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
  const token = await runBrowserLogin(
    app,
    SCOPES,
    { email, password, mfaSecret },
    1,
  );
  if (!token) {
    throw new Error(
      `Automated login failed — see artifacts in ${LOGIN_DEBUG_DIR}`,
    );
  }
  return token;
}

// Ensure we hold a usable token. Retained as a MANUAL lever only — nothing auto-invokes
// it anymore (see auth-recovery.ts: degradation is handled by backoff, not re-login).
//
// It used to force a fresh interactive login on the F13 belief that new tokens clear
// throttle. They don't (H-R1 / API doc §2/§7: throttle is `oid`-keyed, and a regenerated
// token carries the same `oid`), and the old code ALSO removed the cached account first —
// discarding the refresh token and guaranteeing a full, fingerprint-heavy login every
// time. We no longer do that: prefer a silent refresh (invisible, no login page), and
// fall back to an automated login ONLY if silent genuinely can't produce a token.
// Single-flight so concurrent callers share one refresh.
let inflightReauth: Promise<boolean> | null = null;

export function forceReauth(): Promise<boolean> {
  return (inflightReauth ??= doForceReauth().finally(() => {
    inflightReauth = null;
  }));
}

async function doForceReauth(): Promise<boolean> {
  try {
    const silent = await getTokenSilent();
    if (silent) {
      log.info("forceReauth: refreshed silently — no interactive login needed");
      return true;
    }
    const secrets = loadSecrets();
    if (!secrets) {
      log.error("forceReauth: silent refresh failed and no secrets file — cannot re-login");
      return false;
    }
    log.info("forceReauth: silent unavailable, doing automated login");
    await loginAutomated(secrets.email, secrets.password, secrets.mfaSecret);
    log.info("forceReauth: automated login succeeded");
    return true;
  } catch (err: any) {
    log.error(`forceReauth failed: ${err.message}`);
    return false;
  }
}

export function loadSecrets(): {
  email: string;
  password: string;
  mfaSecret: string;
} | null {
  if (!existsSync(SECRETS_FILE)) return null;
  try {
    const data = JSON.parse(readFileSync(SECRETS_FILE, "utf-8"));
    if (data.email && data.password && data.mfaSecret) return data;
  } catch {}
  return null;
}

export async function getTokenForScope(scopes: string[]): Promise<string | null> {
  const app = getApp();
  const accounts = await app.getTokenCache().getAllAccounts();
  log.info(`getTokenForScope: ${scopes.join(",")} — ${accounts.length} accounts in cache`);

  if (accounts.length > 0) {
    try {
      const result = await app.acquireTokenSilent({
        scopes,
        account: accounts[0],
      });
      saveCache(app);
      return result.accessToken;
    } catch (err: any) {
      log.info(`getTokenForScope: silent failed (${err.message}), trying browser login`);
    }
  }

  // Silent unavailable — fall back to automated browser login with stored creds.
  const secrets = loadSecrets();
  if (!secrets) return null;
  return runBrowserLogin(app, scopes, secrets);
}

// Serialize token acquisition: concurrent callers share one in-flight login
// instead of racing several browser logins against the same account.
let inflightToken: Promise<string> | null = null;

export function getToken(): Promise<string> {
  return (inflightToken ??= doGetToken().finally(() => {
    inflightToken = null;
  }));
}

async function doGetToken(): Promise<string> {
  const silent = await getTokenSilent();
  if (silent) {
    log.info("Token refreshed silently");
    return silent;
  }

  const secrets = loadSecrets();
  if (!secrets) {
    throw new Error(
      "No cached token and no secrets.json — cannot authenticate. Provide email/password/mfaSecret for automated login.",
    );
  }
  // Automated (headless) login only. There is intentionally no interactive
  // browser fallback — a headless host (systemd, CI, second PC) must fail loudly
  // rather than hang on an invisible paste-the-URL prompt or pop a browser tab.
  return loginAutomated(secrets.email, secrets.password, secrets.mfaSecret);
}
