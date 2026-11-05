import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { createApp } from "../src/index.js";
import { wire } from "./native-test-transport.js";
import { SessionPool, handleChatCompletion, canonicalHash } from "../src/handler.js";
import { ChatCompletionRequest } from "../src/schemas.js";
import { withAccountContext, notePriorityAccessExhausted, meteredBudgetOf } from "@m365-copilot/core";
import { AccountPolicyError, leaseAccountRoute, noteAccountThrottle } from "../../core/src/account-policy.js";

const A = "11111111-1111-1111-1111-111111111111";
const B = "22222222-2222-2222-2222-222222222222";
let oid = A;
let invalid = false;
let directory: string;
const options = { useAgent: false, getToken: async () => invalid ? "invalid" : `e30.${Buffer.from(JSON.stringify({ tid: A, oid, aud: "synthetic", iss: "synthetic", exp: 9999999999 })).toString("base64url")}.sig` };
const body = (messages: unknown[] = [{ role: "user", content: "first synthetic question" }], stream = false, model = "claude-sonnet") => ChatCompletionRequest.parse({ messages, stream, model });
beforeEach(() => {
  oid = A; invalid = false;
  directory = mkdtempSync(join(tmpdir(), "proxy-native-policy-"));
  process.env.M365_ACCOUNT_POLICY_PATH = join(directory, "policy.sqlite");
  delete process.env.M365_AVOID_THROTTLING;
  delete process.env.M365_OPUS_FALLBACK_MODEL;
  wire.sockets = []; wire.texts = []; wire.hold = false; wire.replies = []; wire.onChat = undefined;
});
afterEach(() => { for (const socket of wire.sockets) socket.close(); rmSync(directory, { recursive: true, force: true }); delete process.env.M365_ACCOUNT_POLICY_PATH; });

it("replaces account-bound physical placement and fully replays unchanged logical continuation", async () => {
  const pool = new SessionPool(options);
  const first = body();
  const response = await handleChatCompletion(first, pool, { sessionHint: "logical" });
  expect(response.status).toBe(200);
  const answer = (await response.json()).choices[0].message;
  expect(answer.content).toBe("visible answer");
  oid = B;
  const second = await handleChatCompletion(body([...first.messages, answer, { role: "user", content: "second synthetic question" }]), pool, { sessionHint: "logical" });
  expect(second.status).toBe(200);
  expect((await second.json()).choices[0].message.content).toBe("visible answer");
  expect(pool.size).toBe(1);
  expect(wire.sockets).toHaveLength(2);
  expect(wire.sockets[0].readyState).toBe(3);
  expect(wire.sockets[1].url).toContain(B);
  expect(wire.texts[1]).toContain("first synthetic question");
  expect(wire.texts[1]).toContain("visible answer");
  expect(wire.texts[1]).toContain("second synthetic question");
});

it("cleans pre-SSE quota refusals for stream:true and allows exact retries", async () => {
  await withAccountContext(options, async () => { notePriorityAccessExhausted(meteredBudgetOf("claude-opus")!, { window: "day", resetsAt: new Date(Date.now() + 60000), message: "synthetic" }); });
  const pool = new SessionPool(options);
  const request = body(undefined, true, "claude-opus");
  for (let i = 0; i < 2; i++) {
    const response = await handleChatCompletion(request, pool, { idempotencyKey: "quota-retry" });
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(pool.receipts.size).toBe(0);
  }
  expect(wire.sockets).toHaveLength(0);
});

it.each([false, true])("preserves pre-context principal refusal before headers (stream=%s)", async stream => {
  invalid = true;
  const response = await handleChatCompletion(body(undefined, stream), new SessionPool(options));
  expect(response.status).toBe(401);
  expect(response.headers.get("x-should-retry")).toBe("false");
  expect((await response.json()).error).toMatchObject({ code: "invalid_account_principal", retryable: false });
  expect(wire.sockets).toHaveLength(0);
});

it.each([false, true])("preserves actual account cooldown at ModelSession admission (stream=%s)", async stream => {
  await withAccountContext(options, async () => { noteAccountThrottle(); });
  const pool = new SessionPool(options);
  const response = await handleChatCompletion(body(undefined, stream), pool, { idempotencyKey: "hold" });
  if (!stream) {
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await response.json()).error).toMatchObject({ code: "account_throttle_hold", retryable: false });
  } else {
    expect(response.status).toBe(200);
    const text = await response.text();
    const frames = text.split("\n\n").filter(s => s.startsWith("data: {")).map(s => JSON.parse(s.slice(6)));
    expect(frames.find(f => f.error)?.error).toMatchObject({ code: "account_throttle_hold", retryable: false, status: 429 });
    expect(frames.find(f => f.error)?.error.retry_after).toBeGreaterThan(0);
    expect(text).toContain("data: [DONE]");
    expect(frames.some(f => f.usage || f.choices?.some((c: { finish_reason: unknown }) => c.finish_reason))).toBe(false);
  }
  expect(pool.receipts.size).toBe(0);
  expect(wire.sockets).toHaveLength(0);
});

it("distinguishes pending retries from conflicts then replays successful bytes once", async () => {
  wire.hold = true;
  const pool = new SessionPool(options);
  const request = body(undefined, true);
  const response = await handleChatCompletion(request, pool, { idempotencyKey: "pending" });
  const pending = await handleChatCompletion(request, pool, { idempotencyKey: "pending" });
  expect(pending.status).toBe(409);
  expect(pending.headers.get("retry-after")).toBe("1");
  expect(pending.headers.get("x-should-retry")).not.toBe("false");
  const conflict = await handleChatCompletion(body([{ role: "user", content: "different" }], true), pool, { idempotencyKey: "pending" });
  expect(conflict.status).toBe(409);
  expect(conflict.headers.get("x-should-retry")).toBe("false");
  for (let i = 0; !wire.replies.length && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(wire.replies).toHaveLength(1);
  wire.replies.shift()!();
  const text = await response.text();
  const replay = await handleChatCompletion(request, pool, { idempotencyKey: "pending" });
  expect(await replay.text()).toBe(text);
  expect(wire.texts).toHaveLength(1);
});

it.each([false, true])("preserves a real mid-stream lease loss through CopilotSession iteration (stream=%s)", async stream => {
  wire.hold = true;
  wire.onChat = () => leaseAccountRoute("integration-lease");
  const pool = new SessionPool(options);
  const pending = handleChatCompletion(body(undefined, stream), pool, { idempotencyKey: "lost-lease" });
  for (let i = 0; !wire.replies.length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(wire.replies).toHaveLength(1);
  const database = new DatabaseSync(process.env.M365_ACCOUNT_POLICY_PATH!);
  database.exec("DELETE FROM leases"); database.close();
  wire.replies.shift()!();
  const response = await pending;
  if (stream) {
    const text = await response.text();
    expect(text).toContain('"code":"account_policy_unavailable"');
    expect(text).toContain('"status":503');
    expect(text).toContain('"retryable":false');
    expect(text).not.toContain('"finish_reason":"stop"');
    expect(text).not.toContain('"usage"');
  } else {
    expect(response.status).toBe(503);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect((await response.json()).error.code).toBe("account_policy_unavailable");
  }
  expect(pool.receipts.size).toBe(0);
  expect(wire.texts).toHaveLength(1);
});

it("keeps a competing native route probe explicitly retryable before SSE creation", async () => {
  let release!: () => void;
  let ready!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const admitted = new Promise<void>(resolve => { ready = resolve; });
  const owner = withAccountContext(options, async () => { leaseAccountRoute("Gpt_6_Sol_Reasoning"); ready(); await held; });
  await admitted;
  try {
    const request = ChatCompletionRequest.parse({ model: "gpt-6-sol", stream: true, messages: body().messages, tools: [{ type: "function", function: { name: "bash", parameters: { type: "object" } } }] });
    const pool = new SessionPool(options);
    const response = await handleChatCompletion(request, pool, { idempotencyKey: "probe" });
    expect(response.status).toBe(429);
    expect(response.headers.get("x-should-retry")).toBe("true");
    expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await response.json()).error).toMatchObject({ code: "route_probe_busy", retryable: true });
    expect(pool.receipts.size).toBe(0);
    expect(wire.sockets).toHaveLength(0);
  } finally { release(); await owner; }
});

it.each([NaN, Infinity, -1, 0, 1.25])("sanitizes policy retry seconds (%s) without flattening native errors", async retry => {
  const pool = new SessionPool({ ...options, getToken: async () => { throw new AccountPolicyError(429, "request_attempt_limit", retry); } });
  const response = await handleChatCompletion(body(), pool);
  expect(response.status).toBe(429);
  expect(response.headers.get("x-should-retry")).toBe("false");
  expect(response.headers.get("retry-after")).toBe(retry === 1.25 ? "2" : null);
  expect((await response.json()).error.code).toBe("request_attempt_limit");
});

it("does not let a cancelled producer erase its replacement receipt", async () => {
  wire.hold = true;
  const pool = new SessionPool(options);
  const request = body(undefined, true);
  const first = await handleChatCompletion(request, pool, { idempotencyKey: "replacement" });
  for (let i = 0; !wire.replies.length && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
  await first.body!.cancel();
  const secondPending = handleChatCompletion(request, pool, { idempotencyKey: "replacement" });
  const second = await secondPending;
  expect(pool.receipts.size).toBe(1);
  for (let i = 0; wire.replies.length < 2 && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(wire.replies).toHaveLength(2);
  wire.replies[1]();
  const text = await second.text();
  expect(pool.receipts.size).toBe(1);
  expect(await (await handleChatCompletion(request, pool, { idempotencyKey: "replacement" })).text()).toBe(text);
});

it("cancels native streaming production without retaining pending receipt", async () => {
  wire.hold = true;
  const pool = new SessionPool(options);
  const response = await handleChatCompletion(body(undefined, true), pool, { idempotencyKey: "cancel" });
  await response.body!.cancel();
  for (let i = 0; pool.receipts.size && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(pool.receipts.size).toBe(0);
});

it("persists an unknown-model OutOfCredits opaquely across process restart without poisoning peer accounts", async () => {
  const model = "gpt-6.1-sol";
  await withAccountContext(options, async () => notePriorityAccessExhausted("opus", { window: "week", resetsAt: new Date(Date.now() + 60000), message: "known budget metadata" }));
  const before = new DatabaseSync(process.env.M365_ACCOUNT_POLICY_PATH!);
  const known = before.prepare("SELECT * FROM facts WHERE dimension='opus'").get(); before.close();
  wire.hold = true;
  wire.onChat = () => queueMicrotask(() => wire.sockets.at(-1)!.frame({ type: 2, item: { result: { value: "OutOfCredits", message: "synthetic private refusal" }, turnState: "Completed", messages: [] } }));
  const response = await handleChatCompletion(body(undefined, false, model), new SessionPool(options));
  expect(response.status).toBe(429);
  const script = `import {withAccountContext} from './packages/core/src/account-policy.ts'; import {activePriorityAccessExhaustion} from './packages/core/src/priority-access.ts'; const token=oid=>'e30.'+Buffer.from(JSON.stringify({tid:${JSON.stringify(A)},oid})).toString('base64url')+'.sig'; for(const oid of [${JSON.stringify(A)},${JSON.stringify(B)}]) await withAccountContext({getToken:async()=>token(oid)},async()=>console.log(activePriorityAccessExhaustion(${JSON.stringify(model)})?.window??'clear'));`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8" });
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout.trim().split("\n")).toEqual(["day", "clear"]);
  const db = new DatabaseSync(process.env.M365_ACCOUNT_POLICY_PATH!);
  expect(db.prepare("SELECT dimension FROM facts WHERE kind='priority' AND dimension!='opus'").all()).toEqual([expect.objectContaining({ dimension: expect.stringMatching(/^model-sha256:[a-f0-9]{64}$/) })]);
  expect(db.prepare("SELECT * FROM facts WHERE dimension='opus'").get()).toEqual(known);
  db.close();
  expect(readFileSync(process.env.M365_ACCOUNT_POLICY_PATH!).includes(Buffer.from(model))).toBe(false);
  oid = B; wire.hold = false; wire.onChat = undefined;
  expect((await handleChatCompletion(body(), new SessionPool(options))).status).toBe(200);
});

it("rejects deeply nested HTTP tool parameters before account/state/transport and preserves peer progress", async () => {
  let lookups = 0;
  const app = createApp({ ...options, getToken: async () => { lookups++; return options.getToken(); } });
  const deep = '{"x":'.repeat(5000) + '0' + '}'.repeat(5000);
  const raw = '{"model":"claude-sonnet","stream":true,"messages":[{"role":"user","content":"test"}],"tools":[{"type":"function","function":{"name":"synthetic","parameters":' + deep + '}}]}';
  const response = await app.fetch(new Request("http://local/v1/chat/completions", { method: "POST", headers: { "idempotency-key": "bad-deep" }, body: raw }));
  expect(response.status).toBe(413);
  expect((await response.json()).error.code).toBe("request_structure_limit");
  expect(lookups).toBe(0); expect(wire.sockets).toHaveLength(0);
  oid = B;
  const good = await app.fetch(new Request("http://local/v1/chat/completions", { method: "POST", headers: { "idempotency-key": "bad-deep" }, body: JSON.stringify(body()) }));
  expect(good.status).toBe(200); expect(lookups).toBeGreaterThan(0);
  const parameters = { type: "object", properties: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => ["field" + i, { type: "string", description: "x".repeat(100) }])) };
  const large = await app.fetch(new Request("http://local/v1/chat/completions", { method: "POST", body: JSON.stringify({ ...body(), tool_choice: "none", tools: [{ type: "function", function: { name: "large", parameters } }] }) }));
  expect(large.status).toBe(200);
});

it("controls cyclic native input before receipts, locks or conversation mutation", async () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  const request = ChatCompletionRequest.parse({ ...body(), tools: [{ type: "function", function: { name: "synthetic", parameters: cycle } }] });
  const pool = new SessionPool(options);
  const response = await handleChatCompletion(request, pool, { idempotencyKey: "cycle" });
  expect(response.status).toBe(400); expect(pool.receipts.size).toBe(0); expect(pool.size).toBe(0);
  expect(wire.sockets).toHaveLength(0);
  expect((await handleChatCompletion(body(), pool, { idempotencyKey: "cycle" })).status).toBe(200);
});

it.each([false, true])("releases admission and discards its receipt when commit throws (stream=%s)", async stream => {
  const pool = new SessionPool(options);
  const original = pool.commit;
  pool.commit = () => { throw new Error("injected publication fault"); };
  if (stream) {
    const response = await handleChatCompletion(body(undefined, true), pool, { idempotencyKey: "fault" });
    await expect(response.text()).rejects.toThrow("injected publication fault");
  } else await expect(handleChatCompletion(body(), pool, { idempotencyKey: "fault" })).rejects.toThrow("injected publication fault");
  expect(pool.receipts.size).toBe(0);
  pool.commit = original;
  const next = await handleChatCompletion(body(undefined, stream), pool, { idempotencyKey: "fault" });
  expect(next.status).toBe(200);
  expect(await next.text()).toContain("visible answer");
}, 5000);

it("retires lineage and receipt when JSON response buffering fails after production", async () => {
  const pool = new SessionPool(options);
  const originalResolve = pool.resolve.bind(pool);
  let state: ReturnType<SessionPool["resolve"]> | undefined;
  pool.resolve = (...args) => { state = originalResolve(...args); return state; };
  const spy = vi.spyOn(Response.prototype, "arrayBuffer").mockRejectedValueOnce(new Error("injected buffering fault"));
  try { await expect(handleChatCompletion(body(), pool, { idempotencyKey: "buffer-fault" })).rejects.toThrow("injected buffering fault"); }
  finally { spy.mockRestore(); }
  expect(state?.busy).toBe(false);
  expect(state?.expectedHash).toBeUndefined();
  expect(pool.receipts.size).toBe(0);
  expect((await handleChatCompletion(body(), pool, { idempotencyKey: "buffer-fault" })).status).toBe(200);
});

it.each(["content", "finish"])("does not replay an incomplete success after SSE %s encoding fails", async stage => {
  const pool = new SessionPool(options);
  const encode = TextEncoder.prototype.encode;
  let injected = false;
  const spy = vi.spyOn(TextEncoder.prototype, "encode").mockImplementation(function (this: TextEncoder, input) {
    if (!injected && input?.startsWith("data: {") && input.includes(stage === "content" ? '"content":"visible answer"' : '"finish_reason":"stop"')) {
      injected = true;
      throw new Error("injected encoding fault");
    }
    return encode.call(this, input);
  });
  let emitted = "";
  try {
    const response = await handleChatCompletion(body(undefined, true), pool, { idempotencyKey: "render-fault" });
    const reader = response.body!.getReader();
    try {
      for (;;) { const part = await reader.read(); if (part.done) break; emitted += new TextDecoder().decode(part.value); }
    } catch (error) { expect(error).toBeInstanceOf(Error); }
  } finally { spy.mockRestore(); }
  expect(injected).toBe(true);
  expect(emitted).not.toContain('"finish_reason":"stop"');
  expect(pool.receipts.size).toBe(0);
  const retry = await handleChatCompletion(body(undefined, true), pool, { idempotencyKey: "render-fault" });
  expect(await retry.text()).toContain('"content":"visible answer"');
  expect(wire.texts).toHaveLength(2);
}, 5000);

it.each([false, true])("delivers large generated output and releases the lane (stream=%s)", async stream => {
  const generated = "ordinary generated file contents\n".repeat(140000);
  wire.hold = true;
  wire.onChat = () => { const socket = wire.sockets.at(-1)!; queueMicrotask(() => {
    socket.frame({ type: 1, target: "update", arguments: [{ messages: [{ author: "bot", text: generated, messageId: "m" }] }] });
    socket.frame({ type: 2, item: { result: { value: "Success" }, turnState: "Completed", messages: [] } });
  }); };
  const pool = new SessionPool(options);
  const originalResolve = pool.resolve.bind(pool);
  let state: ReturnType<SessionPool["resolve"]> | undefined;
  pool.resolve = (...args) => { state = originalResolve(...args); return state; };
  const response = await handleChatCompletion(body(undefined, stream), pool, { idempotencyKey: "large" });
  expect(response.status).toBe(200);
  if (stream) {
    const text = await response.text();
    const frames = text.split("\n\n").filter(s => s.startsWith("data: {")).map(s => JSON.parse(s.slice(6)));
    expect(frames.map(f => f.choices?.[0]?.delta?.content ?? "").join("")).toBe(generated);
    expect(text).toContain("data: [DONE]");
  } else expect((await response.json()).choices[0].message.content).toBe(generated);
  expect(state?.busy).toBe(false);
  expect(state?.expectedHash).toBeUndefined();
  expect(state?.expectedLength).toBeUndefined();
  expect(pool.receipts.size).toBe(0);
  wire.hold = false; wire.onChat = undefined;
  const next = await handleChatCompletion(body(), pool, { idempotencyKey: "next" });
  expect(next.status).toBe(200);
  expect((await next.json()).choices[0].message.content).toBe("visible answer");
}, 15000);

it("bounds canonical depth, nodes and bytes while preserving JSON order semantics and legitimate large tools", () => {
  expect(canonicalHash({ b: [1, 2], a: { y: 2, x: 1 } })).toBe(canonicalHash({ a: { x: 1, y: 2 }, b: [1, 2] }));
  expect(canonicalHash([1, 2])).not.toBe(canonicalHash([2, 1]));
  const nested = (depth: number) => { let value: unknown = 0; for (let i = 0; i < depth; i++) value = { x: value }; return value; };
  expect(() => canonicalHash(nested(64))).not.toThrow();
  expect(() => canonicalHash(nested(65))).toThrow();
  expect(() => canonicalHash(Array(99999).fill(0))).not.toThrow();
  expect(() => canonicalHash(Array(100001).fill(0))).toThrow();
  expect(() => canonicalHash("x".repeat(4 * 1024 * 1024 - 2))).not.toThrow();
  expect(() => canonicalHash("x".repeat(4 * 1024 * 1024))).toThrow();
  expect(() => canonicalHash(new Array(100001))).toThrow();
  expect(() => canonicalHash({ properties: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => ["field" + i, { type: "string", description: "x".repeat(100) }])) })).not.toThrow();
});
