import * as nodeCrypto from "node:crypto";
import type { ChatMessage, ToolCall } from "./schemas.js";
import z from "zod/v4";

type PromptMessage = {
  role: string;
  content?: z.output<typeof ChatMessage>["content"];
  tool_calls?: Array<Pick<z.output<typeof ToolCall>, "id" | "function">>;
};

type CryptoHash = {
  update(value: string): CryptoHash;
  digest(): Uint8Array;
};

type CryptoApi = {
  createHash(algorithm: "sha256"): CryptoHash;
  timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean;
};

function isCryptoApi(value: unknown): value is CryptoApi {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof Reflect.get(value, "createHash") === "function" &&
    typeof Reflect.get(value, "timingSafeEqual") === "function"
  );
}

function getCryptoApi(): CryptoApi {
  const value: unknown = nodeCrypto;
  if (!isCryptoApi(value)) throw new Error("Node crypto API is unavailable");
  return value;
}

function getEnvironmentValue(name: string): unknown {
  const processValue: unknown = Reflect.get(globalThis, "process");
  if (processValue === null || typeof processValue !== "object") return undefined;
  const environment: unknown = Reflect.get(processValue, "env");
  if (environment === null || typeof environment !== "object") return undefined;
  return Reflect.get(environment, name);
}

// --- OpenAI-shaped error responses ---

export interface OpenAIErrorBody {
  message: string;
  type: string;
  code?: string | null;
  param?: string | null;
  [extra: string]: unknown;
}

/** An `{error:{message,type,param,code}}` response; `param`/`code` are always present, as OpenAI sends them. */
export function openAIError(
  status: number,
  error: OpenAIErrorBody,
  headers: Record<string, string> = {},
): Response {
  const body = { error: { ...error, param: error.param ?? null, code: error.code ?? null } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** 400 for a body that failed schema validation (or wasn't JSON at all). */
export function invalidRequestError(err: unknown): Response {
  if (err instanceof z.ZodError) {
    const first = err.issues[0];
    const param = first && first.path.length > 0 ? first.path.join(".") : null;
    return openAIError(400, {
      message: z.prettifyError(err),
      type: "invalid_request_error",
      param,
    });
  }
  const message = err instanceof Error ? err.message : "Invalid request body";
  return openAIError(400, { message, type: "invalid_request_error" });
}

/** 404 for an unknown path, or 405 (with `Allow`) when the path exists under another method. */
export function routeNotFound(
  method: string,
  pathname: string,
  routes: Record<string, string[]>,
): Response {
  const allowed =
    routes[pathname] ??
    (/^\/v1\/models\/[^/]+$/.test(pathname) ? routes["/v1/models/{id}"] : undefined);
  if (allowed && !allowed.includes(method)) {
    return openAIError(
      405,
      {
        message: `Method ${method} not allowed for ${pathname}. Allowed: ${allowed.join(", ")}.`,
        type: "invalid_request_error",
        code: "method_not_allowed",
      },
      { Allow: allowed.join(", ") },
    );
  }
  return openAIError(404, {
    message: `Invalid URL (${method} ${pathname})`,
    type: "invalid_request_error",
    code: "unknown_url",
  });
}

/** The routes the proxy serves, for 404-vs-405 decisions. */
export const OPENAI_ROUTES: Record<string, string[]> = {
  "/health": ["GET"],
  "/v1/models": ["GET"],
  "/v1/models/{id}": ["GET"],
  "/v1/chat/completions": ["POST"],
};

// --- API key ---

/** The configured proxy API key, or null when the proxy is open. */
export function configuredApiKey(): string | null {
  const key = getEnvironmentValue("M365_PROXY_API_KEY");
  return typeof key === "string" && key.length > 0 ? key : null;
}

/** Constant-time check of an `Authorization: Bearer <key>` header. */
export function isAuthorized(authorization: string | null | undefined, expected: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(authorization?.trim() ?? "");
  if (!match) return false;
  const cryptoApi = getCryptoApi();
  const digest = (value: string) => cryptoApi.createHash("sha256").update(value).digest();
  return cryptoApi.timingSafeEqual(digest(match[1].trim()), digest(expected));
}

export function unauthorizedError(): Response {
  return openAIError(
    401,
    {
      message: "Incorrect or missing API key. Send it as 'Authorization: Bearer <key>'.",
      type: "invalid_request_error",
      code: "invalid_api_key",
    },
    { "WWW-Authenticate": "Bearer" },
  );
}

// --- Token estimates (M365 exposes no token counts) ---

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** The size of the context the client sent (full history + tool schemas), not the delta we forward. */
export function estimatePromptTokens(messages: PromptMessage[], tools?: unknown[]): number {
  let chars = 0;
  for (const m of messages) {
    chars +=
      typeof m.content === "string"
        ? m.content.length
        : (m.content?.reduce((total, part) => total + (part.text || "").length, 0) ?? 0);
    for (const tc of m.tool_calls ?? [])
      chars += tc.function.name.length + tc.function.arguments.length;
  }
  if (tools && tools.length > 0) chars += JSON.stringify(tools).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
