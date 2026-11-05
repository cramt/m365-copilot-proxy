import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnBudgetHold } from "./turn-budget.js";
import { withAccountContext, AccountPolicyError, admitAccountAttempt } from "./account-policy.js";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
const principalA = "11111111-1111-1111-1111-111111111111", principalB = "22222222-2222-2222-2222-222222222222";
const jwt = (label: string, oid = principalA) => `e30.${Buffer.from(JSON.stringify({ tid: principalA, oid, label })).toString("base64url")}.sig`;
const labelOf = (token: string) => { try { return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).label; } catch { return token; } };
process.env.M365_ACCOUNT_POLICY_PATH = join(mkdtempSync(join(tmpdir(), "model-policy-")), "state.sqlite");

// ModelSession.run's reconnect: when the first chat() fails it sends the turn
// again on a fresh CopilotSession, and that turn waits on the budget like any
// other (#77). The CopilotSession is faked: each chat() is one upstream turn.
const wire = vi.hoisted(() => ({ events: [] as string[], failures: 0, error: "WebSocket error: connection failed", counts: [] as number[], agent: "agent-a", resolutions: 0 }));
vi.mock("./agent.js", () => ({ getOrCreateAgent: async () => { wire.resolutions++; return wire.agent; } }));

vi.mock("./session.js", () => ({
  CopilotSession: class {
    turnCount: number;
    constructor(options: { turnCount?: number }) { this.turnCount = options.turnCount ?? 0; }
    chat(token: string) {
      admitAccountAttempt(this.turnCount === 0);
      wire.counts.push(this.turnCount++);
      wire.events.push(`chat:${labelOf(token)}`);
      if (wire.failures > 0) {
        wire.failures--;
        return Promise.reject(wire.error === "local" ? new AccountPolicyError(429, "account_turn_budget") : wire.error === "syntax" ? Object.assign(new Error("Invalid protocol input"), {name:"ZodError"}) : new Error(wire.error));
      }
      return Promise.resolve({ fullText: "ok" });
    }
  },
}));

const { ModelSession } = await import("./model.js");

function session() {
  let n = 0;
  return new ModelSession({ useAgent: false, getToken: async () => jwt(`tok${++n}`) });
}

afterEach(() => {
  wire.events = [];
  wire.failures = 0;
  wire.error = "WebSocket error: connection failed";
  wire.counts = [];
  wire.agent = "agent-a";
  wire.resolutions = 0;
  delete process.env.M365_RECONNECT_DELAY_MS;
  vi.useRealTimers();
});

describe("ModelSession.run's reconnect", () => {
  it("reconsults the bounded shared agent cache on every next turn, including a prior null", async () => {
    const model = new ModelSession({getToken:async()=>jwt("agent")});
    wire.agent = ""; await model.run("one");
    wire.agent = "new-agent"; await model.run("two");
    expect(wire.resolutions).toBe(2);
    expect(wire.events).toEqual(["chat:agent","chat:agent"]);
  });
  it("waits on the turn budget before it sends the turn again, with a fresh token after a wait", async () => {
    wire.failures = 1;
    const waitForBudget = async () => { wire.events.push("wait"); return { waitedMs: 30_000 }; };
    await session().run("hi", "claude-sonnet", undefined, false, [], waitForBudget);
    expect(wire.events).toEqual(["chat:tok1", "wait", "chat:tok2"]);
  });

  it("keeps the token when the budget let it through at once", async () => {
    wire.failures = 1;
    const waitForBudget = async () => { wire.events.push("wait"); return { waitedMs: 0 }; };
    await session().run("hi", "claude-sonnet", undefined, false, [], waitForBudget);
    expect(wire.events).toEqual(["chat:tok1", "wait", "chat:tok1"]);
  });

  it("doesn't send it when the budget refuses the turn", async () => {
    wire.failures = 1;
    const hold = new TurnBudgetHold("refill", 5 * 60_000, null);
    const waitForBudget = async () => { throw hold; };
    await expect(session().run("hi", "claude-sonnet", undefined, false, [], waitForBudget)).rejects.toBe(hold);
    expect(wire.events).toEqual(["chat:tok1"]);
  });

  it("doesn't wait again when the first turn goes through", async () => {
    const waitForBudget = vi.fn(async () => ({ waitedMs: 0 }));
    await session().run("hi", "claude-sonnet", undefined, false, [], waitForBudget);
    expect(waitForBudget).not.toHaveBeenCalled();
    expect(wire.events).toEqual(["chat:tok1"]);
  });

  it("waits with awaitTurnBudget by default (a no-op unless M365_AVOID_THROTTLING is set)", async () => {
    const saved = process.env.M365_AVOID_THROTTLING;
    delete process.env.M365_AVOID_THROTTLING;
    try {
      wire.failures = 1;
      await session().run("hi", "claude-sonnet", undefined, false);
      expect(wire.events).toEqual(["chat:tok1", "chat:tok1"]);
    } finally {
      if (saved !== undefined) process.env.M365_AVOID_THROTTLING = saved;
    }
  });
});

describe("conversation recovery continuity", () => {
  it("preserves attempted turns across reconnect, agent switches, refresh and reset; new conversation starts over", async () => {
    const s = new ModelSession({ getToken: async () => jwt("token") });
    wire.failures = 1;
    await s.run("first", "m365-copilot", undefined, true, [], async () => ({ waitedMs: 0 }));
    await s.run("second", "m365-copilot", undefined, false);
    await s.run("third", "m365-copilot", undefined, true);
    wire.agent = "agent-b";
    expect(await s.refreshAgent()).toBe(true);
    await s.run("fourth");
    s.reset();
    await s.run("fifth");
    s.newConversation();
    await s.run("new");
    expect(wire.counts).toEqual([0, 1, 2, 3, 4, 5, 0]);
  });
  it.each([[undefined, 5000], ["20", 20], ["0", 0], ["-1", 5000], ["Infinity", 5000], ["2147483648", 5000], ["bad", 5000]] as const)("network delay %s uses %i ms", async (configured, delay) => {
    vi.useFakeTimers();
    if (configured !== undefined) process.env.M365_RECONNECT_DELAY_MS = configured;
    wire.failures = 1; wire.error = "ECONNRESET";
    const p = session().run("hi", "m365-copilot", undefined, false, [], async () => ({ waitedMs: 0 }));
    await vi.advanceTimersByTimeAsync(0);
    if (delay) {
      expect(wire.events).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(wire.events).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
    }
    await p;
    expect(wire.events).toHaveLength(2);
  });
  it("abort during the network delay prevents budget admission and resend", async () => {
    vi.useFakeTimers(); wire.failures = 1; wire.error = "EAI_AGAIN";
    const controller = new AbortController();
    const budget = vi.fn(async () => ({ waitedMs: 0 }));
    const p = session().run("hi", "m365-copilot", controller.signal, false, [], budget);
    const rejected = expect(p).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    await vi.advanceTimersByTimeAsync(6000);
    expect(wire.events).toHaveLength(1);
    expect(budget).not.toHaveBeenCalled();
  });
});

describe("credential policy ownership", () => {
  it("rejects malformed credentials before chat without reconnect", async () => {
    const s = new ModelSession({ useAgent: false, getToken: async () => "bad" });
    await expect(s.run("hi")).rejects.toMatchObject({ code: "invalid_account_principal" });
    expect(wire.events).toEqual([]);
  });
  it("bounds reconnect plus subsequent hidden retries across one request", async () => {
    const options = { useAgent: false, getToken: async () => jwt("token") };
    const s = new ModelSession(options); wire.failures = 1;
    await withAccountContext(options, async () => {});
    const db = new DatabaseSync(process.env.M365_ACCOUNT_POLICY_PATH!);
    const before = (db.prepare("SELECT count(*) AS n FROM attempts").get() as {n:number} | undefined)?.n ?? 0;
    await withAccountContext(options, async () => {
      await s.run("hi"); await s.run("again");
      await expect(s.run("hidden retry")).rejects.toMatchObject({ code: "request_attempt_limit" });
    });
    expect(wire.events).toHaveLength(3);
    expect((db.prepare("SELECT count(*) AS n FROM attempts").get() as {n:number}).n - before).toBe(3);
    db.close();
  });
  it("does not reconnect a local policy refusal returned by chat", async () => {
    wire.failures = 1; wire.error = "local";
    const options = { useAgent: false, getToken: async () => jwt("token") };
    await expect(new ModelSession(options).run("hi")).rejects.toMatchObject({ code: "account_turn_budget" });
    expect(wire.events).toHaveLength(1);
  });
  it("does not reconnect deterministic protocol validation failures", async () => {
    wire.failures = 1; wire.error = "syntax";
    await expect(session().run("hi")).rejects.toMatchObject({name:"ZodError"});
    expect(wire.events).toHaveLength(1);
  });
  it("refuses cross-account continuation before sending any old delta", async () => {
    let oid = principalA; const options = { useAgent: false, getToken: async () => jwt("token", oid) };
    const s = new ModelSession(options); await s.run("first"); oid = principalB;
    await expect(s.run("old delta")).rejects.toMatchObject({ code: "account_changed" });
    expect(wire.events).toHaveLength(1);
    await new ModelSession(options).run("full replay"); expect(wire.events).toHaveLength(2);
  });
  it("rejects cross-account refreshAgent before provisioning a legacy agent", async () => {
    let oid = principalA; const s = new ModelSession({ getToken: async () => jwt("token", oid) });
    await s.run("first"); oid = principalB; wire.agent = "foreign-agent";
    await expect(s.refreshAgent()).rejects.toMatchObject({ code: "account_changed" });
  });
  it("refuses a refreshed token switching principal inside the same request", async () => {
    let n = 0; const s = new ModelSession({ useAgent: false, getToken: async () => jwt("token", ++n === 1 ? principalA : principalB) });
    wire.failures = 1;
    await expect(s.run("hi", "m365-copilot", undefined, false, [], async () => ({ waitedMs: 1 }))).rejects.toMatchObject({ code: "account_changed" });
    expect(wire.events).toHaveLength(1);
  });
});
