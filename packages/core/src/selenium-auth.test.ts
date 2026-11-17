import { describe, it, expect } from "vitest";
import {
  parseOAuthCodeFromPerformanceEntry,
  createSeleniumChromeOptions,
} from "./selenium-auth.js";

describe("parseOAuthCodeFromPerformanceEntry", () => {
  it("extracts code from a Network.requestWillBeSent entry with nativeclient URL", () => {
    const entry = {
      message: JSON.stringify({
        method: "Network.requestWillBeSent",
        params: {
          request: {
            url:
              "https://login.microsoftonline.com/common/oauth2/nativeclient?code=ABC123DEF456&session_state=xyz",
          },
        },
      }),
    };
    expect(parseOAuthCodeFromPerformanceEntry(entry)).toBe("ABC123DEF456");
  });

  it("returns null for non-Network.requestWillBeSent methods", () => {
    const entry = {
      message: JSON.stringify({
        method: "Network.responseReceived",
        params: { request: { url: "https://example.com" } },
      }),
    };
    expect(parseOAuthCodeFromPerformanceEntry(entry)).toBeNull();
  });

  it("returns null when URL is not on login.microsoftonline.com", () => {
    const entry = {
      message: JSON.stringify({
        method: "Network.requestWillBeSent",
        params: {
          request: {
            url: "https://login.windows.net/common/oauth2/nativeclient?code=ABC",
          },
        },
      }),
    };
    expect(parseOAuthCodeFromPerformanceEntry(entry)).toBeNull();
  });

  it("returns null when pathname does not end with /common/oauth2/nativeclient", () => {
    const entry = {
      message: JSON.stringify({
        method: "Network.requestWillBeSent",
        params: {
          request: {
            url:
              "https://login.microsoftonline.com/common/oauth2/authorize?code=ABC",
          },
        },
      }),
    };
    expect(parseOAuthCodeFromPerformanceEntry(entry)).toBeNull();
  });

  it("returns null when there is no code parameter", () => {
    const entry = {
      message: JSON.stringify({
        method: "Network.requestWillBeSent",
        params: {
          request: {
            url:
              "https://login.microsoftonline.com/common/oauth2/nativeclient?session_state=xyz",
          },
        },
      }),
    };
    expect(parseOAuthCodeFromPerformanceEntry(entry)).toBeNull();
  });

  it("handles entry passed as a JSON string", () => {
    const entry = JSON.stringify({
      message: JSON.stringify({
        method: "Network.requestWillBeSent",
        params: {
          request: {
            url:
              "https://login.microsoftonline.com/common/oauth2/nativeclient?code=STRCODE",
          },
        },
      }),
    });
    expect(parseOAuthCodeFromPerformanceEntry(entry)).toBe("STRCODE");
  });

  it("returns null on malformed input", () => {
    expect(parseOAuthCodeFromPerformanceEntry("not json")).toBeNull();
    expect(parseOAuthCodeFromPerformanceEntry({})).toBeNull();
    expect(parseOAuthCodeFromPerformanceEntry(null as unknown)).toBeNull();
  });
});

describe("createSeleniumChromeOptions", () => {
  it("sets anti-detection arguments and performance logging", () => {
    const options = createSeleniumChromeOptions({
      serverUrl: "http://localhost:4444",
    });
    // Chrome Options exposes arguments via toCapabilities() in selenium-webdriver.
    const chromeCaps = options.get("goog:chromeOptions") ?? {};
    const args = chromeCaps.args ?? [];
    expect(args).toContain("--no-sandbox");
    expect(args).toContain("--disable-dev-shm-usage");
    expect(args).toContain("--disable-blink-features=AutomationControlled");
    expect(args.some((a: string) => a.startsWith("--lang="))).toBe(true);
    expect(args.some((a: string) => a.startsWith("--user-agent="))).toBe(true);
  });

  it("uses overridable locale, timezone and user agent", () => {
    const options = createSeleniumChromeOptions({
      serverUrl: "http://localhost:4444",
      locale: "fr-FR",
      timezone: "Europe/Paris",
      userAgent: "Mozilla/5.0 Custom UA",
    });
    const chromeCaps = options.get("goog:chromeOptions") ?? {};
    const args = chromeCaps.args ?? [];
    expect(args).toContain("--lang=fr-FR");
    expect(args).toContain("--user-agent=Mozilla/5.0 Custom UA");
    // timezone is set as a custom capability, not a chrome arg
    expect(options.get("se:timezone")).toBe("Europe/Paris");
  });
});
