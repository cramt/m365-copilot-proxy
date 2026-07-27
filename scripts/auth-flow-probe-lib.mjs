import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const CLIENT_ID = "c0ab8ce9-e9a0-42e7-b064-33d422df41f1";
export const NATIVECLIENT_REDIRECT_URI =
  "https://login.microsoftonline.com/common/oauth2/nativeclient";

export const SCOPE_SETS = Object.freeze({
  chat: Object.freeze([
    "https://substrate.office.com/sydney/M365Chat.Read",
    "https://substrate.office.com/sydney/sydney.readwrite",
  ]),
  bap: Object.freeze(["https://api.bap.microsoft.com/.default"]),
  powerplatform: Object.freeze(["https://api.powerplatform.com/.default"]),
});

const METHODS = new Set(["browser", "device-code", "nativeclient-visible"]);
const PROMPTS = new Set(["none", "select_account", "login"]);
const BOOLEAN_OPTIONS = new Set([
  "allow-non-tty",
  "execute",
  "help",
  "incremental-interaction",
  "keep-cache",
  "no-open",
  "reuse-cache",
  "silent-only",
]);
const VALUE_OPTIONS = new Set([
  "audiences",
  "authority",
  "browser-profile",
  "cache",
  "chromium",
  "json-out",
  "login-hint",
  "method",
  "prompt",
  "timeout",
]);

export function normalizeAuthority(value) {
  const authority = String(value || "common").trim();
  if (/^https:\/\/login\.microsoftonline\.com\/[^/]+\/?$/i.test(authority)) {
    return authority.replace(/\/$/, "");
  }
  if (/^[a-z0-9.-]+$/i.test(authority)) {
    return `https://login.microsoftonline.com/${authority}`;
  }
  throw new Error(
    "--authority must be common, organizations, a tenant ID/domain, or a login.microsoftonline.com authority URL",
  );
}

function takeOptionValue(argv, index, name, inlineValue) {
  if (inlineValue !== undefined) return { value: inlineValue, nextIndex: index };
  const next = argv[index + 1];
  if (!next || next.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return { value: next, nextIndex: index + 1 };
}

export function parseArgs(argv) {
  const raw = {};

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    // pnpm 10 forwards the conventional script-argument separator.
    if (token === "--") continue;
    if (!token.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${token}`);
    }

    const match = token.match(/^--([^=]+)(?:=(.*))?$/);
    const name = match?.[1];
    const inlineValue = match?.[2];
    if (!name || (!BOOLEAN_OPTIONS.has(name) && !VALUE_OPTIONS.has(name))) {
      throw new Error(`Unknown option: ${token}`);
    }

    if (BOOLEAN_OPTIONS.has(name)) {
      if (inlineValue !== undefined) {
        throw new Error(`--${name} is a flag and does not take a value`);
      }
      raw[name] = true;
      continue;
    }

    const { value, nextIndex } = takeOptionValue(argv, index, name, inlineValue);
    raw[name] = value;
    index = nextIndex;
  }

  const method = raw.method ?? "browser";
  if (!METHODS.has(method)) {
    throw new Error(`--method must be one of: ${[...METHODS].join(", ")}`);
  }

  const prompt = raw.prompt ?? "select_account";
  if (!PROMPTS.has(prompt)) {
    throw new Error(`--prompt must be one of: ${[...PROMPTS].join(", ")}`);
  }

  const audiences = String(raw.audiences ?? "chat,bap,powerplatform")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const uniqueAudiences = [...new Set(audiences)];
  if (uniqueAudiences.length === 0) {
    throw new Error("--audiences must include at least one audience");
  }
  for (const audience of uniqueAudiences) {
    if (!(audience in SCOPE_SETS)) {
      throw new Error(
        `Unknown audience '${audience}'. Use: ${Object.keys(SCOPE_SETS).join(", ")}`,
      );
    }
  }

  const timeoutSeconds = Number(raw.timeout ?? 180);
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 30 ||
    timeoutSeconds > 900
  ) {
    throw new Error("--timeout must be an integer from 30 through 900 seconds");
  }

  return {
    allowNonTty: Boolean(raw["allow-non-tty"]),
    audiences: uniqueAudiences,
    authority: normalizeAuthority(raw.authority),
    browserProfile: raw["browser-profile"]
      ? resolve(String(raw["browser-profile"]))
      : null,
    cache: raw.cache ? resolve(String(raw.cache)) : null,
    chromium: raw.chromium ? resolve(String(raw.chromium)) : null,
    execute: Boolean(raw.execute),
    help: Boolean(raw.help),
    incrementalInteraction: Boolean(raw["incremental-interaction"]),
    jsonOut: raw["json-out"] ? resolve(String(raw["json-out"])) : null,
    keepCache: Boolean(raw["keep-cache"]),
    loginHint: raw["login-hint"] ? String(raw["login-hint"]) : null,
    method,
    noOpen: Boolean(raw["no-open"]),
    prompt: prompt === "none" ? undefined : prompt,
    reuseCache: Boolean(raw["reuse-cache"]),
    silentOnly: Boolean(raw["silent-only"]),
    timeoutMs: timeoutSeconds * 1000,
  };
}

export function defaultProductionCachePath(home = homedir()) {
  return resolve(home, ".config", "opencode-m365", "msal-cache.json");
}

function canonicalPath(path) {
  let existingAncestor = resolve(path);
  const missingSegments = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) break;
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  const realAncestor = existsSync(existingAncestor)
    ? realpathSync(existingAncestor)
    : existingAncestor;
  return resolve(join(realAncestor, ...missingSegments));
}

export function assertDisposableCachePath(cacheFile, home = homedir()) {
  const candidate = canonicalPath(cacheFile);
  const production = canonicalPath(defaultProductionCachePath(home));
  if (candidate === production) {
    throw new Error(
      `Refusing to use the production MSAL cache (${production}). Omit --cache for an isolated temporary cache.`,
    );
  }
  return candidate;
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {
    // Windows does not implement POSIX file modes in the same way.
  }
}

function atomicWrite(path, data, mode = 0o600) {
  ensurePrivateDirectory(dirname(path));
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, data, { encoding: "utf8", mode });
  try {
    chmodSync(temp, mode);
  } catch {
    // Best effort on non-POSIX platforms.
  }
  renameSync(temp, path);
  try {
    chmodSync(path, mode);
  } catch {
    // Best effort on non-POSIX platforms.
  }
}

export function createIsolatedCachePlugin(cacheFile) {
  const path = resolve(cacheFile);
  return {
    async beforeCacheAccess(cacheContext) {
      if (!existsSync(path)) return;
      const serialized = readFileSync(path, "utf8");
      cacheContext.tokenCache.deserialize(serialized);
    },
    async afterCacheAccess(cacheContext) {
      if (!cacheContext.cacheHasChanged) return;
      atomicWrite(path, cacheContext.tokenCache.serialize());
    },
  };
}

export function writeRedactedReport(path, report) {
  atomicWrite(resolve(path), `${JSON.stringify(report, null, 2)}\n`);
}

function decodeJwtPayload(token) {
  const segment = String(token).split(".")[1];
  if (!segment) throw new Error("Token is not a JWT");
  const padded = segment + "=".repeat((4 - (segment.length % 4)) % 4);
  return JSON.parse(
    Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
      "utf8",
    ),
  );
}

function maskUsername(username) {
  if (!username) return null;
  const [local, domain] = String(username).split("@");
  if (!domain) return "<redacted>";
  return `${local.slice(0, 1) || "*"}***@${domain}`;
}

function shortIdentifier(value) {
  return value ? `${String(value).slice(0, 8)}…` : null;
}

export function tokenSummary(result) {
  const payload = decodeJwtPayload(result.accessToken);
  return {
    account: result.account
      ? {
          homeAccountId: shortIdentifier(result.account.homeAccountId),
          tenantId: shortIdentifier(result.account.tenantId),
          username: maskUsername(result.account.username),
        }
      : null,
    audience: payload.aud ?? null,
    authorizedParty: payload.azp ?? payload.appid ?? null,
    expiresOn: result.expiresOn?.toISOString?.() ?? null,
    objectId: shortIdentifier(payload.oid),
    scopes: String(payload.scp ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .sort(),
    tenantId: shortIdentifier(payload.tid),
    tokenLength: result.accessToken.length,
  };
}

export function sanitizeError(error) {
  const rawMessage = String(error?.message ?? error ?? "Unknown error");
  const message = rawMessage
    .replace(
      /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
      "<redacted-email>",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]*)?\b/g,
      "<redacted-jwt>",
    )
    .replace(
      /((?:[?&]|\b)(?:code|client_info|id_token|access_token)=)[^&\s]+/gi,
      "$1<redacted>",
    )
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      "<redacted-guid>",
    );

  return {
    code: error?.errorCode ?? error?.code ?? null,
    correlationId: shortIdentifier(error?.correlationId),
    message,
    name: error?.name ?? "Error",
    statusCode: error?.statusCode ?? null,
    subError: error?.subError ?? null,
  };
}

export function buildDryRunPlan(options) {
  const steps = [];
  if (options.silentOnly) {
    steps.push("Load the explicitly supplied isolated cache.");
    for (const audience of options.audiences) {
      steps.push(`Attempt cache-only acquisition for ${audience}.`);
    }
  } else {
    steps.push(
      `Acquire ${options.audiences[0]} interactively with ${options.method}.`,
    );
    steps.push(
      `Recreate the MSAL client and confirm ${options.audiences[0]} silently from disk.`,
    );
    for (const audience of options.audiences.slice(1)) {
      steps.push(`Attempt silent incremental acquisition for ${audience}.`);
      if (options.incrementalInteraction) {
        steps.push(
          `If required, acquire ${audience} interactively with ${options.method}, then confirm it silently.`,
        );
      }
    }
  }
  steps.push("Write a redacted JSON report; never write access or refresh tokens.");
  return steps;
}

export class TimedLoopbackClient {
  constructor(timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.server = null;
    this.timer = null;
  }

  listenForAuthCode(successTemplate, errorTemplate) {
    if (this.server) {
      throw new Error("Loopback server already exists");
    }

    return new Promise((resolveAuth, rejectAuth) => {
      const finish = (callback) => {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        callback();
      };

      this.server = createServer((request, response) => {
        if (!request.url) {
          response.statusCode = 400;
          response.end(errorTemplate ?? "Missing Microsoft authorization response");
          finish(() => rejectAuth(new Error("Missing loopback request URL")));
          return;
        }

        const parsed = new URL(request.url, this.getRedirectUri());
        const code = parsed.searchParams.get("code");
        const oauthError = parsed.searchParams.get("error");

        if (code) {
          response.writeHead(302, { location: this.getRedirectUri() });
          response.end();
          const authResponse = Object.fromEntries(parsed.searchParams.entries());
          finish(() => resolveAuth(authResponse));
          return;
        }

        if (oauthError) {
          response.statusCode = 400;
          response.end(errorTemplate ?? `Microsoft authorization failed: ${oauthError}`);
          const authResponse = Object.fromEntries(parsed.searchParams.entries());
          finish(() => resolveAuth(authResponse));
          return;
        }

        if (parsed.pathname === "/") {
          response.end(
            successTemplate ??
              "Microsoft authorization completed. You can close this window.",
          );
          return;
        }

        response.statusCode = 404;
        response.end("Not found");
      });

      this.server.once("error", (error) => {
        finish(() => rejectAuth(error));
      });
      this.server.listen(0, "127.0.0.1");

      this.timer = setTimeout(() => {
        this.closeServer();
        rejectAuth(
          new Error(
            `System-browser authorization timed out after ${this.timeoutMs / 1000}s`,
          ),
        );
      }, this.timeoutMs);
      this.timer.unref?.();
    });
  }

  getRedirectUri() {
    if (!this.server?.listening) {
      throw new Error("Loopback server is not listening");
    }
    const address = this.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Loopback server returned an invalid address");
    }
    return `http://localhost:${address.port}`;
  }

  closeServer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.server) return;
    this.server.close();
    this.server.closeAllConnections?.();
    this.server.unref();
    this.server = null;
  }
}
