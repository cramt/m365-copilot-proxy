import { type ModelSessionOptions, enabledBackends, formatModelId, getAvailableModels, listModelEntries, resolveModelRoute, runtimeCatalog } from "@m365-copilot/core";
import { ChatCompletionRequest } from "./schemas.js";
import { SessionPool, handleChatCompletion } from "./handler.js";
import { ImageGenerationRequest, handleImageGeneration } from "./images.js";
import { checkAccess, corsHeaders, corsPolicy } from "./access.js";
import { RequestBodyError, readRequestText } from "./request-body.js";

export { SessionPool, handleChatCompletion } from "./handler.js";
export { RequestBodyError, readRequestJson } from "./request-body.js";
export { ImageGenerationRequest, handleImageGeneration, orientationForSize } from "./images.js";
export { ChatCompletionRequest, ChatMessage, ToolCall, ToolDefinition } from "./schemas.js";
export {
  isAgentHarnessUserAgent,
  streamErrorsAsText,
  streamErrorText,
  stripGatewayToolTips,
  stripGatewayToolTipsFromMessages,
} from "./harness.js";
export { checkAccess, corsHeaders, corsPolicy, type AccessDecision, type AccessRequest, type CorsPolicy } from "./access.js";

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

/** Build the OpenAI-compatible `GET /v1/models` payload: every Chat model ID, as
 *  before, then one ID per model on each enabled backend (M365_BACKENDS), named
 *  `<model>(<backend>)[_<window>][_credit]` (core backends.ts). A suffixed ID
 *  advertises the window it names, when measured. Cowork and Code list what the
 *  agent runtime's catalog has now (kept 10 min; the built-in table when it
 *  can't be read). */
export async function buildModelsPayload() {
  const created = Math.floor(Date.now() / 1000);
  const backends = enabledBackends();
  const catalog = backends.some((b) => b !== "chat") ? await runtimeCatalog() : null;
  const entry = (id: string, window: number, extra: Record<string, unknown> = {}) => ({
    id,
    object: "model",
    created,
    owned_by: "microsoft",
    // Non-standard but widely-read by OpenAI-compatible harnesses. Several
    // aliases because clients disagree on the key name. Unknown keys are
    // ignored by strict clients.
    context_window: window,
    max_context_length: window,
    max_input_tokens: window,
    max_output_tokens: MAX_OUTPUT_TOKENS,
    input_modalities: resolveModelRoute(id).backend === "chat" ? ["text", "image"] : ["text"],
    ...extra,
  });
  return {
    object: "list",
    data: [
      ...getAvailableModels().map((id) => entry(id, CONTEXT_WINDOW_TOKENS)),
      ...listModelEntries(backends, catalog).map((m) =>
        entry(formatModelId(m), m.window ?? CONTEXT_WINDOW_TOKENS, {
          x_m365_backend: m.backend,
          x_m365_model: m.base,
          x_m365_uses_credits: m.credits,
          ...(m.window ? { x_m365_measured_window: m.window } : {}),
        }),
      ),
    ],
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A minimal Web fetch handler — the same shape Hono exposed via `app.fetch`. */
/** Fetch JSON uses replacement decoding and native JSON.parse errors. */
async function readFetchJson(req: Request): Promise<unknown> {
  const reader = req.body?.getReader();
  if (!reader) return JSON.parse("");
  let text: string;
  try {
    text = await readRequestText({ [Symbol.asyncIterator]: () => ({ next: () => reader.read() }) }, req.headers.get("content-length"), false);
  } catch (err) {
    // Cancellation must not delay a refusal if the producer never settles.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
    throw err;
  }
  reader.releaseLock();
  return JSON.parse(text);
}

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
 */
export function createApp(sessionOptions: ModelSessionOptions = {}): FetchApp {
  const pool = new SessionPool(sessionOptions);

  async function fetch(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);
    const method = req.method.toUpperCase();
    const origin = req.headers.get("origin");
    const cors = corsHeaders(corsPolicy(), origin);
    const withCors = (res: Response): Response => {
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
      return res;
    };

    const access = checkAccess({
      method,
      pathname,
      origin,
      authorization: req.headers.get("authorization"),
      apiKey: req.headers.get("x-api-key"),
    });
    if (access.kind === "deny") {
      return withCors(json(access.status, { error: { message: access.message, type: "invalid_request_error" } }));
    }

    if (method === "OPTIONS") {
      return withCors(new Response(null, { status: 204 }));
    }

    if (method === "GET" && pathname === "/health") {
      return withCors(json(200, HEALTH_PAYLOAD));
    }

    if (method === "GET" && pathname === "/v1/models") {
      return withCors(json(200, await buildModelsPayload()));
    }

    if (method === "POST" && pathname === "/v1/chat/completions") {
      let body: ReturnType<typeof ChatCompletionRequest.parse>;
      try {
        body = ChatCompletionRequest.parse(await readFetchJson(req));
      } catch (err: any) {
        return withCors(
          json(err instanceof RequestBodyError ? err.status : 400, { error: { message: err.message, type: "invalid_request_error" } }),
        );
      }
      // req.signal aborts when the client disconnects → cancels the M365 turn.
      return withCors(await handleChatCompletion(body, pool, {
        signal: req.signal,
        userAgent: req.headers.get("user-agent"),
      }));
    }

    if (method === "POST" && pathname === "/v1/images/generations") {
      let body: ImageGenerationRequest;
      try {
        body = ImageGenerationRequest.parse(await readFetchJson(req));
      } catch (err: any) {
        return withCors(
          json(err instanceof RequestBodyError ? err.status : 400, { error: { message: err.message, type: "invalid_request_error" } }),
        );
      }
      return withCors(await handleImageGeneration(body, { signal: req.signal }));
    }

    return withCors(
      json(404, { error: { message: "Not found", type: "invalid_request_error" } }),
    );
  }

  return { fetch };
}
