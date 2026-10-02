import { ChatCompletionRequest, handleChatCompletion } from "@m365-copilot/proxy-lib";
import { pool } from "../../server-pool";
import { logCompletionStatus, recordCompletionMetric, syncActiveSessions } from "../../metrics";

const PING_TIMEOUT_MS = Number(process.env.M365_DASH_PING_TIMEOUT_MS ?? 45_000);

function json(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

function parseJsonOrNull(input: string | null): Record<string, unknown> | null {
    if (!input) return null;
    try {
        const parsed = JSON.parse(input);
        return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

export default defineEventHandler(async (event) => {
    const requestId = `dash-ping-${crypto.randomUUID()}`;
    const startedAt = Date.now();

    const bodyRaw = await readBody(event);
    const model = typeof bodyRaw?.model === "string" && bodyRaw.model.length > 0
        ? bodyRaw.model
        : "m365-copilot";

    const payload = ChatCompletionRequest.parse({
        model,
        stream: false,
        messages: [{ role: "user", content: "ok" }],
    });

    const response = await handleChatCompletion(payload, pool, { signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
    const endedAt = Date.now();
    const latencyMs = endedAt - startedAt;

    const usage = parseJsonOrNull(response.headers.get("x-proxy-usage"));
    const sessionId = response.headers.get("x-proxy-session-id");
    const conversationId = response.headers.get("x-proxy-conversation-id");
    const finishReason = response.headers.get("x-proxy-finish-reason");
    const messageType = response.headers.get("x-proxy-message-type");
    const modelHeader = response.headers.get("x-proxy-model") || model;

    const responseText = await response.clone().text();
    const responseBytes = Buffer.byteLength(responseText, "utf8");
    const body = parseJsonOrNull(responseText);
    const errorObj = body?.error && typeof body.error === "object"
        ? body.error as Record<string, unknown>
        : null;
    const errorType = errorObj && typeof errorObj.type === "string" ? errorObj.type : null;
    const errorMessage = errorObj && typeof errorObj.message === "string" ? errorObj.message : null;

    logCompletionStatus({
        requestId,
        model: modelHeader,
        stream: false,
        statusCode: response.status,
        latencyMs,
        sessionId,
        conversationId,
        usage,
        finishReason,
        messageType,
        errorType,
        errorMessage,
    });

    recordCompletionMetric({
        requestId,
        startedAt,
        endedAt,
        latencyMs,
        statusCode: response.status,
        model: modelHeader,
        stream: false,
        sessionId,
        conversationId,
        usage,
        finishReason,
        messageType,
        requestBodyBytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
        responseBytes,
        errorType,
        errorMessage,
    });

    syncActiveSessions(pool.getActiveConversations());

    if (!response.ok) {
        return json(response.status, {
            model: modelHeader,
            status: "error",
            latencyMs,
            error: {
                type: errorType ?? "upstream_error",
                message: errorMessage ?? "Ping failed",
            },
        });
    }

    return json(200, {
        model: modelHeader,
        status: "ok",
        latencyMs,
        finishReason: finishReason ?? null,
        messageType: messageType ?? null,
    });
});
