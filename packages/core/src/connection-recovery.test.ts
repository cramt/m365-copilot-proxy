import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";

const wire = vi.hoisted(() => ({ sockets: [] as any[], asyncClose: false }));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 1;
    sent: string[] = [];
    constructor() { super(); wire.sockets.push(this); }
    send(data: string) { this.sent.push(data); }
    close() {
      this.readyState = wire.asyncClose ? 2 : 3;
      if (!wire.asyncClose) this.emit("close");
    }
    terminate() { this.readyState = 3; this.emit("close"); }
  }
  return { default: Socket };
});
vi.mock("./auth.js", () => ({ getToken: vi.fn() }));
vi.mock("./agent.js", () => ({ getOrCreateAgent: vi.fn() }));
import { CopilotSession } from "./session.js";
import { ModelSession } from "./model.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
beforeEach(() => { process.env.M365_ACCOUNT_POLICY_PATH = join(mkdtempSync(join(tmpdir(), "connection-policy-")), "state.sqlite"); });
const token = `x.${Buffer.from(JSON.stringify({ oid: "11111111-1111-1111-1111-111111111111", tid: "22222222-2222-2222-2222-222222222222", aud: "test", iss: "test", exp: 9999999999 })).toString("base64url")}.x`;
const frame = (ws: EventEmitter, value: unknown) => ws.emit("message", Buffer.from(JSON.stringify(value) + "\x1e"));
afterEach(() => { vi.useRealTimers(); delete process.env.M365_TURN_IDLE_MS; wire.sockets = []; wire.asyncClose = false; });

describe("terminal frames with an asynchronous closing handshake", () => {
  const setup = async (nativeActions = false) => {
    vi.useFakeTimers(); process.env.M365_TURN_IDLE_MS = "100";
    wire.asyncClose = true;
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const session = new CopilotSession(nativeActions ? { nativeActions: { capabilities: [] } } : {});
    const pending = session.chat(token, "hello", undefined, controller.signal);
    await Promise.resolve();
    const ws = wire.sockets[0];
    frame(ws, {});
    return { ws, stream: await pending, controller, remove };
  };

  it("finalizes actual type2 success before transport close without a late idle error", async () => {
    const { ws, stream, controller, remove } = await setup();
    frame(ws, { type: 1, target: "update", arguments: [{ messages: [{ author: "bot", text: "answer", messageId: "m" }] }] });
    frame(ws, { type: 2, item: { result: { value: "Success" }, turnState: "Completed", messages: [] } });
    expect(ws.readyState).toBe(2); // close() does NOT emit close.
    await vi.advanceTimersByTimeAsync(500);
    const iterator = stream[Symbol.asyncIterator]();
    expect(await iterator.next()).toEqual({ value: "answer", done: false });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
    expect(stream.result).toEqual({ value: "Success" });
    expect(stream.turnState).toBe("Completed");
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    controller.abort();
    ws.emit("error", new Error("late transport error"));
    ws.emit("close");
    expect((await iterator.next()).done).toBe(true);
  });

  it.each([3, 7])("preserves type%s errors and releases resources before close", async (type) => {
    const { ws, stream, remove } = await setup();
    frame(ws, { type, invocationId: "0", error: "terminal failure" });
    expect(ws.readyState).toBe(2);
    await vi.advanceTimersByTimeAsync(500);
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(
      type === 3 ? "Completion error: terminal failure" : "Server close: terminal failure",
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("clears the Stop fallback on type3 acknowledgement before close", async () => {
    const { ws, stream, controller } = await setup();
    controller.abort();
    frame(ws, { type: 3, invocationId: "1" });
    expect(vi.getTimerCount()).toBe(0);
    expect((await stream[Symbol.asyncIterator]().next()).done).toBe(true);
  });

  it("rejects a pre-aborted signal without waiting for transport close", async () => {
    vi.useFakeTimers(); process.env.M365_TURN_IDLE_MS = "100";
    wire.asyncClose = true;
    const controller = new AbortController(); controller.abort();
    const pending = new CopilotSession().chat(token, "hello", undefined, controller.signal);
    const rejected = expect(pending).rejects.toThrow(/closed before handshake/);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await rejected;
    expect(wire.sockets[0].sent).toEqual([]);
  });

  it("still times out a silent resumed native action", async () => {
    const { ws, stream } = await setup(true);
    frame(ws, { type: 2, item: { messages: [{ author: "bot", messageType: "ConfirmationCard", actionId: "a", isConsequential: false }] } });
    const rejected = expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow("No response from M365 for 100ms");
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(ws.readyState).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores trailing frames in the same message after terminal success", async () => {
    const { ws, stream } = await setup();
    ws.emit("message", Buffer.from('{"type":2,"item":{}}\x1e{"type":7,"error":"too late"}\x1e'));
    expect((await stream[Symbol.asyncIterator]().next()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a native-action type2 resume alive until its actual result", async () => {
    const { ws, stream } = await setup(true);
    frame(ws, { type: 2, item: { messages: [{ author: "bot", messageType: "ConfirmationCard", actionId: "a", sourceRequestId: "r", isConsequential: false }] } });
    expect(ws.readyState).toBe(1);
    expect(ws.sent.some((s: string) => s.includes("ResumeInvokeAction"))).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(75);
    frame(ws, { type: 1, target: "update", arguments: [{ messages: [{ author: "bot", text: "action result", messageId: "m" }] }] });
    frame(ws, { type: 2, item: { result: { value: "Success" } } });
    await vi.advanceTimersByTimeAsync(500);
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe("action result");
    expect((await iterator.next()).done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("silent turn recovery", () => {
  it("keeps isStartOfSession false on the actual wire after a same-conversation reset", async () => {
    const model = new ModelSession({ useAgent: false, getToken: async () => token });
    const starts: boolean[] = [];
    const conversations: string[] = [];
    for (let i = 0; i < 3; i++) {
      if (i === 1) model.reset();
      if (i === 2) model.newConversation();
      const pending = model.run("hello", "gpt-5.6", undefined, false);
      // run() first awaits the injected token; no auth or network is involved.
      await Promise.resolve();
      const ws = wire.sockets[i];
      frame(ws, {});
      const stream = await pending;
      const chat = ws.sent.flatMap((data: string) => data.split("\x1e").filter(Boolean).map((part) => JSON.parse(part)))
        .find((message: any) => message.target === "chat");
      starts.push(chat.arguments[0].isStartOfSession);
      conversations.push(model.conversationId);
      frame(ws, { type: 2, item: {} });
      expect((await stream[Symbol.asyncIterator]().next()).done).toBe(true);
    }
    expect(starts).toEqual([true, false, true]);
    expect(conversations[1]).toBe(conversations[0]);
    expect(conversations[2]).not.toBe(conversations[0]);
  });
  it("keeps direct-run account scope alive for streamed throttle accounting", async () => {
    const model = new ModelSession({ useAgent: false, getToken: async () => token });
    const pending = model.run("hello", "gpt-5.6", undefined, false);
    await Promise.resolve();
    const ws = wire.sockets[0]; frame(ws, {}); const stream = await pending;
    frame(ws, { type: 2, item: { result: { value: "Throttled" } } });
    await stream[Symbol.asyncIterator]().next();
    const before = wire.sockets.length;
    await expect(model.run("again", "gpt-5.6", undefined, false)).rejects.toMatchObject({ code: "account_throttle_hold" });
    expect(wire.sockets).toHaveLength(before);
  });
  it("rejects when silent before handshake", async () => {
    vi.useFakeTimers(); process.env.M365_TURN_IDLE_MS = "100";
    const p = new CopilotSession().chat(token, "hello");
    const rejected = expect(p).rejects.toThrow(/No response/);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
  });
  it("surfaces post-handshake silence to the stream", async () => {
    vi.useFakeTimers(); process.env.M365_TURN_IDLE_MS = "100";
    const p = new CopilotSession().chat(token, "hello");
    await Promise.resolve();
    frame(wire.sockets[0], {});
    const stream = await p;
    const rejected = expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(/No response/);
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
  });
  it("resets the idle deadline on activity and cleans up on success", async () => {
    vi.useFakeTimers(); process.env.M365_TURN_IDLE_MS = "100";
    const p = new CopilotSession().chat(token, "hello");
    await Promise.resolve();
    const ws = wire.sockets[0];
    await vi.advanceTimersByTimeAsync(75);
    frame(ws, {});
    const stream = await p;
    await vi.advanceTimersByTimeAsync(75);
    frame(ws, { type: 6 });
    await vi.advanceTimersByTimeAsync(75);
    frame(ws, { type: 2, item: {} });
    expect(await stream[Symbol.asyncIterator]().next()).toEqual({ value: undefined, done: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cleans up after a socket error", async () => {
    vi.useFakeTimers(); process.env.M365_TURN_IDLE_MS = "100";
    const p = new CopilotSession().chat(token, "hello");
    await Promise.resolve();
    const ws = wire.sockets[0]; frame(ws, {});
    const stream = await p;
    ws.emit("error", new Error("test failure"));
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow("test failure");
    await vi.advanceTimersByTimeAsync(500);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("aborting after handshake sends stop and clears timers on acknowledgement", async () => {
    vi.useFakeTimers(); process.env.M365_TURN_IDLE_MS = "100";
    const controller = new AbortController();
    const p = new CopilotSession().chat(token, "hello", undefined, controller.signal);
    await Promise.resolve();
    const ws = wire.sockets[0]; frame(ws, {});
    const stream = await p;
    controller.abort();
    expect(ws.sent.some((s: string) => s.includes('"stop"'))).toBe(true);
    frame(ws, { type: 3 });
    expect((await stream[Symbol.asyncIterator]().next()).done).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("aborting before handshake settles without a late timeout", async () => {
    vi.useFakeTimers(); process.env.M365_TURN_IDLE_MS = "100";
    const controller = new AbortController();
    const p = new CopilotSession().chat(token, "hello", undefined, controller.signal);
    const rejected = expect(p).rejects.toThrow(/closed before handshake/);
    await Promise.resolve();
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(3000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["-1", "Infinity", "2147483648", "junk", "0"])("falls back for idle value %s", async (value) => {
    vi.useFakeTimers(); process.env.M365_TURN_IDLE_MS = value;
    const p = new CopilotSession().chat(token, "hello");
    const rejected = expect(p).rejects.toThrow(/No response/);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(wire.sockets[0].readyState).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });
});

describe("native account custody at every public chat boundary", () => {
  it("waits for native account refill without double debit and cancels a waiting chat", async () => {
    vi.useFakeTimers();
    const {withAccountContext,admitAccountAttempt} = await import("./account-policy.js");
    const {DatabaseSync} = await import("node:sqlite");
    Object.assign(process.env,{M365_AVOID_THROTTLING:"1",M365_BUDGET_CAPACITY:"1",M365_BUDGET_REFILL:"60",M365_BUDGET_RESERVE:"0",M365_BUDGET_MAX_WAIT_MIN:"1"});
    try {
      await withAccountContext({getToken:async()=>token},async()=>admitAccountAttempt(true));
      const pending=new CopilotSession().chat(token,"wait"); await Promise.resolve();
      expect(wire.sockets).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1000);
      const ws=wire.sockets[0]; frame(ws,{}); const stream=await pending;
      frame(ws,{type:2,item:{}}); await stream[Symbol.asyncIterator]().next();
      const controller=new AbortController(); const waiting=new CopilotSession().chat(token,"cancel",undefined,controller.signal);
      const rejection=expect(waiting).rejects.toMatchObject({name:"AbortError"}); await Promise.resolve(); controller.abort(); await rejection;
      const db=new DatabaseSync(process.env.M365_ACCOUNT_POLICY_PATH!); expect(db.prepare("SELECT count(*) AS n FROM attempts").get()?.n).toBe(2); db.close();
      expect(wire.sockets).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
    } finally { for(const name of ["M365_AVOID_THROTTLING","M365_BUDGET_CAPACITY","M365_BUDGET_REFILL","M365_BUDGET_RESERVE","M365_BUDGET_MAX_WAIT_MIN"]) delete process.env[name]; }
  });

  it("journals direct and scoped chats once and refuses mismatched principals and exhausted attempts", async () => {
    const { withAccountContext } = await import("./account-policy.js");
    const { DatabaseSync } = await import("node:sqlite");
    const session = new CopilotSession();
    const p = session.chat(token, "direct"); await Promise.resolve();
    frame(wire.sockets[0], {}); const direct = await p;
    frame(wire.sockets[0], { type: 2, item: {} }); await direct[Symbol.asyncIterator]().next();
    process.env.M365_REQUEST_MAX_ATTEMPTS = "1";
    try {
      await withAccountContext({getToken: async () => token}, async () => {
        const pending = session.chat(token, "scoped"); frame(wire.sockets[1], {});
        const stream = await pending; frame(wire.sockets[1], {type:2,item:{}}); await stream[Symbol.asyncIterator]().next();
        await expect(session.chat(token, "over limit")).rejects.toMatchObject({code:"request_attempt_limit"});
        const other = `x.${Buffer.from(JSON.stringify({tid:"33333333-3333-3333-3333-333333333333",oid:"11111111-1111-1111-1111-111111111111"})).toString("base64url")}.x`;
        await expect(session.chat(other, "wrong account")).rejects.toMatchObject({code:"account_changed"});
      });
    } finally { delete process.env.M365_REQUEST_MAX_ATTEMPTS; }
    expect(wire.sockets).toHaveLength(2);
    const db = new DatabaseSync(process.env.M365_ACCOUNT_POLICY_PATH!);
    expect(db.prepare("SELECT count(*) AS n FROM attempts").get()?.n).toBe(2); db.close();
  });
  it("always enforces persisted throttle hold on direct chat with avoidance off", async () => {
    const { withAccountContext, noteAccountThrottle } = await import("./account-policy.js");
    await withAccountContext({getToken:async()=>token}, async()=>noteAccountThrottle());
    await expect(new CopilotSession().chat(token,"held")).rejects.toMatchObject({code:"account_throttle_hold"});
    expect(wire.sockets).toHaveLength(0);
  });
  it.each(["leases", "accounts"])("settles a genuine ModelSession stream and disposes timers after %s storage failure", async table => {
    vi.useFakeTimers(); wire.asyncClose = true;
    const { DatabaseSync } = await import("node:sqlite");
    const controller = new AbortController(); const remove = vi.spyOn(controller.signal,"removeEventListener");
    const model = new ModelSession({useAgent:false,getToken:async()=>token});
    const pending = model.run("native",undefined,controller.signal,false); await Promise.resolve();
    const ws = wire.sockets[0]; frame(ws,{}); const stream = await pending;
    const iterator = stream[Symbol.asyncIterator](); const result = iterator.next();
    const rejection = expect(result).rejects.toMatchObject({code:"account_policy_unavailable"});
    const db = new DatabaseSync(process.env.M365_ACCOUNT_POLICY_PATH!); db.exec(`DROP TABLE ${table}`); db.close();
    expect(() => frame(ws,{type:2,item:{result:{value:table === "accounts" ? "Throttled" : "Success"}}})).not.toThrow();
    await rejection;
    expect(ws.readyState).not.toBe(1); expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort",expect.any(Function));
    expect(() => {ws.emit("close");ws.emit("error",new Error("late"));}).not.toThrow();
    await expect(iterator.next()).rejects.toMatchObject({code:"account_policy_unavailable"});
  });
  it("renews the actual active stream lease across its original expiry and fences stolen generations", async () => {
    vi.useFakeTimers(); process.env.M365_TURN_IDLE_MS = "60000";
    const {withAccountContext, leaseAccountRoute, noteAccountRoute, accountRouteDimension} = await import("./account-policy.js");
    const {DatabaseSync} = await import("node:sqlite");
    const tone = "Gpt_6_Sol_Reasoning"; let dimension = "";
    const stream = await withAccountContext({getToken:async()=>token}, async()=>{
      leaseAccountRoute(tone); dimension = accountRouteDimension(tone);
      const pending = new CopilotSession().chat(token,"long"); frame(wire.sockets[0],{}); return pending;
    });
    const ws = wire.sockets[0];
    for(let i=0;i<5;i++){ await vi.advanceTimersByTimeAsync(29000); frame(ws,{type:6}); }
    await expect(withAccountContext({getToken:async()=>token},async()=>leaseAccountRoute(tone))).rejects.toMatchObject({code:"route_probe_busy"});
    const db = new DatabaseSync(process.env.M365_ACCOUNT_POLICY_PATH!);
    db.prepare("UPDATE leases SET owner=? WHERE dimension=?").run("99999999-9999-9999-9999-999999999999",dimension); db.close();
    const failure = expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({code:"account_policy_unavailable"});
    expect(()=>frame(ws,{type:6})).not.toThrow(); await failure;
    expect(ws.readyState).toBe(3); expect(vi.getTimerCount()).toBe(0);
  });
});
