import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "./index.js";
import { readRequestJson, requestBodyLimits } from "./request-body.js";

vi.mock("./handler.js", () => ({
  SessionPool: class {},
  handleChatCompletion: vi.fn(async (_body, _pool, { signal }) => Response.json({ aborted: signal.aborted })),
}));
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const bytes = (text: string) => new TextEncoder().encode(text);
function request(body: ReadableStream<Uint8Array> | Uint8Array, headers = {}, signal?: AbortSignal) {
  return new Request("http://localhost/v1/chat/completions", { method: "POST", body, headers, signal, duplex: "half" } as RequestInit);
}
it("rejects an oversized declared length before pulling the body", async () => {
  vi.stubEnv("M365_MAX_REQUEST_BYTES", "8");
  const cancel = vi.fn();
  const response = await createApp().fetch(request(new ReadableStream({ cancel }), { "content-length": "9" }));
  expect(response.status).toBe(413);
  expect(response.headers.get("x-should-retry")).toBe("false");
  expect((await response.json()).error.code).toBe("request_too_large");
  expect(cancel).toHaveBeenCalledOnce();
});
it("counts actual UTF8 bytes despite a smaller declared length", async () => {
  vi.stubEnv("M365_MAX_REQUEST_BYTES", "8");
  const response = await createApp().fetch(request(bytes('"😀😀"'), { "content-length": "1" }));
  expect(response.status).toBe(413);
});
it("strictly rejects malformed UTF8 even inside a JSON string", async () => {
  const prefix = bytes('{"model":"m365-copilot","messages":[{"role":"user","content":"');
  const suffix = bytes('"}]}');
  const malformed = new Uint8Array([...prefix, 255, ...suffix]);
  const response = await createApp().fetch(request(malformed));
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe("invalid_request_body");
});
it("uses a total deadline even when chunks continuously arrive", async () => {
  vi.stubEnv("M365_REQUEST_BODY_TIMEOUT_MS", "30");
  let timer: ReturnType<typeof setInterval>;
  const cancel = vi.fn(() => clearInterval(timer));
  const body = new ReadableStream<Uint8Array>({ start(c) { timer = setInterval(() => c.enqueue(bytes(" ")), 2); }, cancel });
  try {
    const response = await Promise.race([createApp().fetch(request(body)), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("body deadline missing")), 250))]);
    expect(response.status).toBe(408);
    expect(response.headers.get("x-should-retry")).toBe("false");
    expect((await response.json()).error.code).toBe("request_body_timeout");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  } finally { clearInterval(timer!); }
});
it("aborts pending reads and releases signal listeners and reader", async () => {
  const ac = new AbortController();
  const body = new ReadableStream<Uint8Array>({});
  const req = request(body, {}, ac.signal);
  const add = vi.spyOn(req.signal, "addEventListener");
  const remove = vi.spyOn(req.signal, "removeEventListener");
  const pending = createApp().fetch(req);
  ac.abort();
  const response = await Promise.race([pending, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort ignored")), 250))]);
  expect(response.status).toBe(400);
  expect(body.locked).toBe(false);
  expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
});
it("accepts valid JSON exactly at the byte limit and preserves the upload signal", async () => {
  const text = JSON.stringify({ model: "m365-copilot", messages: [{ role: "user", content: "😀" }] });
  vi.stubEnv("M365_MAX_REQUEST_BYTES", String(bytes(text).byteLength));
  const response = await createApp().fetch(request(bytes(text)));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ aborted: false });
});
it.each(["", "0", "-1", "Infinity", "NaN", "1.5", "9007199254740992"])("invalid limit %s falls back to finite defaults", value => {
  vi.stubEnv("M365_MAX_REQUEST_BYTES", value);
  vi.stubEnv("M365_REQUEST_BODY_TIMEOUT_MS", value);
  expect(requestBodyLimits()).toEqual({ bytes: 32 * 1024 * 1024, timeoutMs: 30_000 });
});
it("rejects timer overflow instead of allowing Node to turn it into a 1ms deadline", () => {
  vi.stubEnv("M365_REQUEST_BODY_TIMEOUT_MS", "2147483648");
  expect(requestBodyLimits().timeoutMs).toBe(30_000);
});
it("decodes multibyte UTF8 split across chunks and releases the reader on success", async () => {
  const encoded = bytes('"😀"');
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const byte of encoded) c.enqueue(new Uint8Array([byte])); c.close(); } });
  const ac = new AbortController();
  const add = vi.spyOn(ac.signal, "addEventListener");
  const remove = vi.spyOn(ac.signal, "removeEventListener");
  expect(await readRequestJson(body, null, ac.signal)).toBe("😀");
  expect(body.locked).toBe(false);
  expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
});
it("does not await a producer's hung cancellation on rejection", async () => {
  vi.stubEnv("M365_MAX_REQUEST_BYTES", "1");
  const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(bytes("oversize")); }, cancel() { return new Promise(() => {}); } });
  const response = await createApp().fetch(request(body));
  expect(response.status).toBe(413);
  expect(body.locked).toBe(false);
});
it("enforces deadline during a continuously ready stream without yielding to timers", async () => {
  vi.stubEnv("M365_REQUEST_BODY_TIMEOUT_MS", "1");
  let pulls = 0;
  const body = new ReadableStream<Uint8Array>({ pull(c) { if (++pulls > 50_000) c.close(); else c.enqueue(bytes(" ")); } });
  const response = await createApp().fetch(request(body));
  expect(response.status).toBe(408);
  expect(pulls).toBeLessThan(50_000);
});
