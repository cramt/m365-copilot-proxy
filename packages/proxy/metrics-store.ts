import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DATA_DIR = join(homedir(), ".config", "m365-proxy");
const DB_PATH = join(DATA_DIR, "metrics.sqlite");

export interface RequestMetricInput {
    requestId: string;
    startedAt: number;
    endedAt: number;
    latencyMs: number;
    statusCode: number;
    model: string;
    stream: boolean;
    sessionId: string | null;
    conversationId: string | null;
    finishReason: string | null;
    messageType: string | null;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    conversationMessages: number | null;
    conversationMax: number | null;
    conversationRemaining: number | null;
    modelLatencyMs: number | null;
    requestBodyBytes: number;
    responseBytes: number;
    errorType: string | null;
    errorMessage: string | null;
}

export interface ModelUsageTotals {
    model: string;
    requests: number;
    successRequests: number;
    errorRequests: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    avgLatencyMs: number | null;
    avgModelLatencyMs: number | null;
    lastSeenAt: number;
}

  export interface ModelHealthSnapshot {
    model: string;
    ok: boolean | null;
    checkedAt: number | null;
    latencyMs: number | null;
    statusCode: number | null;
    source: "ping" | "check-all" | null;
  }

export interface DashboardSnapshot {
    generatedAt: number;
    activeSessionCount: number;
    totals: {
        requests: number;
        successRequests: number;
        errorRequests: number;
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
        avgLatencyMs: number | null;
        avgModelLatencyMs: number | null;
    };
    byModel: ModelUsageTotals[];
      modelHealth: ModelHealthSnapshot[];
}

interface NumberRow {
    value: number | null;
}

interface TotalsRow {
    requests: number;
    success_requests: number;
    error_requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    avg_latency_ms: number | null;
    avg_model_latency_ms: number | null;
}

interface ModelRow {
    model: string;
    requests: number;
    success_requests: number;
    error_requests: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    avg_latency_ms: number | null;
    avg_model_latency_ms: number | null;
    last_seen_at: number;
}

  interface HealthRow {
    model: string;
    ended_at: number;
    latency_ms: number | null;
    status_code: number;
    request_id: string;
  }

interface SessionUsageUpdate {
    updatedAt: number;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    conversationMessages: number | null;
    conversationMax: number | null;
    conversationRemaining: number | null;
    modelLatencyMs: number | null;
    messageType: string | null;
}

interface ActiveSessionSnapshot {
    fingerprint: string;
    sessionId: string;
    conversationId: string;
    turnCount: number;
    sentMessageCount: number;
    lastAccessedAt: number;
    model: string;
    usage: SessionUsageUpdate | null;
}

export interface ActiveSessionView {
    fingerprint: string;
    sessionId: string;
    conversationId: string;
    model: string;
    turnCount: number;
    sentMessageCount: number;
    lastAccessedAt: number;
    updatedAt: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    conversationMessages: number | null;
    conversationMax: number | null;
    conversationRemaining: number | null;
    modelLatencyMs: number | null;
    messageType: string | null;
}

class MetricsStore {
    private db: DatabaseSync;

    constructor() {
        mkdirSync(DATA_DIR, { recursive: true });
        this.db = new DatabaseSync(DB_PATH);
        this.db.exec("PRAGMA journal_mode = WAL");
        this.db.exec("PRAGMA synchronous = NORMAL");
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS request_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        status_code INTEGER NOT NULL,
        model TEXT NOT NULL,
        stream INTEGER NOT NULL,
        session_id TEXT,
        conversation_id TEXT,
        finish_reason TEXT,
        message_type TEXT,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        conversation_messages INTEGER,
        conversation_max INTEGER,
        conversation_remaining INTEGER,
        model_latency_ms INTEGER,
        request_body_bytes INTEGER NOT NULL,
        response_bytes INTEGER NOT NULL,
        error_type TEXT,
        error_message TEXT
      )
    `);
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_request_metrics_model ON request_metrics(model)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_request_metrics_ended_at ON request_metrics(ended_at)");

        this.db.exec(`
      CREATE TABLE IF NOT EXISTS active_sessions (
        fingerprint TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        model TEXT NOT NULL,
        turn_count INTEGER NOT NULL,
        sent_message_count INTEGER NOT NULL,
        last_accessed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        prompt_tokens INTEGER NOT NULL,
        completion_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        conversation_messages INTEGER,
        conversation_max INTEGER,
        conversation_remaining INTEGER,
        model_latency_ms INTEGER,
        message_type TEXT
      )
    `);
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_active_sessions_model ON active_sessions(model)");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_active_sessions_last_accessed ON active_sessions(last_accessed_at)");
        // Active sessions are process-local (in-memory SessionPool), so clear any
        // stale rows from previous runs on startup.
        this.db.exec("DELETE FROM active_sessions");
    }

    addRequestMetric(input: RequestMetricInput): void {
        const stmt = this.db.prepare(`
      INSERT INTO request_metrics (
        request_id,
        started_at,
        ended_at,
        latency_ms,
        status_code,
        model,
        stream,
        session_id,
        conversation_id,
        finish_reason,
        message_type,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        conversation_messages,
        conversation_max,
        conversation_remaining,
        model_latency_ms,
        request_body_bytes,
        response_bytes,
        error_type,
        error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        stmt.run(
            input.requestId,
            input.startedAt,
            input.endedAt,
            input.latencyMs,
            input.statusCode,
            input.model,
            input.stream ? 1 : 0,
            input.sessionId,
            input.conversationId,
            input.finishReason,
            input.messageType,
            input.promptTokens,
            input.completionTokens,
            input.totalTokens,
            input.conversationMessages,
            input.conversationMax,
            input.conversationRemaining,
            input.modelLatencyMs,
            input.requestBodyBytes,
            input.responseBytes,
            input.errorType,
            input.errorMessage,
        );
    }

    replaceActiveSessions(sessions: ActiveSessionSnapshot[]): void {
        const tx = this.db.prepare("DELETE FROM active_sessions");
        tx.run();

        if (sessions.length === 0) return;

        const insert = this.db.prepare(`
      INSERT INTO active_sessions (
        fingerprint,
        session_id,
        conversation_id,
        model,
        turn_count,
        sent_message_count,
        last_accessed_at,
        updated_at,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        conversation_messages,
        conversation_max,
        conversation_remaining,
        model_latency_ms,
        message_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        for (const session of sessions) {
            const usage = session.usage;
            insert.run(
                session.fingerprint,
                session.sessionId,
                session.conversationId,
                session.model,
                session.turnCount,
                session.sentMessageCount,
                session.lastAccessedAt,
                usage?.updatedAt ?? 0,
                usage?.promptTokens ?? 0,
                usage?.completionTokens ?? 0,
                usage?.totalTokens ?? 0,
                usage?.conversationMessages ?? null,
                usage?.conversationMax ?? null,
                usage?.conversationRemaining ?? null,
                usage?.modelLatencyMs ?? null,
                usage?.messageType ?? null,
            );
        }
    }

    getDashboardSnapshot(): DashboardSnapshot {
        const totals = this.db.prepare(`
      SELECT
        COUNT(*) AS requests,
        SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END) AS success_requests,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_requests,
        SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens,
        SUM(total_tokens) AS total_tokens,
        AVG(latency_ms) AS avg_latency_ms,
        AVG(model_latency_ms) AS avg_model_latency_ms
      FROM request_metrics
    `).get() as TotalsRow | undefined;

        const byModelRows = this.db.prepare(`
      SELECT
        model,
        COUNT(*) AS requests,
        SUM(CASE WHEN status_code >= 200 AND status_code < 400 THEN 1 ELSE 0 END) AS success_requests,
        SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) AS error_requests,
        SUM(prompt_tokens) AS prompt_tokens,
        SUM(completion_tokens) AS completion_tokens,
        SUM(total_tokens) AS total_tokens,
        AVG(latency_ms) AS avg_latency_ms,
        AVG(model_latency_ms) AS avg_model_latency_ms,
        MAX(ended_at) AS last_seen_at
      FROM request_metrics
      GROUP BY model
      ORDER BY model
    `).all() as ModelRow[];

        const healthRows = this.db.prepare(`
      SELECT
        rm.model,
        rm.ended_at,
        rm.latency_ms,
        rm.status_code,
        rm.request_id
      FROM request_metrics rm
      JOIN (
        SELECT
          model,
          MAX(id) AS max_id
        FROM request_metrics
        WHERE request_id LIKE 'dash-ping-%' OR request_id LIKE 'dash-health-%'
        GROUP BY model
      ) latest ON latest.max_id = rm.id
      ORDER BY rm.model
    `).all() as HealthRow[];

        const activeCount = this.db.prepare("SELECT COUNT(*) AS value FROM active_sessions").get() as NumberRow | undefined;

        return {
            generatedAt: Date.now(),
            activeSessionCount: activeCount?.value ?? 0,
            totals: {
                requests: totals?.requests ?? 0,
                successRequests: totals?.success_requests ?? 0,
                errorRequests: totals?.error_requests ?? 0,
                promptTokens: totals?.prompt_tokens ?? 0,
                completionTokens: totals?.completion_tokens ?? 0,
                totalTokens: totals?.total_tokens ?? 0,
                avgLatencyMs: totals?.avg_latency_ms ?? null,
                avgModelLatencyMs: totals?.avg_model_latency_ms ?? null,
            },
            byModel: byModelRows.map((row) => ({
                model: row.model,
                requests: row.requests ?? 0,
                successRequests: row.success_requests ?? 0,
                errorRequests: row.error_requests ?? 0,
                promptTokens: row.prompt_tokens ?? 0,
                completionTokens: row.completion_tokens ?? 0,
                totalTokens: row.total_tokens ?? 0,
                avgLatencyMs: row.avg_latency_ms ?? null,
                avgModelLatencyMs: row.avg_model_latency_ms ?? null,
                lastSeenAt: row.last_seen_at ?? 0,
            })),
              modelHealth: healthRows.map((row) => ({
                model: row.model,
                ok: row.status_code >= 200 && row.status_code < 400,
                checkedAt: row.ended_at ?? null,
                latencyMs: row.latency_ms ?? null,
                statusCode: row.status_code ?? null,
                source: row.request_id.startsWith("dash-ping-")
                  ? "ping"
                  : row.request_id.startsWith("dash-health-")
                    ? "check-all"
                    : null,
              })),
        };
    }

    getActiveSessions(): ActiveSessionView[] {
        const rows = this.db.prepare(`
      SELECT
        fingerprint,
        session_id,
        conversation_id,
        model,
        turn_count,
        sent_message_count,
        last_accessed_at,
        updated_at,
        prompt_tokens,
        completion_tokens,
        total_tokens,
        conversation_messages,
        conversation_max,
        conversation_remaining,
        model_latency_ms,
        message_type
      FROM active_sessions
      ORDER BY last_accessed_at DESC
    `).all() as Array<{
            fingerprint: string;
            session_id: string;
            conversation_id: string;
            model: string;
            turn_count: number;
            sent_message_count: number;
            last_accessed_at: number;
            updated_at: number;
            prompt_tokens: number;
            completion_tokens: number;
            total_tokens: number;
            conversation_messages: number | null;
            conversation_max: number | null;
            conversation_remaining: number | null;
            model_latency_ms: number | null;
            message_type: string | null;
        }>;

        return rows.map((row) => ({
            fingerprint: row.fingerprint,
            sessionId: row.session_id,
            conversationId: row.conversation_id,
            model: row.model,
            turnCount: row.turn_count,
            sentMessageCount: row.sent_message_count,
            lastAccessedAt: row.last_accessed_at,
            updatedAt: row.updated_at,
            promptTokens: row.prompt_tokens,
            completionTokens: row.completion_tokens,
            totalTokens: row.total_tokens,
            conversationMessages: row.conversation_messages,
            conversationMax: row.conversation_max,
            conversationRemaining: row.conversation_remaining,
            modelLatencyMs: row.model_latency_ms,
            messageType: row.message_type,
        }));
    }
}

export const metricsStore = new MetricsStore();
