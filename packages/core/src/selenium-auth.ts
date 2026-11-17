import { Builder, By, Key, until, logging } from "selenium-webdriver";
import chrome from "selenium-webdriver/chrome.js";

import { createLogger } from "./log.js";

const log = createLogger("selenium-auth");

export interface SeleniumAuthOptions {
  serverUrl: string;
  browser?: string;
  userAgent?: string;
  locale?: string;
  timezone?: string;
}

export interface SeleniumAuthDriver {
  driver: any;
  close(): Promise<void>;
}

/** Extract an OAuth authorization code from a Chrome performance-log entry. */
export function parseOAuthCodeFromPerformanceEntry(entry: unknown): string | null {
  try {
    const raw = typeof entry === "string" ? JSON.parse(entry) : entry;
    const messageValue = (raw as any)?.message;
    const message = typeof messageValue === "string" ? JSON.parse(messageValue) : messageValue;
    if (message?.method !== "Network.requestWillBeSent") return null;
    const url = message?.params?.request?.url;
    if (typeof url !== "string") return null;
    const parsedUrl = new URL(url);
    if (
      parsedUrl.hostname !== "login.microsoftonline.com" ||
      !parsedUrl.pathname.endsWith("/common/oauth2/nativeclient")
    ) return null;
    const code = parsedUrl.searchParams.get("code");
    return code || null;
  } catch {
    return null;
  }
}

export function createSeleniumChromeOptions(options: SeleniumAuthOptions): chrome.Options {
  const chromeOptions = new chrome.Options();
  chromeOptions.addArguments(
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-blink-features=AutomationControlled",
    `--lang=${options.locale ?? "en-GB"}`,
    `--user-agent=${options.userAgent ?? "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36"}`,
  );
  // Selenium Grid accepts these capabilities and Chrome applies the timezone via
  // DevTools where supported. Performance logs are required to capture the transient
  // nativeclient redirect before Chrome follows it to /common/wrongplace.
  chromeOptions.setLoggingPrefs({ performance: "ALL" });
  chromeOptions.setPerfLoggingPrefs({ enableNetwork: true });
  chromeOptions.set("se:timezone", options.timezone ?? "Europe/Copenhagen");
  return chromeOptions;
}

export async function createSeleniumAuthDriver(options: SeleniumAuthOptions): Promise<SeleniumAuthDriver> {
  const chromeOptions = createSeleniumChromeOptions(options);
  const driver = await new Builder()
    .forBrowser(options.browser ?? "chrome")
    .setChromeOptions(chromeOptions)
    .usingServer(options.serverUrl)
    .build();
  return {
    driver,
    close: async () => {
      try { await driver.quit(); } catch { /* best effort */ }
    },
  };
}

async function visibleElement(driver: any, selector: string, timeoutMs: number): Promise<any | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const elements = await driver.findElements(By.css(selector));
    for (const element of elements) {
      try {
        if (await element.isDisplayed()) return element;
      } catch { /* stale element; retry */ }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return null;
}

export async function isSeleniumElementVisible(driver: any, selector: string, timeoutMs: number): Promise<boolean> {
  return Boolean(await visibleElement(driver, selector, timeoutMs));
}

async function fillVisible(driver: any, selector: string, value: string, label: string): Promise<void> {
  const element = await visibleElement(driver, selector, 20_000);
  if (!element) throw new Error(`${label}: visible field not found`);
  await element.click();
  await element.sendKeys(Key.chord(Key.CONTROL, "a"), value);
  const actual = await element.getAttribute("value");
  if (actual !== value) throw new Error(`${label}: field value was not accepted`);
}

async function clickSubmit(driver: any): Promise<void> {
  const button = await visibleElement(driver, 'input[type="submit"], button[type="submit"]', 20_000);
  if (!button) throw new Error("submit button not found");
  await button.click();
}

async function clickAccountTile(driver: any, email: string): Promise<boolean> {
  const holder = await visibleElement(driver, "#tilesHolder", 5_000);
  if (!holder) return false;
  const selectors = [
    `[data-test-id="${email.toLowerCase()}"]`,
    '#tilesHolder .tile [role="button"][data-test-id]:not([data-test-id$="-menu-dots"])',
  ];
  for (const selector of selectors) {
    const tile = await visibleElement(driver, selector, 5_000);
    if (tile) {
      await tile.click();
      log.info("Account picker: clicked remembered account tile");
      return true;
    }
  }
  return false;
}

export interface SeleniumCredentials {
  email?: string;
  password?: string;
  mfaSecret?: string;
}

export async function driveSeleniumAzureLogin(driver: any, credentials: SeleniumCredentials): Promise<void> {
  const picked = credentials.email ? await clickAccountTile(driver, credentials.email) : false;
  if (!picked && credentials.email && await isSeleniumElementVisible(driver, 'input[name="loginfmt"]', 8_000)) {
    await fillVisible(driver, 'input[name="loginfmt"]', credentials.email, "email");
    await clickSubmit(driver);
  }
  if (credentials.password && await isSeleniumElementVisible(driver, 'input[name="passwd"]', 8_000)) {
    await fillVisible(driver, 'input[name="passwd"]', credentials.password, "password");
    await clickSubmit(driver);
  }
  if (credentials.mfaSecret && await isSeleniumElementVisible(driver, 'input[name="otc"]', 8_000)) {
    const { TOTP } = await import("otpauth");
    const code = new TOTP({ secret: credentials.mfaSecret }).generate();
    await fillVisible(driver, 'input[name="otc"]', code, "mfa");
    await clickSubmit(driver);
  }
  const staySignedIn = await visibleElement(driver, "#idSIButton9", 8_000);
  if (staySignedIn) await staySignedIn.click();
}

export async function waitForSeleniumOAuthCode(driver: any, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let entries: any[] = [];
    try { entries = await driver.manage().logs().get(logging.Type.PERFORMANCE); } catch (error: any) {
      throw new Error(`Selenium performance logs unavailable: ${error?.message ?? error}`);
    }
    for (const entry of entries) {
      const code = parseOAuthCodeFromPerformanceEntry(entry.message);
      if (code) return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for OAuth authorization code after ${Math.round(timeoutMs / 1000)}s`);
}

export async function captureSeleniumPage(driver: any, directory: string, label: string): Promise<void> {
  try {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${label}.html`), await driver.getPageSource());
    writeFileSync(join(directory, `${label}.url.txt`), await driver.getCurrentUrl());
    const screenshot = await driver.takeScreenshot();
    writeFileSync(join(directory, `${label}.png`), screenshot, "base64");
  } catch (error: any) {
    log.error(`Failed to capture ${label}: ${error?.message ?? error}`);
  }
}
