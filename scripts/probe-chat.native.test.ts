import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";

const transport = vi.hoisted(() => ({ url: "" }));
// Which chats the peer throttles: by their 1-based order among the chats it has received since the last reset.
const plan = vi.hoisted(() => ({ throttleOn: new Set<number>(), codeOnly: false }));
// Preserve real WS framing/connection lifecycle; redirect only the endpoint.
vi.mock("../node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs", async (original) => {
  const ws = await original<any>();
  return { ...ws, default: class extends ws.default {
    constructor(_url: string, options: object) { super(transport.url, options); }
  } };
});
// @ts-expect-error ws's wrapper does not ship declarations at this store path.
const { WebSocketServer } = await import("../node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs");
// @ts-expect-error The probe is a JavaScript entrypoint.
const { oneTurn, probeBudgetStatus } = await import("./_probe-chat.mjs");
// @ts-expect-error The probe is a JavaScript entrypoint.
const throttleProbe = await import("./throttle-probe.mjs");
// @ts-expect-error JavaScript probe entrypoint.
const toneProbe = await import("./tone-probe.mjs");
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
transport.url = `ws://127.0.0.1:${server.address().port}`;
const chats: any[] = [];
server.on("connection", (socket: any) => {
  socket.on("message", (data: Buffer) => {
    for (const frame of data.toString().split("\x1e").filter(Boolean).map((f) => JSON.parse(f))) {
      if (frame.protocol) socket.send("{}\x1e");
      if (frame.item?.type === "chat_request") {
        chats.push(frame);
        const text = frame.item.chatStreamRequest.message.text;
        const item = text === "end throttle" ? { type: "request_end", outcome: { category: "Throttled", code: "PerUserThrottled" } }
          : text === "error throttle" ? { type: "error", errorCategory: "Throttled", errorCode: "PerUserThrottled", message: "refused" }
          : text === "error invalid" ? { type: "error", errorCategory: "InvalidRequest", errorCode: "InvalidNote", message: "Sorry, I wasn't able to respond to that.", detail: "System.ArgumentException" }
          : { type: "request_end", outcome: { category: "Success" } };
        socket.send(JSON.stringify({ type: 2, invocationId: "1", item }) + "\x1e");
      }
      if (frame.target === "chat") {
        chats.push(frame);
        if (frame.arguments[0].tone === "remote-invalid") socket.send(JSON.stringify({ type: 3, error: "Failed to invoke Chat" }) + "\x1e");
        else if (frame.arguments[0].message.text === "drop") socket.terminate();
        else if (plan.codeOnly) socket.send(JSON.stringify({ type: 2, item: { result: { errorCode: "PerUserThrottled" } } }) + "\x1e");
        else if (plan.throttleOn.has(chats.length)) socket.send(JSON.stringify({ type: 2, item: { result: { value: "Throttled", errorCode: "PerUserThrottled" }, throttling: { numUserMessagesInConversation: 1, maxNumUserMessagesInConversation: 600 } } }) + "\x1e");
        else socket.send(JSON.stringify({ type: 2, item: { result: { value: "Success" }, messages: [{ author: "bot", text: frame.arguments[0].message.text === "Reply with exactly the word: pong" ? "pong" : "synthetic reply" }] } }) + "\x1e");
      }
    }
  });
});
const principal = (n: number) => {
  const oid = `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
  const claims = { aud: "synthetic", iss: "synthetic", tid: "11111111-1111-1111-1111-111111111111", oid, exp: 2000000000 };
  return { token: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`, claims };
};
// A principal no other test uses, with the peer's chat log and throttle plan reset.
const fresh = (n: number, throttleOn: number[] = []) => { chats.length = 0; plan.throttleOn = new Set(throttleOn); return principal(n); };
const sequential = async (who: object, n: number, extra: object = {}) => {
  const out: any[] = [];
  for (let i = 0; i < n; i++) out.push(await oneTurn({ ...who, text: `turn ${i}`, timeoutMs: 1000, ...extra }));
  return out;
};
const dispatched = (rs: any[]) => rs.filter((r) => r.attempted).length;

afterEach(() => { vi.unstubAllEnvs(); });
afterAll(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve) => server.close(resolve)); vi.unstubAllEnvs(); });

it("exercises actual oneTurn over a real local WS peer, charging failed/successful retries and refusing the third dispatch", async () => {
  vi.stubEnv("M365_PROBE_MAX_ATTEMPTS", "2");
  const claims = { aud: "synthetic", iss: "synthetic", tid: "11111111-1111-1111-1111-111111111111", oid: "22222222-2222-2222-2222-222222222222", exp: 2000000000 };
  const input = { token: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`, claims, timeoutMs: 1000 };
  const dropped = await oneTurn({ ...input, text: "drop" });
  expect(chats).toHaveLength(1);
  const success = await oneTurn({ ...input, text: "reply" });
  expect(success.fullText).toBe("synthetic reply");
  expect(chats).toHaveLength(2);
  const refused = await oneTurn({ ...input, text: "over cap" });
  expect(chats).toHaveLength(2);
  expect(refused.error).toBe("probe run cap reached");
  expect(refused.attempted).toBe(false);
  expect(dropped.attempted).toBe(true);
  expect(success.attempted).toBe(true);
});

describe("per-call cap and throttle-latch options, over a real local WS peer", () => {
  it("a default call keeps the 20-attempt cap, and a throttle in the middle stops the run", async () => {
    const plain = await sequential(fresh(11), 25);
    expect(dispatched(plain)).toBe(20);
    expect(chats).toHaveLength(20);
    expect(plain[20]!.error).toBe("probe run cap reached");

    const latched = await sequential(fresh(12, [12]), 25, { maxAttempts: 25 });
    expect(chats).toHaveLength(12);
    expect(latched[11]!.result).toMatchObject({ value: "Throttled", errorCode: "PerUserThrottled" });
    expect(latched[12]!.error).toMatch(/throttle stop/);
    expect(dispatched(latched)).toBe(12);
  });

  it("maxAttempts replaces the cap for the call, whatever M365_PROBE_MAX_ATTEMPTS says", async () => {
    vi.stubEnv("M365_PROBE_MAX_ATTEMPTS", "2");
    const who = fresh(13);
    const rs = await sequential(who, 25, { maxAttempts: 25 });
    expect(chats).toHaveLength(25);
    expect(rs.every((r) => r.attempted && r.error === null)).toBe(true);
    expect(probeBudgetStatus({ ...who, maxAttempts: 25 })).toMatchObject({ attempts: 25, cap: 25, stopped: false });
    expect((await oneTurn({ ...who, text: "one more", timeoutMs: 1000, maxAttempts: 25 })).error).toBe("probe run cap reached");
    expect(chats).toHaveLength(25);
  });

  it("latchThrottle: false sees the throttle in the middle of 25 attempts and carries on", async () => {
    const who = fresh(14, [12]);
    const rs = await sequential(who, 25, { maxAttempts: 25, latchThrottle: false });
    expect(chats).toHaveLength(25);
    expect(dispatched(rs)).toBe(25);
    expect(rs[11]!.result).toMatchObject({ value: "Throttled", errorCode: "PerUserThrottled" });
    expect(rs.filter((r) => r.error !== null)).toEqual([]);
    expect(rs[12]!.fullText).toBe("synthetic reply");
    expect(probeBudgetStatus({ ...who, maxAttempts: 25 }).stopped).toBe(false);
    expect(probeBudgetStatus(who).stopped).toBe(false);
  });

  it("a recovery turn after a throttle dispatches when the run opted out, and is refused when it did not", async () => {
    const out = fresh(15, [1]);
    const first = await oneTurn({ ...out, text: "provoke", timeoutMs: 1000, latchThrottle: false });
    expect(first.result.value).toBe("Throttled");
    const recovery = await oneTurn({ ...out, text: "recover", timeoutMs: 1000, latchThrottle: false });
    expect(recovery).toMatchObject({ attempted: true, error: null, fullText: "synthetic reply" });
    expect(chats).toHaveLength(2);

    const kept = fresh(16, [1]);
    expect((await oneTurn({ ...kept, text: "provoke", timeoutMs: 1000 })).result.value).toBe("Throttled");
    const refused = await oneTurn({ ...kept, text: "recover", timeoutMs: 1000 });
    expect(refused).toMatchObject({ attempted: false });
    expect(refused.error).toMatch(/throttle stop/);
    expect(chats).toHaveLength(1);
  });

  it("an opted-out call cannot bypass a stop set by a default caller", async () => {
    const who = fresh(17, [1, 3]);
    await oneTurn({ ...who, text: "latches", timeoutMs: 1000 });
    expect(probeBudgetStatus(who).stopped).toBe(true);
    const ignoring = await oneTurn({ ...who, text: "cannot bypass", timeoutMs: 1000, latchThrottle: false });
    expect(ignoring.attempted).toBe(false);
    expect(ignoring.error).toMatch(/throttle stop/);
    expect(probeBudgetStatus({ ...who, latchThrottle: false }).stopped).toBe(true);
    expect(chats).toHaveLength(1);
  });

  it.each([0, -1, 1.5, NaN, Infinity, 2 ** 53, "20", null])("rejects maxAttempts %j before opening a socket", async (maxAttempts) => {
    const who = fresh(18);
    expect(() => oneTurn({ ...who, text: "x", maxAttempts })).toThrow(/maxAttempts must be a positive safe integer/);
    expect(() => probeBudgetStatus({ ...who, maxAttempts })).toThrow(/maxAttempts/);
    expect(chats).toHaveLength(0);
  });

  it.each(["false", 0, null])("rejects a latchThrottle that is not a boolean (%j)", (latchThrottle) => {
    expect(() => oneTurn({ ...fresh(19), text: "x", latchThrottle })).toThrow(/latchThrottle must be a boolean/);
    expect(chats).toHaveLength(0);
  });
});

describe("scripts/throttle-probe.mjs", () => {
  const noSleep = async () => {};
  const quiet = () => {};
  const run = (who: object, args: string[], throttleOn: number[]) => {
    plan.throttleOn = new Set(throttleOn);
    chats.length = 0;
    const { rpm, max, recover } = throttleProbe.parseArgs(["--rpm", "600000", ...args]);
    return throttleProbe.sweep({ oneTurn, ...who, agentId: null, rpm, max, recover, sleep: noSleep, log: quiet });
  };

  it("takes the default --max of 25, which is over the helper's default cap of 20", () => {
    expect(throttleProbe.parseArgs([])).toEqual({ rpm: 30, max: 25, recover: false, useAgent: false });
    expect(throttleProbe.parseArgs(["--max", "99", "--recover", "--agent"])).toMatchObject({ max: 60, recover: true, useAgent: true });
  });

  it("runs all 25 default turns through a throttle in the middle and reports the onset", async () => {
    const r = await run(principal(21), [], [12]);
    expect(chats).toHaveLength(25);
    expect(r.counts).toEqual({ ok: 24, empty: 1 });
    expect(r.onset.cls).toBe("empty");
    expect(r.recoveryMin).toBeNull();
  });

  it("--recover dispatches its polls after the throttle until one comes back clean", async () => {
    const r = await run(principal(22), ["--recover"], [12, 26, 27]);
    expect(chats).toHaveLength(28);
    expect(r.counts).toEqual({ ok: 24, empty: 1 });
    expect(r.recoveryMin).toBe(1.5);
  });

  it("--recover with a run that never recovers still dispatches every poll", async () => {
    // The sweep's first turn is throttled and so is every poll after the 5 sweep turns.
    const polls = Array.from({ length: throttleProbe.RECOVERY_POLLS }, (_, k) => 6 + k);
    const r = await run(principal(23), ["--max", "5", "--recover"], [1, ...polls]);
    expect(chats).toHaveLength(5 + throttleProbe.RECOVERY_POLLS);
    expect(r.recoveryMin).toBeNull();
  });
});

it("tone sweep reports local stops as skipped and does not claim the control was rejected", async () => {
  const who = fresh(30, [2]);
  const cells = ["first", "throttled", "later", "Definitely_Not_A_Real_Tone_XYZ"].map((tone) => ({ tone, note: "" }));
  let calls = 0;
  const rows = await toneProbe.sweep({ cells, ...who, transport: "chathub", oneTurn: async (o: any) => { calls++; return oneTurn(o); }, sleep: async () => {} });
  expect(calls).toBe(3);
  expect(chats).toHaveLength(2);
  expect(rows.map((r: any) => r.verdict)).toEqual(["UNKNOWN(origin=null)", "EMPTY", "SKIPPED", "SKIPPED"]);
  expect(rows[2].attempted).toBe(false);
});

it.each(["end throttle", "error throttle"])("StreamHub %s accounts one dispatch and latches subsequent calls", async (text) => {
  const who = fresh(text === "end throttle" ? 31 : 32);
  const first = await oneTurn({ ...who, transport: "streamhub", text, timeoutMs: 1000 });
  expect(first).toMatchObject({ attempted: true, result: { value: "Throttled", errorCode: "PerUserThrottled" } });
  expect(probeBudgetStatus(who)).toMatchObject({ attempts: 1, stopped: true });
  expect((await oneTurn({ ...who, transport: "streamhub", text: "success", timeoutMs: 1000 })).attempted).toBe(false);
  expect(chats).toHaveLength(1);
});

it("StreamHub success and InvalidNote error follow upstream fixture shapes", async () => {
  const who = fresh(33);
  const ok = await oneTurn({ ...who, transport: "streamhub", text: "success", timeoutMs: 1000 });
  expect(ok).toMatchObject({ attempted: true, result: { value: "Success" }, error: null });
  const invalid = await oneTurn({ ...who, transport: "streamhub", text: "error invalid", timeoutMs: 1000 });
  expect(invalid).toMatchObject({ attempted: true, result: { value: "InvalidRequest", errorCode: "InvalidNote" }, error: "InvalidRequest/InvalidNote" });
  expect(probeBudgetStatus(who)).toMatchObject({ attempts: 2, stopped: false });
  expect(chats).toHaveLength(2);
});

it("tone sweep retains a real remote invocation rejection", async () => {
  const who = fresh(34);
  const rows = await toneProbe.sweep({ cells: [{ tone: "remote-invalid", note: "" }], ...who, transport: "chathub", oneTurn, sleep: async () => {} });
  expect(chats).toHaveLength(1);
  expect(rows[0]).toMatchObject({ attempted: true, verdict: "REJECTED", error: "Failed to invoke Chat" });
});

it("throttle sweep stops local refusal without claiming degradation or recovery", async () => {
  const who = fresh(80, [1]);
  await oneTurn({ ...who, text: "latch", timeoutMs: 1000 });
  const calls: string[] = [];
  const r = await throttleProbe.sweep({ oneTurn: async (o: any) => { calls.push(o.text); return oneTurn(o); }, ...who, agentId: null, rpm: 600000, max: 3, recover: true, sleep: async () => {}, log: () => {} });
  expect(chats).toHaveLength(1);
  expect(r.onset).toBeUndefined();
  expect(r.recoveryMin).toBeNull();
  expect(r.results[0].cls).toBe("skipped");
  expect(calls.length).toBeLessThanOrEqual(3);
});

it("agent outcome distinguishes code-only remote throttle and local refusal", async () => {
  // @ts-expect-error JavaScript entrypoint
  const agent = await import("./agent-tone-probe.mjs");
  const base = { reply: "", error: null, result: { errorCode: "PerUserThrottled" } };
  expect(agent.outcome(base)).toBe("THROTTLED");
  expect(agent.outcome({ ...base, attempted: false, error: "probe turn budget hold", result: null })).toBe("SKIPPED");
});

it("recovery poll records a local pacing hold as inconclusive", async () => {
  const who = fresh(81, [1]);
  const run = await throttleProbe.sweep({ oneTurn: async (o: any) => {
    const r = await oneTurn(o);
    if (r.result?.value === "Throttled") vi.stubEnv("M365_AVOID_THROTTLING", "1");
    return r;
  }, ...who, agentId: null, rpm: 600000, max: 1, recover: true, sleep: async () => {}, log: () => {} });
  expect(chats).toHaveLength(1);
  expect(run.recoveryMin).toBeNull();
  expect(run.recoverySkipped).toBe(true);
});

it("A/B actual caller aborts a pacing hold before claiming degraded", async () => {
  // @ts-expect-error JavaScript probe
  const ab = await import("./throttle-recovery-ab.mjs");
  const who = fresh(90, [1]);
  await oneTurn({ ...who, text: "throttle", latchThrottle: false });
  vi.stubEnv("M365_AVOID_THROTTLING", "1");
  const lines: string[] = [];
  await expect(ab.main({ argv: ["--no-new", "--gap=0"], oneTurn, getTokenSilent: async () => who.token, log: (s: string) => lines.push(s) })).rejects.toThrow(/not attempted/i);
  expect(chats).toHaveLength(1);
  expect(lines.join("\n")).not.toMatch(/Confirmed degraded|verdict=/);
});

it("agent-tone actual sweep stops code-only throttle and pacing holds", async () => {
  // @ts-expect-error JavaScript probe
  const agent = await import("./agent-tone-probe.mjs");
  const who = fresh(91);
  plan.codeOnly = true;
  vi.stubEnv("M365_TRANSPORT", "chathub");
  const run = await agent.sweep({ oneTurn, ...who, agentId: "agent", cells: [{ tone: "magic", note: "" }, { tone: "magic", note: "" }], baseline: true, sleep: async () => {}, out: ".", writeFrames: false, log: () => {} });
  expect(chats).toHaveLength(1);
  expect(run.results[0].verdict).toBe("THROTTLED");
  expect(run.stoppedEarly).toBe(true);
  plan.codeOnly = false;
  const held = fresh(92, [1]);
  await oneTurn({ ...held, text: "throttle", latchThrottle: false });
  vi.stubEnv("M365_AVOID_THROTTLING", "1");
  const heldRun = await agent.sweep({ oneTurn, ...held, agentId: "agent", cells: [{ tone: "magic", note: "" }], baseline: true, sleep: async () => {}, out: ".", writeFrames: false, log: () => {} });
  expect(chats).toHaveLength(1);
  expect(heldRun.results[0].verdict).toBe("SKIPPED");
});


it("agent-tone real sweep preserves a successful remote attempt", async () => {
  // @ts-expect-error JavaScript probe
  const agent = await import("./agent-tone-probe.mjs");
  const who = fresh(93);
  const run = await agent.sweep({ oneTurn, ...who, agentId: "agent", cells: [{ tone: "magic", note: "" }], baseline: true, sleep: async () => {}, out: ".", writeFrames: false, log: () => {} });
  expect(chats).toHaveLength(2);
  expect(run.stoppedEarly).toBe(false);
  expect(run.results[0].agent.attempted).toBe(true);
  expect(run.results[0].baseline.attempted).toBe(true);
});

it("A/B real caller records rested response rather than degraded", async () => {
  // @ts-expect-error JavaScript probe
  const ab = await import("./throttle-recovery-ab.mjs");
  const who = fresh(94);
  const lines: string[] = [];
  await ab.main({ argv: ["--no-new", "--gap=0"], oneTurn, getTokenSilent: async () => who.token, log: (s: string) => lines.push(s) });
  expect(chats).toHaveLength(1);
  expect(lines.join("\n")).toMatch(/NOT degraded/);
});
