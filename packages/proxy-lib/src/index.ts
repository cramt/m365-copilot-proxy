import { type ModelSessionOptions, getAvailableModels } from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import { SessionPool, handleChatCompletion } from "./handler.js";
import {
  OPENAI_ROUTES,
  configuredApiKey,
  invalidRequestError,
  isAuthorized,
  openAIError,
  routeNotFound,
  unauthorizedError,
} from "./openai.js";

export { SessionPool, handleChatCompletion } from "./handler.js";
export type { ActiveConversationSnapshot, SessionUsageSnapshot } from "./handler.js";
export { ChatCompletionRequest, ChatMessage, ToolCall, ToolDefinition } from "./schemas.js";
export {
  OPENAI_ROUTES,
  configuredApiKey,
  estimatePromptTokens,
  estimateTokens,
  invalidRequestError,
  isAuthorized,
  openAIError,
  routeNotFound,
  unauthorizedError,
  type OpenAIErrorBody,
} from "./openai.js";

// Re-export tool utilities from core
export {
  formatMessages,
  formatToolDefinitions,
  parseToolCalls,
  getMessageContent,
  type Message,
  type ToolDef,
  type ToolChoice,
  type ParsedToolCall,
  type ParseResult,
} from "@m365-copilot/core";

// --- Shared response payloads (reused by the Nitro routes in @m365-copilot/proxy) ---

/** Static body for `GET /health`. */
export const HEALTH_PAYLOAD = { status: "ok" } as const;

// Window/output hints surfaced to harnesses on /v1/models so they can size
// context packing and output expectations. These are ADVERTISED hints only — M365
// enforces its own limits server-side; the number here just stops harnesses from
// pre-truncating our prompts/output. Empirically (docs/hypotheses.md F9) M365 accepts
// ≥500k tokens of input (retrieval-backed); the old ~3k output hint made harnesses
// cap generation far below what a coding turn needs. Advertise a roomy 1M window +
// 1M output (in line with modern large-context models) so nothing client-side clips.
// Override via env.
const CONTEXT_WINDOW_TOKENS = Number(process.env.M365_CONTEXT_WINDOW) || 1_000_000;
const MAX_OUTPUT_TOKENS = Number(process.env.M365_MAX_OUTPUT_TOKENS) || 1_000_000;

/** Build the OpenAI-compatible `GET /v1/models` payload. */
export function buildModelsPayload() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: getAvailableModels().map((id) => modelEntry(id, created)),
  };
}

/** The `GET /v1/models/{id}` payload, or null for an unknown ID. */
export function buildModelEntry(id: string) {
  return getAvailableModels().includes(id) ? modelEntry(id, Math.floor(Date.now() / 1000)) : null;
}

/** `decodeURIComponent` that leaves malformed escapes as-is instead of throwing. */
export function safeDecode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** 404 `model_not_found` in OpenAI's shape. */
export function modelNotFoundError(id: string): Response {
  return openAIError(404, {
    message: `The model '${id}' does not exist`,
    type: "invalid_request_error",
    param: "model",
    code: "model_not_found",
  });
}

function modelEntry(id: string, created: number) {
  return {
    id,
    object: "model",
    created,
    owned_by: "microsoft",
    // Non-standard but widely-read by OpenAI-compatible harnesses. Several
    // aliases because clients disagree on the key name. Unknown keys are
    // ignored by strict clients.
    context_window: CONTEXT_WINDOW_TOKENS,
    max_context_length: CONTEXT_WINDOW_TOKENS,
    max_input_tokens: CONTEXT_WINDOW_TOKENS,
    max_output_tokens: MAX_OUTPUT_TOKENS,
  };
}

// --- CORS (permissive, matches the previous Hono `cors()` default) ---

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
  return res;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A minimal Web fetch handler — the same shape Hono exposed via `app.fetch`. */
export interface FetchApp {
  fetch(req: Request): Promise<Response>;
}

/**
 * Create a framework-free fetch handler that serves an OpenAI-compatible API
 * backed by M365 Copilot. Each distinct conversation automatically gets its own
 * M365 session via the SessionPool.
 *
 * This is the embeddable entry point used by the tests, `proxy-verify`, and the
 * openclaw-plugin. The standalone server is the Nitro app in `@m365-copilot/proxy`,
 * whose routes reuse the same `handleChatCompletion` / `buildModelsPayload` helpers.
 *
 * `apiKey` (default: `M365_PROXY_API_KEY`) requires `Authorization: Bearer <key>` on `/v1/*`.
 */
export function createApp(
  sessionOptions: ModelSessionOptions = {},
  apiKey: string | null = configuredApiKey(),
): FetchApp {
  const pool = new SessionPool(sessionOptions);

  async function fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const method = req.method.toUpperCase();

    if (method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (
      apiKey &&
      pathname.startsWith("/v1/") &&
      !isAuthorized(req.headers.get("authorization"), apiKey)
    ) {
      return withCors(unauthorizedError());
    }

    if (method === "GET" && pathname === "/health") {
      return withCors(json(200, HEALTH_PAYLOAD));
    }

    if (method === "GET" && pathname === "/v1/models") {
      return withCors(json(200, buildModelsPayload()));
    }

    const modelMatch = method === "GET" ? /^\/v1\/models\/([^/]+)$/.exec(pathname) : null;
    if (modelMatch) {
      const id = safeDecode(modelMatch[1]);
      const entry = buildModelEntry(id);
      return withCors(entry ? json(200, entry) : modelNotFoundError(id));
    }

    if (method === "POST" && pathname === "/v1/chat/completions") {
      let body: ReturnType<typeof ChatCompletionRequest.parse>;
      try {
        body = ChatCompletionRequest.parse(await req.json());
      } catch (err) {
        return withCors(invalidRequestError(err));
      }
      // req.signal aborts when the client disconnects → cancels the M365 turn.
      return withCors(await handleChatCompletion(body, pool, { signal: req.signal }));
    }

    return withCors(routeNotFound(method, pathname, OPENAI_ROUTES));
  }

  return { fetch };
}
