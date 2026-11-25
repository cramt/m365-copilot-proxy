import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AetherSession, resetRuntimeEndpoint, runtimeCatalog } from "./aether.js";

const tenant = "11111111-1111-1111-1111-111111111111";
const a = "22222222-2222-2222-2222-222222222222";
const b = "33333333-3333-3333-3333-333333333333";
const token = (oid: string) => `e30.${Buffer.from(JSON.stringify({ tid: tenant, oid })).toString("base64url")}.sig`;

function runtimePeer() {
  const calls: { oid: string; host: string; path: string; conversation?: string }[] = [];
  const mids = new Map<string, string>();
  const fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = new Headers(init.headers);
    const oid = headers.get("x-user-id")!;
    const authorization = headers.get("authorization");
    expect(authorization).toBe(`Bearer ${token(oid)}`);
    calls.push({ oid, host: url.hostname, path: url.pathname, conversation: headers.get("x-conversation-id") ?? undefined });
    if (url.pathname === "/v1/routing") return Response.json({ endpoint: `https://${oid}.runtime.invalid` });
    if (url.pathname === "/v1/models") return Response.json({ models: [{ id: oid === a ? "model-A" : "model-B" }] });
    if (url.pathname === "/v1/prewarm") return Response.json({});
    if (url.pathname === "/v1/messages") {
      const payload = JSON.parse(String(init.body));
      mids.set(oid, payload.messageId);
      return Response.json({ id: "1-0" });
    }
    if (url.pathname === "/v1/subscribe") {
      const mid = mids.get(oid);
      return new Response(`event: rl\ndata: ${JSON.stringify({ st: "started", mid })}\n\nevent: dx\ndata: {"t":"ok"}\n\nevent: rl\ndata: ${JSON.stringify({ st: "ok", mid })}\n\n`);
    }
    throw new Error(`Unexpected synthetic route ${url.pathname}`);
  });
  return { calls, fetch };
}
async function drain(session: AetherSession, text: string) {
  const stream = await session.run(text);
  for await (const _ of stream) { /* Consume the actual runtime stream. */ }
  expect(stream.fullText).toBe("ok");
}
beforeEach(() => { resetRuntimeEndpoint(); vi.stubEnv("M365_SAVE_HISTORY", "1"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); resetRuntimeEndpoint(); });

describe("runtime account isolation", () => {
  it.each(["cowork", "code"] as const)("routes independent %s sessions A→B→A to their own endpoints", async mode => {
    const peer = runtimePeer(); vi.stubGlobal("fetch", peer.fetch);
    for (const oid of [a, b, a]) await drain(new AetherSession({ mode, getToken: async () => token(oid) }), "private prompt");
    const messages = peer.calls.filter(call => call.path === "/v1/messages");
    expect(messages.map(call => [call.oid, call.host])).toEqual([[a, `${a}.runtime.invalid`], [b, `${b}.runtime.invalid`], [a, `${a}.runtime.invalid`]]);
    expect(peer.calls.filter(call => call.path === "/v1/routing").map(call => call.oid)).toEqual([a, b]);
  });
  it("selects catalog by freshly resolved principal A→B→A", async () => {
    const peer = runtimePeer(); vi.stubGlobal("fetch", peer.fetch);
    let oid = a; const get = async () => token(oid);
    await expect(runtimeCatalog(async () => "bad-token")).rejects.toMatchObject({ code: "invalid_account_principal" });
    expect(peer.calls).toHaveLength(0);
    expect(await runtimeCatalog(get)).toEqual(["model-A"]);
    oid = b; expect(await runtimeCatalog(get)).toEqual(["model-B"]);
    oid = a; expect(await runtimeCatalog(get)).toEqual(["model-A"]);
    expect(peer.calls.filter(call => call.path === "/v1/models").map(call => call.oid)).toEqual([a, b]);
  });
  it.each(["cowork", "code"] as const)("pins a direct %s session and allows a new session for B", async mode => {
    const peer = runtimePeer(); vi.stubGlobal("fetch", peer.fetch);
    let oid = a; const session = new AetherSession({ mode, getToken: async () => token(oid) });
    await drain(session, "A"); const calls = peer.calls.length;
    oid = b;
    await expect(session.run("B")).rejects.toMatchObject({ code: "account_changed" });
    expect(peer.calls).toHaveLength(calls);
    await drain(new AetherSession({ mode, getToken: async () => token(b) }), "new B");
    oid = a; await drain(session, "A again");
    expect(peer.calls.filter(call => call.path === "/v1/messages").map(call => call.oid)).toEqual([a, b, a]);
  });
});
