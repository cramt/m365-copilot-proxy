import { checkAccess, corsHeaders, corsPolicy } from "@m365-copilot/proxy-lib";

/**
 * Origin allowlist, CORS and the optional API key for every route (#93); the
 * policy lives in proxy-lib's access.ts so createApp() enforces the same rules.
 * Returning a value from h3 middleware ends the request there.
 */
export default defineEventHandler((event) => {
  const origin = getRequestHeader(event, "origin") ?? null;
  for (const [k, v] of Object.entries(corsHeaders(corsPolicy(), origin))) setResponseHeader(event, k, v);

  const access = checkAccess({
    method: event.method.toUpperCase(),
    pathname: getRequestURL(event).pathname,
    origin,
    authorization: getRequestHeader(event, "authorization") ?? null,
    apiKey: getRequestHeader(event, "x-api-key") ?? null,
  });
  if (access.kind === "deny") {
    setResponseStatus(event, access.status);
    return { error: { message: access.message, type: "invalid_request_error" } };
  }
  if (event.method === "OPTIONS") {
    setResponseStatus(event, 204);
    return "";
  }
});
