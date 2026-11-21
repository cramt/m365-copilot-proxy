import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./handler.js", () => ({
  SessionPool: class {},
  handleChatCompletion: vi.fn(async () => new Response("ok")),
}));
import { createApp } from "./index.js";
import { handleChatCompletion } from "./handler.js";

process.env.M365_CORS_ORIGIN = "*";
const app = createApp();
const request = (body: string) => new Request("http://localhost/v1/chat/completions", {
  method: "POST", headers: { origin: "http://localhost:3000", "user-agent": "pi/1.2" }, body,
});
afterEach(() => { delete process.env.M365_MAX_REQUEST_BYTES; delete process.env.M365_REQUEST_BODY_TIMEOUT_MS; vi.clearAllMocks(); });

describe("createApp request ingress", () => {
  it("refuses oversized actual bytes before dispatch with CORS", async () => {
    process.env.M365_MAX_REQUEST_BYTES = "20";
    const res = await app.fetch(request(JSON.stringify({ model: "test", messages: [] })));
    expect(res.status).toBe(413);
    expect((await res.json()).error.type).toBe("invalid_request_error");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(handleChatCompletion).not.toHaveBeenCalled();
  });
  it("dispatches an under-limit valid request and forwards user agent", async () => {
    process.env.M365_MAX_REQUEST_BYTES = "1000";
    const res = await app.fetch(request(JSON.stringify({ model: "test", messages: [{role:"user", content:"hi"}] })));
    expect(res.status).toBe(200);
    expect(handleChatCompletion).toHaveBeenCalledOnce();
    expect(vi.mocked(handleChatCompletion).mock.calls[0][2]?.userAgent).toBe("pi/1.2");
  });
  it("times out a stalled native Fetch stream and cancels without waiting for the producer", async () => {
    process.env.M365_REQUEST_BODY_TIMEOUT_MS = "20";
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
      cancel() { cancelled = true; return new Promise(() => {}); },
    });
    const req = new Request("http://localhost/v1/chat/completions", {
      method: "POST", body: stream, duplex: "half",
    } as RequestInit & { duplex: "half" });
    const res = await app.fetch(req);
    expect(res.status).toBe(408);
    expect(cancelled).toBe(true);
    expect(handleChatCompletion).not.toHaveBeenCalled();
  });
  it("retains native JSON and schema error messages", async () => {
    const bad = await app.fetch(request("{"));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toBe((() => { try { JSON.parse("{"); } catch (e) { return (e as Error).message; } })());
    const invalid = await app.fetch(request("{}"));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.message).toContain("messages");
  });
});
