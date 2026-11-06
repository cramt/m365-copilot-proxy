import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { budgetConfig, proxyBudgetStatus, resetTurnBudget, recordTurn } from "../packages/core/dist/index.mjs";

const peer = vi.hoisted(() => ({ sockets: [] as any[] }));
vi.mock("../node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs", () => ({
  default: class extends EventEmitter {
    sent: any[] = [];
    constructor() { super(); peer.sockets.push(this); }
    send(data: string) { this.sent.push(...data.split("\x1e").filter(Boolean).map((frame) => JSON.parse(frame))); }
    close() {}
  },
}));
// Import the real helper; only the physical WebSocket is synthetic.
// @ts-expect-error The probe is a JavaScript entrypoint.
const { oneTurn, probeBudgetStatus } = await import("./_probe-chat.mjs");
const cfg = { ...budgetConfig({}), dirs: [] };
const guid = (label: string) => { const h = createHash("sha256").update(label).digest("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`; };
const input = (label = "a", rotation = 0) => {
  const claims = { aud: "synthetic", iss: "synthetic", tid: guid("tenant"), oid: guid(label), exp: 2000000000 };
  return { token: `e30.${Buffer.from(JSON.stringify({ ...claims, iat: rotation })).toString("base64url")}.sig`, claims, text: "hello", timeoutMs: 1000 };
};
async function start(oid = "a") {
  const before = peer.sockets.length;
  const result = oneTurn(input(oid));
  await Promise.resolve();
  const ws = peer.sockets.length > before ? peer.sockets.at(-1) : Object.assign(new EventEmitter(), { sent: [] });
  ws.emit("open");
  return { result, ws };
}
function dispatch(ws: any) { ws.emit("message", Buffer.from("{}\x1e")); }
function finish(ws: any, item: any = {}) { ws.emit("message", Buffer.from(JSON.stringify({ type: 2, item }) + "\x1e")); }

beforeEach(() => { peer.sockets.length = 0; resetTurnBudget(); });
afterEach(() => { vi.unstubAllEnvs(); });

describe("direct probe attempted-turn accounting", () => {
  it("reports an attempted turn for a failed dispatch, but not a handshake failure", async () => {
    const first = await start("failure");
    first.ws.emit("error", new Error("handshake refused"));
    expect((await first.result).attempted).toBe(false);
    const second = await start("failure");
    dispatch(second.ws);
    second.ws.emit("error", new Error("transport lost"));
    expect((await second.result).attempted).toBe(true);
    expect(second.ws.sent.filter((f: any) => f.target === "chat")).toHaveLength(1);
  });

  it("counts success and caller retries against a finite process run cap", async () => {
    vi.stubEnv("M365_PROBE_MAX_ATTEMPTS", "2");
    for (let i = 0; i < 2; i++) {
      const { ws, result } = await start("cap");
      dispatch(ws);
      if (i === 0) ws.emit("error", new Error("retry me")); else finish(ws);
      expect((await result).attempted).toBe(true);
    }
    const { ws, result } = await start("cap");
    dispatch(ws);
    finish(ws);
    expect((await result).error).toMatch(/probe run cap/);
    expect(ws.sent.filter((f: any) => f.target === "chat")).toHaveLength(0);
  });

  it("stops only the throttled principal and preserves daily metering as an observation", async () => {
    const first = await start("throttled");
    dispatch(first.ws);
    finish(first.ws, { result: { value: "Throttled", errorCode: "PerUserThrottled" }, throttling: { numUserMessagesInConversation: 1, maxNumUserMessagesInConversation: 600, metering: { TotalTurnUsageDaily: { remainingAllowance: 93 } } } });
    const observed = await first.result;
    expect(observed.result).toEqual({ value: "Throttled", errorCode: "PerUserThrottled" });
    expect(observed.throttle.metering).toEqual({ TotalTurnUsageDaily: { remainingAllowance: 93 } });
    expect(observed.throttle.meteringObservation).toEqual({ TotalTurnUsageDaily: 93 });
    const retry = await start("throttled"); dispatch(retry.ws); finish(retry.ws);
    expect((await retry.result).error).toMatch(/throttle stop/);
    expect(retry.ws.sent.filter((f: any) => f.target === "chat")).toHaveLength(0);
    const other = await start("unaffected"); dispatch(other.ws); finish(other.ws);
    expect((await other.result).error).toBeNull();
  });

  it.each([undefined, null, {}, { TotalTurnUsageDaily: { remainingAllowance: "93" } }])("keeps absent or malformed metering unknown (%j)", async (metering) => {
    const { ws, result } = await start("unknown"); dispatch(ws);
    finish(ws, { throttling: { metering } });
    expect((await result).throttle.meteringObservation).toBeNull();
  });


  it("shares native accounting without mixing principals or debug log ownership", async () => {
    const { ws, result } = await start("native"); dispatch(ws); finish(ws);
    await result;
    expect(proxyBudgetStatus(Date.now(), cfg, false).turns).toBe(0);
    const { createHash } = await import("node:crypto");
    const scope = createHash("sha256").update(JSON.stringify([guid("tenant"), guid("native")])).digest("hex");
    expect(proxyBudgetStatus(Date.now(), cfg, true, scope).turns).toBe(1);
    recordTurn();
    expect(proxyBudgetStatus(Date.now(), cfg, false).turns).toBe(1);
    expect(proxyBudgetStatus(Date.now(), cfg, true, scope).turns).toBe(1);
  });


  it("counts a synchronous send failure and a timeout exactly once", async () => {
    const { ws, result } = await start("send-throw");
    ws.send = () => { throw new Error("send failed"); };
    dispatch(ws);
    expect((await result).attempted).toBe(true);
    expect((await result).error).toBe("send failed");
    vi.useFakeTimers();
    try {
      const timed = await start("timeout"); dispatch(timed.ws);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await timed.result).attempted).toBe(true);
      expect((await timed.result).error).toBe("timeout");
      const count = timed.ws.sent.length;
      dispatch(timed.ws);
      expect(timed.ws.sent).toHaveLength(count);
    } finally { vi.useRealTimers(); }
  });

  it("enforces configured native pacing without inventing a daily allowance", async () => {
    vi.stubEnv("M365_AVOID_THROTTLING", "1");
    vi.stubEnv("M365_BUDGET_CAPACITY", "1");
    vi.stubEnv("M365_BUDGET_RESERVE", "0");
    const first = await start("paced"); dispatch(first.ws);
    finish(first.ws, { throttling: { metering: { TotalTurnUsageDaily: { remainingAllowance: 0 } } } });
    expect((await first.result).attempted).toBe(true);
    const next = await start("paced"); dispatch(next.ws); finish(next.ws);
    expect((await next.result).error).toBe("probe turn budget hold");
    expect((await next.result).attempted).toBe(false);
  });

  it("keeps malformed streaming metering unknown", async () => {
    const { ws, result } = await start("stream-unknown"); dispatch(ws);
    ws.emit("message", Buffer.from(JSON.stringify({ type: 1, arguments: [{ throttling: { metering: {} } }] }) + "\x1e"));
    finish(ws);
    expect((await result).throttle.meteringObservation).toBeNull();
  });


  it("does not dispatch when the frame observer settles the helper reentrantly", async () => {
    const result = oneTurn({ ...input("observer"), onFrame: () => peer.sockets.at(-1).emit("error", new Error("observer retired")) });
    await Promise.resolve();
    const ws = peer.sockets.at(-1); ws.emit("open"); dispatch(ws);
    expect((await result).attempted).toBe(false);
    expect(ws.sent.filter((f: any) => f.target === "chat")).toHaveLength(0);
  });


  it.each([7, 73, 200])("latches a throttle stop beyond %i hours independently of replay", async (hours) => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const label = `aged-${hours}`;
      const first = await start(label); dispatch(first.ws); finish(first.ws, { result: { value: "Throttled" } }); await first.result;
      vi.setSystemTime(new Date(Date.now() + hours * 3600000));
      const count = peer.sockets.length;
      const retry = await start(label); dispatch(retry.ws); finish(retry.ws);
      const next = await retry.result;
      expect(next.attempted).toBe(false);
      expect(next.error).toMatch(/throttle stop/);
      expect(peer.sockets).toHaveLength(count);
      expect(probeBudgetStatus(input(label)).stopped).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it("copies observer frames before handshake, terminal error and throttle interpretation", async () => {
    for (const kind of ["handshake", "terminal", "throttle"]) {
      const result = oneTurn({ ...input(`mutating-${kind}`), onFrame: (f: any) => {
        delete f.error;
        if (f.item?.result) { f.item.result.value = "Success"; delete f.item.result.errorCode; }
      } });
      const ws = peer.sockets.at(-1); ws.emit("open");
      if (kind === "handshake") {
        ws.emit("message", Buffer.from('{"error":"rejected"}\u001e'));
        expect((await result).attempted).toBe(false);
        expect((await result).error).toContain("rejected");
      } else {
        dispatch(ws);
        if (kind === "terminal") {
          ws.emit("message", Buffer.from('{"type":3,"error":"terminal refusal"}\u001e'));
          expect((await result).error).toBe("terminal refusal");
        } else {
          finish(ws, { result: { value: "Throttled", errorCode: "PerUserThrottled" } });
          expect((await result).result.value).toBe("Throttled");
          const retry = await start(`mutating-${kind}`); dispatch(retry.ws); finish(retry.ws);
          expect((await retry.result).attempted).toBe(false);
        }
      }
    }
  });

  it("recognizes code-only explicit throttle and exposes scoped status without legacy aggregation", async () => {
    const first = await start("code-only"); dispatch(first.ws);
    finish(first.ws, { result: { errorCode: "PerUserThrottled" }, throttling: { metering: { TotalTurnUsageDaily: { remainingAllowance: 0 } } } });
    expect((await first.result).result).toEqual({ errorCode: "PerUserThrottled" });
    const status = probeBudgetStatus(input("code-only"));
    expect(status).toMatchObject({ attempts: 1, cap: 20, stopped: true, observedRemaining: { TotalTurnUsageDaily: 0 } });
    expect(probeBudgetStatus(input("never-used")).attempts).toBe(0);
    expect(proxyBudgetStatus(Date.now(), cfg, false).turns).toBe(0);
    expect((await oneTurn(input("code-only"))).attempted).toBe(false);
  });

  it("rejects mismatched/invalid claims without new budget and retains rotation/canonical GUID identity", async () => {
    vi.stubEnv("M365_PROBE_MAX_ATTEMPTS", "1");
    const first = await start("identity"); dispatch(first.ws); finish(first.ws); await first.result;
    const original = input("identity");
    const count = peer.sockets.length;
    expect(() => oneTurn({ ...original, claims: input("different").claims })).toThrow(/principal/);
    expect(() => probeBudgetStatus({ ...original, claims: input("different").claims })).toThrow(/principal/);
    expect(() => oneTurn({ ...original, token: "private-bad-token" })).toThrow(/^probe accounting requires a valid JWT principal$/);
    const rotated = input("identity", 1);
    rotated.claims.oid = rotated.claims.oid.toUpperCase();
    expect((await oneTurn(rotated)).error).toMatch(/run cap/);
    expect(peer.sockets).toHaveLength(count);
    expect(probeBudgetStatus(original).attempts).toBe(1);
  });

  it.each([undefined, null, {}, { good: { remainingAllowance: 0 }, bad: { remainingAllowance: "9" }, nil: null }])("preserves raw metering shape additively (%j)", async (metering) => {
    const first = await start(`raw-${JSON.stringify(metering)}`); dispatch(first.ws);
    finish(first.ws, { throttling: { metering } });
    const value = await first.result;
    expect(value.throttle.metering).toEqual(metering);
    expect(value.throttle.meteringObservation).toEqual(metering && "good" in metering ? { good: 0 } : null);
  });

  it("checks before connect and rechecks admissions at dispatch for concurrent pending handshakes", async () => {
    vi.stubEnv("M365_PROBE_MAX_ATTEMPTS", "1");
    const first = await start("concurrent");
    const second = await start("concurrent");
    dispatch(first.ws); finish(first.ws); await first.result;
    dispatch(second.ws); finish(second.ws);
    expect((await second.result).attempted).toBe(false);
    expect(second.ws.sent.filter((f: any) => f.target === "chat")).toHaveLength(0);
    const count = peer.sockets.length;
    expect((await oneTurn(input("concurrent"))).attempted).toBe(false);
    expect(peer.sockets).toHaveLength(count);
  });

  it("returns detached observations and rejects invalid caps before opening a socket", async () => {
    const first = await start("detached"); dispatch(first.ws);
    finish(first.ws, { throttling: { metering: { TotalTurnUsageDaily: { remainingAllowance: 0 } } } });
    const summary = await first.result;
    summary.throttle.meteringObservation.TotalTurnUsageDaily = 900;
    const status = probeBudgetStatus(input("detached"));
    expect(status.observedRemaining).toEqual({ TotalTurnUsageDaily: 0 });
    status.observedRemaining.TotalTurnUsageDaily = 800;
    expect(probeBudgetStatus(input("detached")).observedRemaining).toEqual({ TotalTurnUsageDaily: 0 });
    const count = peer.sockets.length;
    for (const cap of ["", "NaN", "Infinity", "0", "-1", "1.1", "9007199254740992"]) {
      vi.stubEnv("M365_PROBE_MAX_ATTEMPTS", cap);
      expect(() => oneTurn(input("invalid-cap"))).toThrow(/positive safe integer/);
    }
    expect(peer.sockets).toHaveLength(count);
  });

  it("does not double count ordinary session accounting", () => {
    recordTurn();
    expect(proxyBudgetStatus(Date.now(), cfg, false).turns).toBe(1);
  });

  it("does not dispatch on a rejected handshake or after settlement", async () => {
    const first = await start("rejected");
    first.ws.emit("message", Buffer.from('{"error":"no"}\u001e'));
    first.ws.emit("error", new Error("closed"));
    await first.result;
    expect(first.ws.sent.filter((f: any) => f.target === "chat")).toHaveLength(0);
    first.ws.emit("message", Buffer.from("{}\x1e"));
    expect(first.ws.sent.filter((f: any) => f.target === "chat")).toHaveLength(0);
  });
});
