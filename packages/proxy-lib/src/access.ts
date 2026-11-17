// Who may use the proxy. Anything that reaches the port spends the signed-in
// M365 account, so the defaults are closed (#93):
//   - no CORS headers unless M365_CORS_ORIGIN names the allowed origins;
//   - a request carrying an Origin that isn't allowed is refused outright. A
//     browser attaches Origin to every cross-origin POST, so this stops a web
//     page (or a DNS-rebound one, whose Origin is its own host) from driving
//     the proxy even with a "simple" request CORS never preflights. CLI
//     clients (pi, openclaw, curl) send no Origin and are unaffected;
//   - M365_PROXY_KEY (or the contents of M365_PROXY_KEY_FILE), when set, is
//     required as `Authorization: Bearer <key>` or `x-api-key: <key>` on
//     everything but /health and preflights.

import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

let fileKey: { path: string; key: string | undefined } | null = null;

/** The configured key: M365_PROXY_KEY, else M365_PROXY_KEY_FILE's contents
 *  (the NixOS module's apiKeyFile, kept out of the store). A file that can't be
 *  read throws: starting open when a key was asked for would be the wrong failure. */
export function configuredProxyKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const direct = env.M365_PROXY_KEY?.trim();
  if (direct) return direct;
  const path = env.M365_PROXY_KEY_FILE?.trim();
  if (!path) return undefined;
  if (fileKey?.path !== path) fileKey = { path, key: readFileSync(path, "utf8").trim() || undefined };
  if (!fileKey.key) throw new Error(`M365_PROXY_KEY_FILE (${path}) is empty`);
  return fileKey.key;
}

export type CorsPolicy =
  | { kind: "none" }
  | { kind: "any" }
  | { kind: "list"; origins: ReadonlySet<string> };

export function corsPolicy(raw: string | undefined = process.env.M365_CORS_ORIGIN): CorsPolicy {
  const entries = (raw ?? "").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
  if (entries.length === 0) return { kind: "none" };
  if (entries.includes("*")) return { kind: "any" };
  return { kind: "list", origins: new Set(entries) };
}

function originAllowed(policy: CorsPolicy, origin: string): boolean {
  switch (policy.kind) {
    case "none": return false;
    case "any": return true;
    case "list": return policy.origins.has(origin);
  }
}

/** The CORS headers for a request from `origin` (null when it sent none). */
export function corsHeaders(policy: CorsPolicy, origin: string | null): Record<string, string> {
  if (origin === null || !originAllowed(policy, origin)) return {};
  return {
    "Access-Control-Allow-Origin": policy.kind === "any" ? "*" : origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, x-api-key",
    ...(policy.kind === "list" ? { Vary: "Origin" } : {}),
  };
}

export interface AccessRequest {
  method: string;
  pathname: string;
  origin: string | null;
  authorization: string | null;
  apiKey: string | null;
}

export type AccessDecision =
  | { kind: "allow" }
  | { kind: "deny"; status: 401 | 403; message: string };

function sameKey(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function checkAccess(
  req: AccessRequest,
  policy: CorsPolicy = corsPolicy(),
  proxyKey: string | undefined = configuredProxyKey(),
): AccessDecision {
  if (req.origin !== null && !originAllowed(policy, req.origin)) {
    return {
      kind: "deny",
      status: 403,
      message: `Origin ${req.origin} is not allowed. Set M365_CORS_ORIGIN to allow browser clients.`,
    };
  }
  if (!proxyKey || req.method === "OPTIONS" || req.pathname === "/health") return { kind: "allow" };
  const bearer = /^Bearer\s+(.+)$/i.exec(req.authorization ?? "")?.[1]?.trim();
  const given = bearer ?? req.apiKey?.trim();
  if (given && sameKey(given, proxyKey)) return { kind: "allow" };
  return { kind: "deny", status: 401, message: "Missing or wrong API key (M365_PROXY_KEY)." };
}
