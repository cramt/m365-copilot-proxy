import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { nativeclientRedirectCode, urlWithoutQuery } from "./login-page.js";

const NATIVECLIENT = "https://login.microsoftonline.com/common/oauth2/nativeclient";

/** A page that emits `request` events for the URLs a test sends it. */
function fakePage() {
  const events = new EventEmitter();
  return {
    on: (event: string, listener: (arg: any) => void) => events.on(event, listener),
    mainFrame: () => null,
    request: (url: string) => events.emit("request", { url: () => url }),
  };
}

describe("nativeclientRedirectCode", () => {
  it("resolves with the code from the nativeclient redirect and ignores other requests", async () => {
    const page = fakePage();
    const code = nativeclientRedirectCode(page, "");
    page.request("https://login.microsoftonline.com/common/login?code=not-this-one");
    page.request(`${NATIVECLIENT}?state=s`);
    page.request(`${NATIVECLIENT}?code=abc123&state=s`);
    await expect(code).resolves.toBe("abc123");
  });

  it("rejects at once with AAD's OAuth error, its subcode and its description", async () => {
    const page = fakePage();
    const cancelled = nativeclientRedirectCode(page, "");
    page.request(`${NATIVECLIENT}?error=access_denied&error_subcode=cancel&state=s`);
    await expect(cancelled).rejects.toThrow(/^AAD ended the sign-in with access_denied \(cancel\)$/);

    const other = fakePage();
    const blocked = nativeclientRedirectCode(other, "");
    other.request(`${NATIVECLIENT}?error=access_denied&error_description=AADSTS53003%3A+Access+has+been+blocked`);
    await expect(blocked).rejects.toThrow("access_denied: AADSTS53003: Access has been blocked");
  });

  it("leaves no unhandled rejection when the caller has stopped waiting", async () => {
    const page = fakePage();
    nativeclientRedirectCode(page, "");
    page.request(`${NATIVECLIENT}?error=access_denied`);
    // vitest fails the run if the rejection is unhandled
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
});

describe("urlWithoutQuery", () => {
  it("keeps the origin and path and drops the query and fragment", () => {
    expect(urlWithoutQuery("https://login.microsoftonline.com/common/login?login_hint=a%40b.c#x")).toBe(
      "https://login.microsoftonline.com/common/login",
    );
    expect(urlWithoutQuery("not a url?state=s")).toBe("not a url");
  });
});
