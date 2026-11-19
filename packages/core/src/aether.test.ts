import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherSession, containerConfig, resetRuntimeEndpoint, runtimeFailure, sseEvents, textItems } from "./aether.js";

const RUNTIME = "https://runtime.test";
const token = `h.${Buffer.from(JSON.stringify({ tid: "t1", oid: "o1" })).toString("base64url")}.s`;

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
}

/** A scripted runtime: each subscribe answers with the next stream, built from the posted message's ID. */
function fakeRuntime(streams: Array<(mid: string) => string[]>) {
  const calls: Call[] = [];
  let mid = "";
  const fetchImpl = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const call: Call = { url, method: init.method ?? "GET", headers, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (url.endsWith("/v1/routing")) return Response.json({ endpoint: RUNTIME, geo: "unitedstates" });
    if (url === `${RUNTIME}/v1/prewarm`) return Response.json({ status: "accepted" });
    if (call.method === "DELETE" && url.startsWith(`${RUNTIME}/v1/conversations/`)) return new Response(null, { status: 204 });
    if (url === `${RUNTIME}/v1/messages`) {
      mid = call.body.messageId;
      return Response.json({ id: "100-2", messageId: mid, streamId: "s1", status: "accepted" }, { status: 202 });
    }
    if (url === `${RUNTIME}/v1/subscribe`) {
      const chunks = (streams.shift() ?? (() => []))(mid);
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          for (const c of chunks) controller.enqueue(encoder.encode(c));
          controller.close();
        },
      }), { headers: { "content-type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  });
  return { calls, fetchImpl };
}

let seq = 0;
const ev = (event: string, data: unknown, id = `seq:${++seq}`) => `id: ${id}\r\nevent: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`;

/** One run: text from an earlier run first (not this one's), then this run's deltas, cost and end. */
const answered = (deltas: string[], end: Record<string, unknown> = { st: "ok", tc: 0 }) => (mid: string) => [
  `event: session\ndata: {"sid":"x"}\n\n`,
  ev("q", { mid }),
  ev("dx", { t: "an earlier run's tail" }),
  ev("rl", { st: "started", mid }),
  ...deltas.map((t) => ev("dx", { t })),
  ev("cq", { d: 0.25, r: mid, m: "gpt-6.2-sol" }),
  ev("cq", { d: 9, r: "someone-else" }),
  ev("fr", { stop: "end_turn", mid: `${mid}:2:abc`, content: deltas.join("") }),
  ev("uv", { type: "session_stop", id: `${mid}:3:def` }),
  ev("rl", { ...end, mid }),
];

async function drain(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of stream) out.push(d);
  return out;
}

beforeEach(() => {
  seq = 0;
  resetRuntimeEndpoint();
});
afterEach(() => vi.unstubAllGlobals());

describe("AetherSession", () => {
  it("streams a Cowork run's text, with its credits, and nothing from an earlier run", async () => {
    const { calls, fetchImpl } = fakeRuntime([answered(["Hel", "lo"])]);
    vi.stubGlobal("fetch", fetchImpl);
    const session = new AetherSession({ mode: "cowork", getToken: async () => token });
    const stream = await session.run("hi", "gpt-6.2-sol");
    expect(await drain(stream)).toEqual(["Hel", "lo"]);
    expect(stream.fullText).toBe("Hello");
    expect(stream.credits).toBe(0.25);
    expect(stream.result).toEqual({ value: "Success" });
    expect(session.turnCount).toBe(1);

    const message = calls.find((c) => c.url.endsWith("/v1/messages"))!;
    expect(message.body).toMatchObject({ content: [{ text: "hi", type: "text" }], conversationId: `t1:o1:${session.conversationId}`, queue: true, role: "user" });
    expect(message.headers["x-container-config"]).toBe("renderUi=true;durableArtifactsEnabled=true;acceptLanguage=en-us;model=gpt-6.2-sol:copilot");
    expect(message.headers["x-container-type"]).toBeUndefined();
    // The stream is read from the message on, so only this turn comes back.
    expect(calls.find((c) => c.url.endsWith("/v1/subscribe"))!.headers["last-event-id"]).toBe("100-2");
  });

  it("opens Code sessions with its container, the runtime's model ID and the request's effort, prewarming each conversation once", async () => {
    const { calls, fetchImpl } = fakeRuntime([answered(["a"]), answered(["b"]), answered(["c"])]);
    vi.stubGlobal("fetch", fetchImpl);
    const session = new AetherSession({ mode: "code", getToken: async () => token });
    await drain(await session.run("one", "claude-opus-5.5", undefined, true, [], undefined, { reasoningEffort: "high" }));
    await drain(await session.run("two", "claude-opus-5.5"));
    session.newConversation();
    await drain(await session.run("three", "claude-opus-5.5"));

    const messages = calls.filter((c) => c.url.endsWith("/v1/messages"));
    expect(messages[0].headers["x-container-type"]).toBe("copilot");
    expect(messages[0].headers["x-container-config"]).toBe("appGenerationEnabled=true;appGenerationConnectorsEnabled=true;model=opus-5.5;reasoningEffort=high");
    expect(messages[1].headers["x-container-config"]).toMatch(/reasoningEffort=medium$/);
    expect(messages[0].body.conversationId).toMatch(/^code-[0-9a-f-]{36}$/);
    expect(messages[1].body.conversationId).toBe(messages[0].body.conversationId);
    expect(messages[2].body.conversationId).not.toBe(messages[0].body.conversationId);
    expect(calls.filter((c) => c.url.endsWith("/v1/prewarm"))).toHaveLength(2);
  });

  it("reads a long prompt's refusal as too long, and any other failure as a failed turn", async () => {
    const refusal = { st: "fail", code: "engine.v2_refusal", err: "This request couldn't be completed." };
    const { fetchImpl } = fakeRuntime([answered([], refusal), answered([], refusal)]);
    vi.stubGlobal("fetch", fetchImpl);
    const session = new AetherSession({ mode: "cowork", getToken: async () => token });
    const long = await session.run("x".repeat(500_000));
    await drain(long);
    expect(long.result).toMatchObject({ value: "InvalidRequest", errorCode: "InputTokenLimitExceeded" });
    const short = await session.run("hi");
    await drain(short);
    expect(short.result).toMatchObject({ value: "InternalError", errorCode: "engine.v2_refusal" });
    expect(short.turnState).toBe("Failed");
  });

  it("counts the run's charge when it lands just after the run ends, not only the title's", async () => {
    const { fetchImpl } = fakeRuntime([(mid) => [
      ev("rl", { st: "started", mid }),
      ev("cq", { d: 0.01, r: mid, t: mid, m: "claude-haiku-5-5" }), // the title, under the message's ID
      ev("dx", { t: "1, 2, 3" }),
      ev("rl", { st: "ok", mid }),
      ev("cq", { d: 2.5, r: mid, t: "run-1", m: "claude-sonnet-5-5" }),
      ev("cq", { d: 0.004, r: mid, t: "run-1", m: "claude-haiku-5-5" }), // a later follow-up suggestion: not waited for
    ]]);
    vi.stubGlobal("fetch", fetchImpl);
    const session = new AetherSession({ mode: "code", getToken: async () => token });
    const stream = await session.run("Count to 3.", "claude-sonnet-5.5");
    expect(await drain(stream)).toEqual(["1, 2, 3"]);
    expect(stream.credits).toBe(2.51);
  });

  it("deletes a conversation it leaves, unless M365_SAVE_HISTORY=1", async () => {
    const { calls, fetchImpl } = fakeRuntime([answered(["a"]), answered(["b"])]);
    vi.stubGlobal("fetch", fetchImpl);
    const session = new AetherSession({ mode: "code", getToken: async () => token });
    session.newConversation(); // never used: nothing to delete
    await drain(await session.run("one"));
    const first = session.conversationId;
    session.newConversation();
    await vi.waitFor(() => expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([`${RUNTIME}/v1/conversations/${first}`]));
    expect(calls.find((c) => c.method === "DELETE")!.headers["x-container-type"]).toBe("copilot");
    process.env.M365_SAVE_HISTORY = "1";
    try {
      await drain(await session.run("two"));
      session.close();
      await new Promise((r) => setTimeout(r, 20));
      expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
    } finally {
      delete process.env.M365_SAVE_HISTORY;
    }
  });

  it("subscribes again when the stream ends before the run, without repeating what it read", async () => {
    const full = answered(["Hel", "lo"]);
    let first: string[] = [];
    const { calls, fetchImpl } = fakeRuntime([
      (mid) => (first = full(mid)).slice(0, 5), // closes after "Hel"
      () => first, // the replay from the message: every event again, same numbers
    ]);
    vi.stubGlobal("fetch", fetchImpl);
    const session = new AetherSession({ mode: "cowork", getToken: async () => token });
    const stream = await session.run("hi");
    expect(await drain(stream)).toEqual(["Hel", "lo"]);
    expect(stream.result).toEqual({ value: "Success" });
    const subscribes = calls.filter((c) => c.url.endsWith("/v1/subscribe"));
    expect(subscribes.map((c) => c.headers["last-event-id"])).toEqual(["100-2", "100-2"]);
  });
});

describe("agent runtime helpers", () => {
  it("parses server-sent events split anywhere, CRLF or LF, skipping keep-alives", async () => {
    const raw = ": keep-alive\r\n\r\nid: seq:1\r\nevent: dx\r\ndata: {\"t\":\"a\"}\r\n\r\nevent: fr\ndata: line1\ndata: line2\n\n";
    const chunks = [raw.slice(0, 7), raw.slice(7, 40), raw.slice(40, 41), raw.slice(41)].map((s) => new TextEncoder().encode(s));
    async function* body() { yield* chunks; }
    const events = [];
    for await (const e of sseEvents(body())) events.push(e);
    expect(events).toEqual([
      { id: "seq:1", event: "dx", data: "{\"t\":\"a\"}" },
      { id: null, event: "fr", data: "line1\nline2" },
    ]);
  });

  it("cuts text into the runtime's 1M-character items", () => {
    expect(textItems("").map((i) => i.text)).toEqual([""]);
    expect(textItems("y".repeat(2_000_000)).map((i) => i.text.length)).toEqual([999_000, 999_000, 2_000]);
  });

  it("maps failures and builds container configs", () => {
    expect(runtimeFailure(undefined, undefined, 10)).toEqual({ value: "InternalError", errorCode: "agent_runtime_failure", message: undefined });
    expect(containerConfig("cowork", "sonnet-5.5", "max")).toBe("renderUi=true;durableArtifactsEnabled=true;acceptLanguage=en-us;model=sonnet-5.5:copilot;reasoningEffort=max");
  });
});
