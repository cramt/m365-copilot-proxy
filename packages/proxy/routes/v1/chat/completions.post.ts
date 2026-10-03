import {
  ChatCompletionRequest,
  handleChatCompletion,
  invalidRequestError,
} from "@m365-copilot/proxy-lib";
import { pool } from "../../../server-pool";
import { logCompletionStatus, recordCompletionMetric, syncActiveSessions } from "../../../metrics";

function parseJsonOrNull(input: string | null): Record<string, unknown> | null {
  if (!input) return null;
  try {
    const parsed = JSON.parse(input);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseIntOrNull(input: string | null): number | null {
  if (!input) return null;
  const n = Number.parseInt(input, 10);
  return Number.isFinite(n) ? n : null;
}

function parseBoolean(input: string | null): boolean {
  return input === "1" || input === "true";
}

function coerceModel(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export default defineEventHandler(async (event) => {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  let body: ReturnType<typeof ChatCompletionRequest.parse>;
  let requestBodyBytes = 0;
  try {
    const rawBody = await readBody(event);
    requestBodyBytes = Buffer.byteLength(
      typeof rawBody === "string" ? rawBody : JSON.stringify(rawBody ?? {}),
      "utf8",
    );
    body = ChatCompletionRequest.parse(rawBody);
  } catch (err: any) {
    const response = invalidRequestError(err);
    const endedAt = Date.now();
    const latencyMs = endedAt - startedAt;
    const responseBytes = Buffer.byteLength(await response.clone().text(), "utf8");
    logCompletionStatus({
      requestId,
      model: "invalid",
      stream: false,
      statusCode: response.status,
      latencyMs,
      sessionId: null,
      conversationId: null,
      usage: null,
      finishReason: null,
      messageType: null,
      errorType: "invalid_request_error",
      errorMessage: err.message,
    });
    recordCompletionMetric({
      requestId,
      startedAt,
      endedAt,
      latencyMs,
      statusCode: response.status,
      model: "invalid",
      stream: false,
      sessionId: null,
      conversationId: null,
      usage: null,
      finishReason: null,
      messageType: null,
      requestBodyBytes,
      responseBytes,
      errorType: "invalid_request_error",
      errorMessage: err.message,
    });
    syncActiveSessions(pool.getActiveConversations());
    return response;
  }

  // Propagate client disconnects as an AbortSignal so a long M365 turn gets
  // cancelled (Stop frame) instead of running on after the caller gave up.
  // Only abort on a *premature* close — guard with the response "finish" event
  // so a normal keep-alive socket close after a completed response is ignored.
  const ac = new AbortController();
  const req = event.node?.req;
  const res = event.node?.res;
  if (req && res) {
    let finished = false;
    res.once("finish", () => {
      finished = true;
    });
    const maybeAbort = () => {
      if (!finished && !res.writableEnded) ac.abort();
    };
    req.once("close", maybeAbort);
    res.once("close", maybeAbort);
  }

  // handleChatCompletion returns a Web Response (JSON or an SSE ReadableStream
  // when stream:true). Returning it directly lets h3 forward it untouched.
  let streamError: { type: string; message: string } | undefined;
  const response = await handleChatCompletion(body, pool, {
    signal: ac.signal,
    onComplete: (_response, error) => {
      streamError = error;
    },
  });
  async function recordResponse(responseBytesOverride?: number): Promise<void> {
    const endedAt = Date.now();
    const latencyMs = endedAt - startedAt;
    const usage = parseJsonOrNull(response.headers.get("x-proxy-usage"));
    const sessionId = response.headers.get("x-proxy-session-id");
    const conversationId = response.headers.get("x-proxy-conversation-id");
    const finishReason = response.headers.get("x-proxy-finish-reason");
    const messageType = response.headers.get("x-proxy-message-type");
    const modelHeader = response.headers.get("x-proxy-model") || body.model || "unknown";
    const streamHeader = parseBoolean(response.headers.get("x-proxy-stream"));
    let usedUsage = usage;
    let finish = finishReason;
    let messageTypeFinal =
      messageType ||
      (usedUsage && typeof usedUsage.x_m365_message_type === "string"
        ? usedUsage.x_m365_message_type
        : null);
    let responseBytes =
      responseBytesOverride ?? parseIntOrNull(response.headers.get("content-length"));
    let errorType: string | null = streamError?.type ?? null;
    let errorMessage: string | null = streamError?.message ?? null;
    let modelFinal = modelHeader;

    if (!streamHeader) {
      const responseText = await response.clone().text();
      responseBytes = responseBytes ?? Buffer.byteLength(responseText, "utf8");
      const parsedBody = parseJsonOrNull(responseText);
      const errorObj =
        parsedBody?.error && typeof parsedBody.error === "object"
          ? (parsedBody.error as Record<string, unknown>)
          : null;
      const parsedUsage =
        parsedBody?.usage && typeof parsedBody.usage === "object"
          ? (parsedBody.usage as Record<string, unknown>)
          : null;
      if (!usedUsage) usedUsage = parsedUsage;
      if (
        !finish &&
        parsedBody?.choices &&
        Array.isArray(parsedBody.choices) &&
        parsedBody.choices.length > 0
      ) {
        const parsedFinish = parseJsonOrNull(JSON.stringify(parsedBody.choices[0]));
        if (parsedFinish && typeof parsedFinish.finish_reason === "string") {
          finish = parsedFinish.finish_reason;
        }
      }
      if (!messageTypeFinal && usedUsage && typeof usedUsage.x_m365_message_type === "string") {
        messageTypeFinal = usedUsage.x_m365_message_type;
      }
      errorType = errorObj && typeof errorObj.type === "string" ? errorObj.type : null;
      errorMessage = errorObj && typeof errorObj.message === "string" ? errorObj.message : null;
      modelFinal = coerceModel(parsedBody?.model, modelFinal);
    }

    if (responseBytes === null) {
      responseBytes = 0;
    }

    logCompletionStatus({
      requestId,
      model: modelFinal,
      stream: streamHeader,
      statusCode: response.status,
      latencyMs,
      sessionId,
      conversationId,
      usage: usedUsage,
      finishReason: finish,
      messageType: messageTypeFinal,
      errorType,
      errorMessage,
    });
    recordCompletionMetric({
      requestId,
      startedAt,
      endedAt,
      latencyMs,
      statusCode: response.status,
      model: modelFinal,
      stream: streamHeader,
      sessionId,
      conversationId,
      usage: usedUsage,
      finishReason: finish,
      messageType: messageTypeFinal,
      requestBodyBytes,
      responseBytes,
      errorType,
      errorMessage,
    });
    syncActiveSessions(pool.getActiveConversations());
  }

  if (
    body.stream &&
    response.body &&
    response.headers.get("content-type")?.includes("text/event-stream")
  ) {
    let responseBytes = 0;
    const measuredStream = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          responseBytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
        async flush() {
          await recordResponse(responseBytes);
        },
      }),
    );
    return new Response(measuredStream, { status: response.status, headers: response.headers });
  }

  await recordResponse();
  return response;
});
