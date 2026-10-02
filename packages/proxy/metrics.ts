import type { ActiveConversationSnapshot } from "@m365-copilot/proxy-lib";
import { metricsStore, type DashboardSnapshot, type RequestMetricInput } from "./metrics-store";

export interface CompletionMetricInput {
    requestId: string;
    startedAt: number;
    endedAt: number;
    latencyMs: number;
    statusCode: number;
    model: string;
    stream: boolean;
    sessionId: string | null;
    conversationId: string | null;
    usage: Record<string, unknown> | null;
    finishReason: string | null;
    messageType: string | null;
    requestBodyBytes: number;
    responseBytes: number;
    errorType: string | null;
    errorMessage: string | null;
}

export interface CompletionLogInput {
    requestId: string;
    model: string;
    stream: boolean;
    statusCode: number;
    latencyMs: number;
    sessionId: string | null;
    conversationId: string | null;
    usage: Record<string, unknown> | null;
    finishReason: string | null;
    messageType: string | null;
    errorType: string | null;
    errorMessage: string | null;
}

function toNumber(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toNumberOrNull(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toModelLatencyMs(usage: Record<string, unknown> | null): number | null {
    if (!usage) return null;
    return toNumberOrNull(usage.x_proxy_model_latency_ms);
}

export function recordCompletionMetric(input: CompletionMetricInput): void {
    const usage = input.usage;
    const row: RequestMetricInput = {
        requestId: input.requestId,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        latencyMs: input.latencyMs,
        statusCode: input.statusCode,
        model: input.model,
        stream: input.stream,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        finishReason: input.finishReason,
        messageType: input.messageType,
        promptTokens: toNumber(usage?.prompt_tokens),
        completionTokens: toNumber(usage?.completion_tokens),
        totalTokens: toNumber(usage?.total_tokens),
        conversationMessages: toNumberOrNull(usage?.x_m365_conversation_messages),
        conversationMax: toNumberOrNull(usage?.x_m365_conversation_max),
        conversationRemaining: toNumberOrNull(usage?.x_m365_conversation_remaining),
        modelLatencyMs: toModelLatencyMs(usage),
        requestBodyBytes: input.requestBodyBytes,
        responseBytes: input.responseBytes,
        errorType: input.errorType,
        errorMessage: input.errorMessage,
    };

    metricsStore.addRequestMetric(row);
}

export function syncActiveSessions(sessions: ActiveConversationSnapshot[]): void {
    metricsStore.replaceActiveSessions(sessions);
}

export function getDashboardSnapshot(): DashboardSnapshot {
    return metricsStore.getDashboardSnapshot();
}

export function getActiveSessionsSnapshot() {
    return metricsStore.getActiveSessions();
}

export function logCompletionStatus(input: CompletionLogInput): void {
    const usage = input.usage;
    const promptTokens = toNumber(usage?.prompt_tokens);
    const completionTokens = toNumber(usage?.completion_tokens);
    const totalTokens = toNumber(usage?.total_tokens);
    const conversationMessages = toNumberOrNull(usage?.x_m365_conversation_messages);
    const conversationMax = toNumberOrNull(usage?.x_m365_conversation_max);
    const conversationRemaining = toNumberOrNull(usage?.x_m365_conversation_remaining);
    const modelLatencyMs = toModelLatencyMs(usage);

    const status = input.statusCode >= 400 ? "ERROR" : "OK";
    const modelLatency = modelLatencyMs === null ? "n/a" : `${modelLatencyMs}ms`;
    const convUsage =
        conversationMessages === null || conversationMax === null
            ? "n/a"
            : `${conversationMessages}/${conversationMax}`;
    const totalTokenText = `${promptTokens}/${completionTokens}/${totalTokens}`;
    const finish = input.finishReason ?? "n/a";
    const messageType = input.messageType ?? "n/a";
    const sessionId = input.sessionId ?? "n/a";
    const conversationId = input.conversationId ?? "n/a";

    console.log(
        `[request:${input.requestId}] ${status} model=${input.model} stream=${input.stream} status=${input.statusCode} latency=${input.latencyMs}ms model_latency=${modelLatency} finish=${finish} message_type=${messageType} tokens(p/c/t)=${totalTokenText} conv=${convUsage} remaining=${conversationRemaining ?? "n/a"} sid=${sessionId} cid=${conversationId}`,
    );

    if (input.errorType || input.errorMessage) {
        console.error(
            `[request:${input.requestId}] ERROR_DETAIL type=${input.errorType ?? "unknown"} message=${input.errorMessage ?? "unknown"}`,
        );
    }
}
