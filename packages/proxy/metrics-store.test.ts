import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestMetricInput } from "./metrics-store";

const sqlite = vi.hoisted(() => ({ database: null as import("node:sqlite").DatabaseSync | null }));

vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  sqlite.database = new actual.DatabaseSync(":memory:");
  return {
    ...actual,
    DatabaseSync: vi.fn(function () {
      if (new.target === undefined) {
        throw new Error("DatabaseSync must be constructed");
      }
      if (sqlite.database === null) {
        throw new Error("In-memory SQLite database is not initialized");
      }
      return sqlite.database;
    }),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, mkdirSync: vi.fn() };
});

const { metricsStore } = await import("./metrics-store");

function metric(overrides: Partial<RequestMetricInput> = {}): RequestMetricInput {
  return {
    requestId: "test-request",
    startedAt: 0,
    endedAt: 1000,
    latencyMs: 1000,
    statusCode: 200,
    model: "gpt-5.5-think-deeper",
    stream: false,
    sessionId: null,
    conversationId: null,
    finishReason: null,
    messageType: null,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    conversationMessages: 1,
    conversationMax: 600,
    conversationRemaining: 599,
    modelLatencyMs: 1000,
    requestBodyBytes: 0,
    responseBytes: 0,
    errorType: null,
    errorMessage: null,
    ...overrides,
  };
}

function throttle(endedAt: number, statusCode = 429): RequestMetricInput {
  return metric({
    endedAt,
    statusCode,
    errorType: "rate_limit_error",
    errorMessage: "M365 Copilot throttled this account (PerUserThrottled): Please try again later.",
  });
}

beforeEach(() => {
  if (sqlite.database === null) {
    throw new Error("In-memory SQLite database is not initialized");
  }
  sqlite.database.exec("DELETE FROM request_metrics");
});
afterAll(() => {
  sqlite.database?.close();
});

describe("persisted account-throttle status", () => {
  it.each(["rate_limit_error", "upstream_error"])(
    "counts an HTTP 200 SSE %s as a failure, not a success",
    (errorType) => {
      metricsStore.addRequestMetric(metric({ stream: true, errorType }));
      const snapshot = metricsStore.getDashboardSnapshot();
      expect(snapshot.totals).toMatchObject({ requests: 1, successRequests: 0, errorRequests: 1 });
      expect(snapshot.byModel).toMatchObject([
        { requests: 1, successRequests: 0, errorRequests: 1 },
      ]);
    },
  );

  it("still counts successful streams and ordinary HTTP failures", () => {
    metricsStore.addRequestMetric(metric({ stream: true }));
    metricsStore.addRequestMetric(metric({ statusCode: 502 }));
    const snapshot = metricsStore.getDashboardSnapshot();
    expect(snapshot.totals).toMatchObject({ requests: 2, successRequests: 1, errorRequests: 1 });
    expect(snapshot.byModel).toMatchObject([
      { requests: 2, successRequests: 1, errorRequests: 1 },
    ]);
  });

  it("does not infer an upstream throttle when none has been recorded", () => {
    expect(metricsStore.getDashboardSnapshot().accountThrottle).toEqual({
      status: "unknown",
      since: null,
      lastObservedAt: null,
      message: null,
    });
  });

  it("keeps the first observation and latest throttle across unrelated failures", () => {
    metricsStore.addRequestMetric(throttle(1000));
    metricsStore.addRequestMetric(
      metric({ endedAt: 2000, statusCode: 502, errorType: "upstream_error" }),
    );
    metricsStore.addRequestMetric(throttle(4000));
    expect(metricsStore.getDashboardSnapshot().accountThrottle).toMatchObject({
      status: "throttled",
      since: 1000,
      lastObservedAt: 4000,
    });
  });

  it("does not mistake an HTTP 200 SSE error for account recovery", () => {
    metricsStore.addRequestMetric(throttle(1000));
    metricsStore.addRequestMetric(throttle(2000, 200));
    metricsStore.addRequestMetric(metric({ endedAt: 3000, errorType: "upstream_error" }));
    expect(metricsStore.getDashboardSnapshot().accountThrottle).toMatchObject({
      status: "throttled",
      since: 1000,
      lastObservedAt: 2000,
    });
  });

  it("records recovery on success and starts a new observation period on another throttle", () => {
    metricsStore.addRequestMetric(throttle(1000));
    metricsStore.addRequestMetric(metric({ endedAt: 2000 }));
    expect(metricsStore.getDashboardSnapshot().accountThrottle).toMatchObject({
      status: "recovered",
      since: null,
      lastObservedAt: 1000,
    });
    metricsStore.addRequestMetric(throttle(3000));
    expect(metricsStore.getDashboardSnapshot().accountThrottle).toMatchObject({
      status: "throttled",
      since: 3000,
      lastObservedAt: 3000,
    });
  });

  it("does not treat priority-access quota refusals as an account throttle", () => {
    metricsStore.addRequestMetric(
      metric({
        statusCode: 429,
        errorType: "rate_limit_error",
        errorMessage: "M365 Copilot's priority access to claude-opus is used up for today.",
      }),
    );
    expect(metricsStore.getDashboardSnapshot().accountThrottle.status).toBe("unknown");
  });

  it("retains the observed throttle when the store is initialized again", async () => {
    metricsStore.addRequestMetric(throttle(1000));
    vi.resetModules();
    const { metricsStore: reinitialized } = await import("./metrics-store");
    expect(reinitialized.getDashboardSnapshot().accountThrottle).toMatchObject({
      status: "throttled",
      since: 1000,
      lastObservedAt: 1000,
    });
  });
});
