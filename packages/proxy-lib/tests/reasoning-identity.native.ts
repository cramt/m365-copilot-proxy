import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { wire } from "./native-test-transport.js";
import { SessionPool, handleChatCompletion } from "../src/handler.js";
import { ChatCompletionRequest } from "../src/schemas.js";
import { resetPriorityAccessState, ModelSession, LOG_PATH } from "@m365-copilot/core";
import { existsSync, readFileSync } from "node:fs";

vi.mock("../../core/src/image-input.js", () => ({ uploadImage: async () => { setupEvents.push("upload"); return {}; } }));
vi.mock("../../core/src/agent.js", () => ({ getOrCreateAgent: async () => { setupEvents.push("agent"); return null; } }));
const setupEvents: string[] = [];

vi.mock("@m365-copilot/core", async (original) => {
  const actual = await original<typeof import("@m365-copilot/core")>();
  return { ...actual, awaitTurnBudget: async () => ({ waitedMs: 1 }) };
});

const T = "11111111-1111-1111-1111-111111111111";
const A = "22222222-2222-2222-2222-222222222222";
const B = "33333333-3333-3333-3333-333333333333";
const token = (oid: string) => `e30.${Buffer.from(JSON.stringify({ tid: T, oid, aud: "synthetic", iss: "synthetic", exp: 9999999999 })).toString("base64url")}.sig`;
const cap = { value: "OutOfCredits", errorCode: "ReasoningTurnExhausted", message: "Reasoning exhausted" };
const pool = (oid: string) => new SessionPool({ useAgent: false, getToken: async () => token(oid) });
async function ask(p: SessionPool, model: string, stream: boolean, text = "hello") {
  const res = await handleChatCompletion(ChatCompletionRequest.parse({ model, stream, messages: [{ role: "user", content: text }] }), p);
  const raw = await res.text();
  return { status: res.status, raw, retryAfter: res.headers.get("retry-after") };
}
beforeEach(async () => {
  setupEvents.length = 0;
  resetPriorityAccessState();
  try { (await import("../src/refusal-suggestions.js")).resetRefusalState(); } catch { /* base has no feature */ }
  wire.sockets = []; wire.texts = []; wire.result = undefined; wire.answer = "visible answer";
  wire.hold = false; wire.replies = []; wire.onChat = undefined; wire.failFirst = false;
  process.env.M365_NO_CONFAB_RETRY = "1";
});
afterEach(() => { vi.useRealTimers(); });
it("cached wall runs image and agent setup before refusing dispatch", async () => {
  wire.result = cap;
  await ask(pool(A), "gpt-5.5-think-deeper", false);
  const sockets = wire.sockets.length;
  wire.result = undefined;
  const old = process.env.M365_FORCE_AGENT;
  process.env.M365_FORCE_AGENT = "1";
  try {
    const request = ChatCompletionRequest.parse({
      model: "gpt-5.6-think-deeper", stream: false,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }, { type: "image_url", image_url: { url: "data:image/png;base64,aA==" } }] }],
      tools: [{ type: "function", function: { name: "shell", parameters: { type: "object", properties: {} } } }],
    });
    const response = await handleChatCompletion(request, new SessionPool({ getToken: async () => token(A) }));
    expect(await response.text()).toContain("reasoning_turns_exhausted");
    expect(setupEvents).toEqual(["upload", "agent"]);
    expect(wire.sockets.length).toBe(sockets);
  } finally { if (old === undefined) delete process.env.M365_FORCE_AGENT; else process.env.M365_FORCE_AGENT = old; }
});

it("reasoning wall expires at estimated UTC boundary", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-21T23:59:59Z"));
  const a = pool(A);
  wire.result = cap;
  expect((await ask(a, "gpt-5.5-think-deeper", false)).raw).toContain("2026-11-22T00:00:00.000Z");
  wire.result = undefined;
  const count = wire.texts.length;
  expect((await ask(a, "gpt-5.6-think-deeper", false)).raw).toContain("reasoning_turns_exhausted");
  expect(wire.texts.length).toBe(count);
  vi.setSystemTime(new Date("2026-11-22T00:00:00Z"));
  expect((await ask(a, "gpt-5.6-think-deeper", false)).raw).toContain("visible answer");
  expect(wire.texts.length).toBe(count + 1);
});

it("concurrent different outcomes cannot poison another principal", async () => {
  let next = B;
  const shared = new SessionPool({ useAgent: false, getToken: async () => token(next) });
  wire.hold = true;
  const first = ask(shared, "gpt-5.5-think-deeper", false, "same opener");
  while (wire.replies.length < 1) await new Promise(resolve => setTimeout(resolve, 1));
  next = A;
  const second = ask(shared, "gpt-5.5-think-deeper", false, "same opener");
  while (wire.replies.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  expect(wire.sockets).toHaveLength(2);
  expect(new URL(wire.sockets[0]!.url).searchParams.get("access_token")).toBe(token(B));
  expect(new URL(wire.sockets[1]!.url).searchParams.get("access_token")).toBe(token(A));
  wire.result = undefined; wire.replies[1]!();
  wire.result = cap; wire.replies[0]!();
  await Promise.all([first, second]);
  wire.hold = false; wire.result = undefined;
  expect((await ask(pool(A), "gpt-5.6-think-deeper", false)).raw).toContain("visible answer");
  expect((await ask(pool(B), "gpt-5.6-think-deeper", false)).raw).toContain("reasoning_turns_exhausted");
});

it("concurrent requests sharing a session keep dispatch observations on their own principal", async () => {
  let next = B;
  const shared = new SessionPool({ useAgent: false, getToken: async () => token(next) });
  wire.hold = true; wire.result = cap;
  const first = ask(shared, "gpt-5.5-think-deeper", false, "same opener");
  while (wire.replies.length < 1) await new Promise(resolve => setTimeout(resolve, 1));
  next = A;
  const second = ask(shared, "gpt-5.5-think-deeper", false, "same opener");
  while (wire.replies.length < 2) await new Promise(resolve => setTimeout(resolve, 1));
  wire.replies[1]!(); wire.replies[0]!();
  await Promise.all([first, second]);
  wire.hold = false; wire.result = undefined;
  const count = wire.texts.length;
  const resultA = await ask(pool(A), "gpt-5.6-think-deeper", false);
  const resultB = await ask(pool(B), "gpt-5.6-think-deeper", false);
  expect(resultA.raw).toContain("reasoning_turns_exhausted");
  expect(resultB.raw).toContain("reasoning_turns_exhausted");
  expect(wire.texts.length).toBe(count);
});

it("characterizes pool collision after provider switches account", async () => {
  let account = A;
  const shared = new SessionPool({ useAgent: false, getToken: async () => token(account) });
  await ask(shared, "gpt-5.5", false, "shared opener");
  account = B;
  const response = await handleChatCompletion(ChatCompletionRequest.parse({
    model: "gpt-5.5", stream: false,
    messages: [{ role: "user", content: "shared opener" }, { role: "assistant", content: "visible answer" }, { role: "user", content: "second turn" }],
  }), shared);
  expect(response.status).toBe(200);
  expect(wire.sockets).toHaveLength(2);
  expect(new URL(wire.sockets[0]!.url).searchParams.get("ConversationId")).toBe(new URL(wire.sockets[1]!.url).searchParams.get("ConversationId"));
});

it("characterizes native reconnect: a budget wait can replace account A with B", async () => {
  let calls = 0;
  const session = new ModelSession({ useAgent: false, getToken: async () => token(++calls === 1 ? A : B) });
  wire.failFirst = true;
  const result = await session.run("hello", "gpt-5.5", undefined, false, [], async () => ({ waitedMs: 1 }));
  for await (const _ of result) { /* consume the real stream */ }
  expect(calls).toBe(2);
  expect(wire.sockets).toHaveLength(2);
  expect(new URL(wire.sockets[0]!.url).searchParams.get("access_token")).toBe(token(A));
  expect(new URL(wire.sockets[1]!.url).searchParams.get("access_token")).toBe(token(B));
});

it("a refusal on reconnect belongs to the token actually dispatched", async () => {
  let calls = 0;
  const s = new ModelSession({ useAgent: false, getToken: async () => token(++calls === 1 ? A : B) });
  wire.failFirst = true; wire.result = cap;
  let observed: string | null = null;
  const stream = await s.run("hello", "gpt-5.5-think-deeper", undefined, false, [], async () => ({ waitedMs: 1 }), { beforeChatDispatch(scope) { observed = scope; } });
  for await (const _ of stream) {}
  let expected: string | null = null;
  const control = new ModelSession({ useAgent: false, getToken: async () => token(B) });
  const reply = await control.run("hello", "gpt-5.5", undefined, false, [], async () => ({ waitedMs: 0 }), { beforeChatDispatch(scope) { expected = scope; } });
  for await (const _ of reply) {}
  expect(observed).not.toBeNull();
  expect(observed).toBe(expected);
});

for (const stream of [false, true]) {
  it(`baseline leaks a prior same-model cooldown across token providers, stream=${stream}`, async () => {
    const a = pool(A), b = pool(B);
    wire.result = cap;
    await ask(a, "gpt-5.5-think-deeper", stream);
    wire.result = undefined;
    const count = wire.texts.length;
    const response = await ask(b, "gpt-5.5-think-deeper", stream);
    expect(response.raw).toContain("visible answer");
    expect(wire.texts.length).toBe(count + 1);
  });
  it(`reasoning cap suppresses streamed refusal content, stream=${stream}`, async () => {
    wire.answer = "raw secret refusal"; wire.result = cap;
    const response = await ask(pool(A), "gpt-5.5-think-deeper", stream);
    expect(response.raw).toContain("reasoning_turns_exhausted");
    if (!stream) expect(response.raw).not.toContain("raw secret refusal");
  });
  it(`licence facts are specific to the actual scenario, stream=${stream}`, async () => {
    const old = process.env.M365_SCENARIO;
    try {
      process.env.M365_TRANSPORT = "chathub";
      const a = pool(A);
      wire.result = { value: "ForbiddenRequest", errorCode: "PremiumModelUnavailableForLicense", message: "denied" };
      await ask(a, "gpt-5.5", stream);
      process.env.M365_TRANSPORT = "streamhub";
      process.env.M365_SCENARIO = "OfficeWebPaidCopilot";
      wire.result = cap;
      const changed = await ask(a, "gpt-5.5-think-deeper", stream);
      expect(changed.raw).toContain("reasoning_turns_exhausted");
      expect(changed.raw).toContain("gpt-5.5");
      expect(wire.sockets.at(-1)?.url).toContain("StreamHub");
    } finally {
      delete process.env.M365_TRANSPORT;
      if (old === undefined) delete process.env.M365_SCENARIO; else process.env.M365_SCENARIO = old;
    }
  });
  it(`handler reconnect attributes denial to the successful token, stream=${stream}`, async () => {
    let calls = 0;
    const swapping = new SessionPool({ useAgent: false, getToken: async () => token(++calls === 1 ? A : B) });
    wire.failFirst = true; wire.result = cap;
    const first = await ask(swapping, "gpt-5.5-think-deeper", stream);
    expect(first.raw).toContain("reasoning_turns_exhausted");
    expect(calls).toBe(2);
    wire.result = undefined;
    expect((await ask(pool(A), "gpt-5.6-think-deeper", stream)).raw).toContain("visible answer");
    const count = wire.texts.length;
    expect((await ask(pool(B), "gpt-5.6-think-deeper", stream)).raw).toContain("reasoning_turns_exhausted");
    expect(wire.texts.length).toBe(count);
  });
  it(`an active ordinary-credit wall is not suggested to that principal, stream=${stream}`, async () => {
    const a = pool(A);
    wire.result = { value: "OutOfCredits", message: "No credits" };
    await ask(a, "gpt-5.5", stream);
    wire.result = cap;
    const response = await ask(a, "gpt-5.6-think-deeper", stream);
    expect(response.raw).not.toContain("gpt-5.5, gpt-5.6");
    expect(response.raw).toContain("gpt-5.6");
  });
  it(`an unknown model licence refusal does not exclude the auto route, stream=${stream}`, async () => {
    const a = pool(A);
    wire.result = { value: "ForbiddenRequest", errorCode: "PremiumModelUnavailableForLicense", message: "denied" };
    await ask(a, "unlisted-future-model", stream);
    wire.result = cap;
    const response = await ask(a, "gpt-5.5-think-deeper", stream);
    expect(response.raw).toContain("gpt-5.5");
    expect(response.raw).toContain("gpt-5.6");
  });
  it(`a refusal in a multipart prefix is terminal, stream=${stream}`, async () => {
    const previous = process.env.M365_TURN_CHUNK_BYTES;
    try {
      process.env.M365_TURN_CHUNK_BYTES = "1000";
      wire.result = cap;
      const response = await ask(pool(A), "gpt-5.5-think-deeper", stream, "x".repeat(5000));
      expect(response.raw).toContain("reasoning_turns_exhausted");
      expect(wire.texts).toHaveLength(1);
      expect(wire.texts[0]).toContain("part");
    } finally {
      if (previous === undefined) delete process.env.M365_TURN_CHUNK_BYTES; else process.env.M365_TURN_CHUNK_BYTES = previous;
    }
  });
  it(`SSE and JSON carry the same structured candidates, stream=${stream}`, async () => {
    wire.result = cap;
    const result = await ask(pool(A), "gpt-5.5-think-deeper", stream);
    const body = stream ? result.raw.split("\n").filter(x => x.startsWith("data: {")).map(x => JSON.parse(x.slice(6))).find(x => x.error)?.error : JSON.parse(result.raw).error;
    expect(body.suggested_models).toEqual(["gpt-5.5", "gpt-5.6"]);
  });
  it(`ordinary priority refusal suggests candidates without the denied route, stream=${stream}`, async () => {
    wire.result = { value: "OutOfCredits", message: "No credits" };
    const result = await ask(pool(A), "gpt-5.5", stream);
    const body = stream ? result.raw.split("\n").filter(x => x.startsWith("data: {")).map(x => JSON.parse(x.slice(6))).find(x => x.error)?.error : JSON.parse(result.raw).error;
    expect(body.suggested_models).toEqual(["gpt-5.6"]);
  });
  it(`suggestions respect a globally preflight-walled quick route for another account, stream=${stream}`, async () => {
    wire.result = { value: "OutOfCredits", message: "No credits" };
    await ask(pool(A), "gpt-5.5", stream);
    wire.result = cap;
    const result = await ask(pool(B), "gpt-5.5-think-deeper", stream);
    const error = stream ? result.raw.split("\n").filter(x => x.startsWith("data: {")).map(x => JSON.parse(x.slice(6))).find(x => x.error)?.error : JSON.parse(result.raw).error;
    expect(error.suggested_models).toEqual(["gpt-5.6"]);
    wire.result = undefined;
    for (const candidate of error.suggested_models) {
      const count = wire.texts.length;
      const follow = await ask(pool(B), candidate, stream);
      expect(wire.texts.length).toBe(count + 1);
      expect(follow.raw).toContain("visible answer");
    }
  });
  it(`cached priority preflight offers safe candidates without new auth, stream=${stream}`, async () => {
    let calls = 0;
    const a = new SessionPool({ useAgent: false, getToken: async () => { calls++; return token(A); } });
    wire.result = { value: "OutOfCredits", message: "No credits" };
    const first = await ask(a, "gpt-5.5", stream);
    const firstBody = stream ? first.raw.split("\n").filter(x => x.startsWith("data: {")).map(x => JSON.parse(x.slice(6))).find(x => x.error)?.error : JSON.parse(first.raw).error;
    const before = calls;
    const again = await ask(a, "gpt-5.5", stream);
    expect(again.status).toBe(429);
    expect(calls).toBe(before);
    const cached = JSON.parse(again.raw).error;
    expect(cached.suggested_models).toEqual([]);
    expect(cached.message).toContain("Wait");
    expect(firstBody.suggested_models).toEqual(["gpt-5.6"]);
  });
  for (const [from, to] of [[A, B], [B, A]]) for (const known of [false, true]) {
    it(`unscoped cached priority preflight hides upstream data, known=${known}, stream=${stream}, direction=${from === A ? "A-B" : "B-A"}`, async () => {
      const secret = "SYNTHETIC_PRIVATE_CANARY";
      wire.answer = "";
      wire.result = { value: "OutOfCredits", message: known ? `You've used your available priority access to the ${secret} model for today.` : secret };
      const first = await ask(pool(from), "gpt-5.5", stream);
      expect(first.raw).toContain(secret);
      wire.result = undefined;
      const turns = wire.texts.length;
      const logBefore = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8").length : 0;
      const cached = await ask(pool(to), "gpt-5.5", stream);
      const logAfter = existsSync(LOG_PATH) ? readFileSync(LOG_PATH, "utf8").slice(logBefore) : "";
      if (process.env.M365_DEBUG) expect(logAfter).toContain("429 without contacting M365");
      expect(logAfter).not.toContain(secret);
      expect(cached.status).toBe(429);
      expect(wire.texts.length).toBe(turns);
      expect(cached.raw).not.toContain(secret);
      expect(cached.raw).toContain("priority_access_exhausted");
      expect(JSON.parse(cached.raw).error.param).toBe("day");
      expect(Number(cached.retryAfter)).toBeGreaterThan(0);
      expect(Number(cached.retryAfter)).toBeLessThanOrEqual(86400);
    });
  }
  it(`ordinary credits keep existing priority classification, stream=${stream}`, async () => {
    wire.result = { value: "OutOfCredits", errorCode: "Other", message: "No credits" };
    const response = await ask(pool(A), "gpt-5.5-think-deeper", stream);
    expect(response.raw).toContain("priority_access_exhausted");
    expect(response.raw).not.toContain("reasoning_turns_exhausted");
  });
  it(`parallel isolated pools keep refusal scopes separate, stream=${stream}`, async () => {
    wire.result = cap;
    await ask(pool(B), "gpt-5.5-think-deeper", stream);
    wire.result = undefined;
    const [a, b] = await Promise.all([ask(pool(A), "gpt-5.6-think-deeper", stream, "parallel-a"), ask(pool(B), "gpt-5.6-think-deeper", stream, "parallel-b")]);
    expect(a.raw).toContain("visible answer");
    expect(b.raw).toContain("reasoning_turns_exhausted");
  });
  it(`a token switch in one pool does not borrow the prior principal's wall, stream=${stream}`, async () => {
    let current = B;
    const shared = new SessionPool({ useAgent: false, getToken: async () => token(current) });
    wire.result = cap;
    expect((await ask(shared, "gpt-5.5-think-deeper", stream, "b-first")).raw).toContain("reasoning_turns_exhausted");
    current = A; wire.result = undefined;
    expect((await ask(shared, "gpt-5.6-think-deeper", stream, "a-middle")).raw).toContain("visible answer");
    current = B;
    const count = wire.texts.length;
    expect((await ask(shared, "gpt-5.6-think-deeper", stream, "b-last")).raw).toContain("reasoning_turns_exhausted");
    expect(wire.texts.length).toBe(count);
  });
  it(`reports wait when both quick routes are explicitly denied, stream=${stream}`, async () => {
    const a = pool(A);
    wire.result = { value: "ForbiddenRequest", errorCode: "PremiumModelUnavailableForLicense", message: "denied" };
    await ask(a, "gpt-5.5", stream); await ask(a, "gpt-5.6", stream);
    wire.result = cap;
    const refused = await ask(a, "gpt-5.5-think-deeper", stream);
    expect(refused.raw).toContain("Wait before trying again");
    expect(refused.raw).not.toContain("No other model is available");
  });
  it(`observed licence denials remove same-account aliases from suggestions, stream=${stream}`, async () => {
    const a = pool(A), b = pool(B);
    wire.result = { value: "ForbiddenRequest", errorCode: "PremiumModelUnavailableForLicense", message: "denied" };
    await ask(a, "gpt-5.5-quick", stream);
    wire.result = cap;
    const first = await ask(a, "gpt-5.5-think-deeper", stream);
    expect(first.raw).not.toContain("gpt-5.5\",\"gpt-5.6");
    expect(first.raw).toContain("gpt-5.6");
    const other = await ask(b, "gpt-5.5-think-deeper", stream);
    expect(other.raw).toContain("gpt-5.5");
  });
  it(`unscopable identity never stores a wall, stream=${stream}`, async () => {
    const invalid = pool("not-a-guid");
    wire.result = cap;
    expect((await ask(invalid, "gpt-5.5-think-deeper", stream)).raw).toContain("reasoning_turns_exhausted");
    const before = wire.texts.length;
    wire.result = undefined;
    expect((await ask(invalid, "gpt-5.6-think-deeper", stream)).raw).toContain("visible answer");
    expect(wire.texts.length).toBe(before + 1);
  });
  it(`reasoning result is distinct and account B does not inherit A's wall, stream=${stream}`, async () => {
    const a = pool(A), b = pool(B);
    wire.result = cap;
    const refused = await ask(a, "gpt-5.5-think-deeper", stream);
    expect(refused.raw).toContain("reasoning_turns_exhausted");
    wire.result = undefined;
    const served = await ask(b, "gpt-5.6-think-deeper", stream);
    expect(served.raw).toContain("visible answer");
    const count = wire.texts.length;
    const sibling = await ask(a, "gpt-5.6-think-deeper", stream);
    expect(sibling.raw).toContain("reasoning_turns_exhausted");
    expect(wire.texts.length).toBe(count);
  });
}
