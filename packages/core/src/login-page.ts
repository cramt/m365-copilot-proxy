import { createLogger } from "./log.js";

const log = createLogger("auth");

/** The part of a Playwright page these helpers use, so tests can pass a fake page. */
export interface LoginPage {
  on(event: string, listener: (arg: any) => void): unknown;
  mainFrame(): unknown;
}

/** A URL's origin and path. The query and fragment are dropped: on the login pages
 *  they carry the OAuth state, the authorization code and the login hint. */
export function urlWithoutQuery(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.split(/[?#]/)[0];
  }
}

/** Debug-log each page the login browser loads and each request that fails, so a log
 *  shows the last sign-in step a failed login reached. */
export function traceLoginPage(page: LoginPage): void {
  let last = "";
  page.on("framenavigated", (frame: any) => {
    if (frame !== page.mainFrame()) return;
    const url = urlWithoutQuery(frame.url());
    if (url === last) return; // AAD's pages re-fire it for the same URL as they load
    last = url;
    log.info(`Login page: ${url}`);
  });
  page.on("requestfailed", (req: any) => {
    log.info(
      `Login request failed: ${req.resourceType()} ${urlWithoutQuery(req.url())} (${req.failure()?.errorText ?? "no reason"})`,
    );
  });
}

/**
 * The authorization code from the `nativeclient` redirect. That redirect URI is meant
 * for an embedded native host to intercept; a real browser follows it one hop further
 * to /common/wrongplace, so the ?code= exists only on the navigation request. Capture
 * it there rather than waiting for the URL to settle.
 *
 * When AAD ends the request with an OAuth error instead (a Conditional Access block,
 * a cancel), the promise rejects with that error at once: no code can follow it, and
 * waiting for the timeout would hide the reason.
 */
export function nativeclientRedirectCode(page: LoginPage, label: string): Promise<string> {
  const code = new Promise<string>((resolve, reject) => {
    page.on("request", (req: any) => {
      const u: string = req.url();
      if (!u.includes("/oauth2/nativeclient")) return;
      const params = new URL(u).searchParams;
      const c = params.get("code");
      if (c) {
        log.info(`Captured auth code from nativeclient redirect${label}`);
        resolve(c);
        return;
      }
      const error = params.get("error");
      if (!error) return;
      const subcode = params.get("error_subcode");
      const description = params.get("error_description");
      const message =
        `AAD ended the sign-in with ${error}${subcode ? ` (${subcode})` : ""}` +
        (description ? `: ${description}` : "");
      log.error(`${message}${label}`);
      reject(new Error(message));
    });
  });
  // An error that arrives after the caller stopped waiting (a timeout) must not
  // become an unhandled rejection, which would end the proxy process.
  code.catch(() => {});
  return code;
}
