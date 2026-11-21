import { afterAll, afterEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";

const endpoint = vi.hoisted(() => ({ url: "" }));
vi.mock("./node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs", async (original) => {
  const real = await original<any>();
  return { ...real, default: class extends real.default {
    constructor(_url: string, options: object) { super(endpoint.url, options); }
  } };
});
// The ws package's internal ESM wrapper has no declarations.
// @ts-expect-error test-only transport alias
const { WebSocketServer } = await import("./node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs");
const { handleChatCompletion, SessionPool } = await import("./packages/proxy-lib/src/handler.js");
const { ModelSession } = await import("./packages/core/src/model.js");
const { ChatCompletionRequest } = await import("./packages/proxy-lib/src/schemas.js");
const http = createServer();
const server = new WebSocketServer({ server: http });
const sockpath = `${process.env.TMPDIR ?? "/tmp"}/m365-strict-${process.pid}.sock`;
await new Promise<void>(resolve => http.listen(sockpath, resolve));
endpoint.url = `ws+unix://${sockpath}:/`;
const token = `e30.${Buffer.from(JSON.stringify({ oid: "synthetic", tid: "synthetic", aud: "synthetic", iss: "synthetic", exp: 9999999999 })).toString("base64url")}.sig`;
let terminal = "ForbiddenRequest";
let transport = "chathub";
const content = "arbitrary content that is not a recognizable refusal";
let release: (() => void) | undefined;
let seen: (() => void) | undefined;
let closed: (() => void) | undefined;
let payload = content;
let chunks: string[] | null = null;
let retryApology = false;
let retrySequence = false;
let firstPadding = 0;
let f22Sequence = false;
let confabSequence = false;
let graphics = false;
let completionError = false;
let contradictoryTerminal = false;
let repeatedFrames = 1;
let attempts = 0;
let multipartSize = 0;
let multipartSent: number[] = [];
let multipartPrompts: string[] = [];
let started: Promise<void>;
server.on("connection", (ws: any) => { ws.on("close", () => closed?.()); ws.on("message", (raw: Buffer) => {
  let terminalError = false;
  try {
    for (const line of raw.toString().split("\x1e").filter(Boolean)) {
      const f = JSON.parse(line);
      if (f.protocol) ws.send("{}\x1e");
      if (f.target === "stop" || f.item?.type === "stop") { ws.close(); continue; }
      if (f.target !== "chat" && f.item?.type !== "chat_request") continue;
      const id = f.item?.chatStreamRequest?.requestId;
      const send = (x: object) => ws.send(JSON.stringify(x) + "\x1e");
      attempts++;
      if (multipartSize) {
        multipartPrompts.push(transport === "streamhub" ? f.item.chatStreamRequest.message.text : f.arguments[0].message.text);
        const text = attempts <= 2 ? "P".repeat(multipartSize) : "FINAL-ANSWER";
        const part = transport === "streamhub" ? { type: 2, item: { type: "message_part", requestId: id, argument: { w: text } } } : { type: 1, target: "update", arguments: [{ writeAtCursor: text }] };
        const end = transport === "streamhub" ? { type: 2, item: { type: "request_end", requestId: id, outcome: { category: "Success" } } } : { type: 2, item: { result: { value: "Success" } } };
        const a = JSON.stringify(part) + "\x1e"; const b = JSON.stringify(end) + "\x1e";
        multipartSent.push(Buffer.byteLength(a) + Buffer.byteLength(b));
        ws.send(a); ws.send(b);
        continue;
      }
      if (confabSequence && attempts === 1) {
        const text = "I can't access your files from here. Please paste the contents of calc.py.";
        send(transport === "streamhub" ? { type: 2, item: { type: "message_part", requestId: id, argument: { w: text } } } : { type: 1, target: "update", arguments: [{ writeAtCursor: text }] });
        send(transport === "streamhub" ? { type: 2, item: { type: "request_end", requestId: id, outcome: { category: "Success" } } } : { type: 2, item: { result: { value: "Success" } } });
        continue;
      }
      if (f22Sequence && attempts === 1) {
        const msg = { messages: [{ author: "bot", messageType: "Disengaged", messageId: "m1" }] };
        send(transport === "streamhub" ? { type: 2, item: { type: "message_part", requestId: id, argument: msg } } : { type: 1, target: "update", arguments: [msg] });
        send(transport === "streamhub" ? { type: 2, item: { type: "request_end", requestId: id, outcome: { category: "Success" } } } : { type: 2, item: { result: { value: "Success" } } });
        continue;
      }
      if (retrySequence && (attempts === 1 || terminal === "second-apology")) {
        const msg = { messages: [{ author: "bot", text: "first refused content" + "z".repeat(firstPadding), contentOrigin: "Apology", messageId: "m1" }] };
        send(transport === "streamhub" ? { type: 2, item: { type: "message_part", requestId: id, argument: msg } } : { type: 1, target: "update", arguments: [msg] });
        send(transport === "streamhub" ? { type: 2, item: { type: "request_end", requestId: id, outcome: { category: "Success" } } } : { type: 2, item: { result: { value: "Success" } } });
        continue;
      }
      if (retryApology && attempts === 1) {
        send({ type: 1, target: "update", arguments: [{ messages: [{ author: "bot", text: "first refused content", contentOrigin: "Apology", messageId: "m1" }] }] });
        send({ type: 2, item: { result: { value: "Success" } } });
        continue;
      }
      const makePart = (text: string) => transport === "streamhub" ? { type: 2, item: { type: "message_part", requestId: id, argument: { w: text } } } : { type: 1, target: "update", arguments: [{ writeAtCursor: text }] };
      const part = makePart(payload);
      if (chunks) for (const chunk of chunks) send(makePart(chunk));
      else for (let i = 0; i < repeatedFrames; i++) send(part);
      if (terminal === "flood") {
        let active = true;
        ws.on("close", () => { active = false; });
        const flood = () => { if (!active || ws.readyState !== 1) return; send(part); setImmediate(flood); };
        setImmediate(flood);
      }
      release = () => {
        if (terminal === "disconnect") { ws.terminate(); return; }
        if (contradictoryTerminal && transport === "streamhub") {
          const end = (category: string) => ({ type: 2, item: { type: "request_end", requestId: id, outcome: { category } } });
          ws.send(JSON.stringify(end("Success")) + "\x1e" + JSON.stringify(end("ForbiddenRequest")) + "\x1e");
          return;
        }
        if (completionError) { send({ type: 3, error: content }); return; }
        if (terminal === "missing") {
          send(transport === "streamhub" ? { type: 2, item: { type: "request_end", requestId: id } } : { type: 2, item: {} });
          return;
        }
        send(transport === "streamhub" ? { type: 2, item: { type: "request_end", requestId: id, outcome: { category: terminal } } } : { type: 2, item: { result: { value: terminal }, ...(graphics ? { messages: [{ author: "bot", contentGenerationProgressList: [{ ImageReferenceUrls: ["https://example.invalid/picture"], fileToken: "synthetic", status: 2 }] }] } : {}) } });
      };
      seen?.();
    }
  } catch { terminalError = true; }
  if (terminalError) ws.terminate();
}); });
async function request(stream: boolean, tools = false, options: { signal?: AbortSignal; getToken?: () => Promise<string> } = {}) {
  started = new Promise(r => { seen = r; });
  const body = ChatCompletionRequest.parse({ model: "claude-sonnet", stream, messages: [{ role: "user", content: "hello" }], ...(tools ? { tools: [{ type: "function", function: { name: "bash", description: "shell", parameters: { type: "object", properties: {} } } }] } : {}) });
  return handleChatCompletion(body, new SessionPool({ getToken: options.getToken ?? (async () => token), useAgent: false }), { signal: options.signal });
}
afterEach(() => { vi.unstubAllEnvs(); for (const c of server.clients) c.terminate(); release = undefined; payload = content; chunks = null; closed = undefined; retryApology = false; retrySequence = false; firstPadding = 0; f22Sequence = false; confabSequence = false; graphics = false; completionError = false; contradictoryTerminal = false; repeatedFrames = 1; attempts = 0; multipartSize = 0; multipartSent = []; multipartPrompts = []; });
afterAll(async () => { for (const c of server.clients) c.terminate(); await new Promise<void>(r => server.close(r)); await new Promise<void>(r => http.close(() => r())); });
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const tools of [false, true]) {
  it(`strict refuses pending content: ${wire} stream=${streaming} tools=${tools}`, async () => {
    vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = "ForbiddenRequest";
    const pending = request(streaming, tools); await started; release!();
    const response = await pending; const text = await response.text();
    expect(text).not.toContain(content);
    expect(text).toContain("error");
  });
  it(`strict returns success exactly once: ${wire} stream=${streaming} tools=${tools}`, async () => {
    vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = "Success";
    const pending = request(streaming, tools); await started; release!();
    const text = await (await pending).text();
    expect(text.split(content)).toHaveLength(2);
  });
  it(`strict refuses disconnect: ${wire} stream=${streaming} tools=${tools}`, async () => {
    vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = "disconnect";
    const pending = request(streaming, tools); await started; release!();
    const text = await (await pending).text();
    expect(text).not.toContain(content); expect(text).toContain("error");
  });
}
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const tools of [false, true]) for (const where of [0, 1, 2]) it(`strict withholds arbitrary refusal ${wire} stream=${streaming} tools=${tools} position=${where}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = "ForbiddenRequest";
  chunks = ["prefix ", "middle ", "suffix "]; chunks[where] = content;
  const pending = request(streaming, tools); await started; release!();
  const text = await (await pending).text(); expect(text).not.toContain(content); expect(text).not.toContain("prefix "); expect(text).toContain("error");
});
it("strict fails closed on a contradictory terminal refusal following success", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "streamhub"); transport = "streamhub"; contradictoryTerminal = true;
  const pending = request(true); await started; release!();
  const text = await (await pending).text(); expect(text).not.toContain(content); expect(text).toContain("error");
});
it("strict does not echo upstream completion-error text", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub"; completionError = true;
  const pending = request(true); await started; release!();
  const text = await (await pending).text(); expect(text).not.toContain(content); expect(text).toContain("error");
});
it("strict rejects generated images without fetching them", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub"; terminal = "Success"; graphics = true;
  const pending = request(true); await started; release!();
  const text = await (await pending).text(); expect(text).toContain("error"); expect(text).not.toContain(content); expect(text).not.toContain("example.invalid");
});
for (const wire of ["chathub", "streamhub"]) it(`strict refuses missing terminal result: ${wire}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = "missing";
  const pending = request(true); await started; release!();
  const text = await (await pending).text(); expect(text).not.toContain(content); expect(text).toContain("error");
});
it("concurrent slow reader does not block another completed request", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub"; terminal = "Success";
  const slow = await request(true); await started; const finishSlow = release!;
  const fast = await request(true); await started; const finishFast = release!;
  finishFast();
  const fastText = await Promise.race([fast.text(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fast request stalled")), 1000))]);
  expect(fastText).toContain(content);
  finishSlow(); const slowText = await slow.text(); expect(slowText).toContain(content);
});
it("slow consumers do not accumulate empty heartbeats before cancellation", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub";
  let tick: (() => void) | undefined;
  const interval = vi.spyOn(globalThis, "setInterval").mockImplementation(((cb: () => void) => { tick = cb; return 123 as any; }) as typeof setInterval);
  const clear = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
  try {
    const response = await request(true); await started;
    expect(tick).toBeDefined(); for (let n = 0; n < 1000; n++) tick!();
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"role":"assistant"');
    tick!();
    const second = new TextDecoder().decode((await reader.read()).value);
    expect(second).toContain('"delta":{}');
    const peerClosed = new Promise<void>(r => { closed = r; }); await reader.cancel(); await peerClosed;
  } finally { interval.mockRestore(); clear.mockRestore(); }
});
it("strict sends role and heartbeat while holding pending text", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub"; terminal = "Success";
  let bufferedHeartbeat: ReturnType<typeof setInterval> | undefined;
  const response = await request(true); const reader = response.body!.getReader(); await started;
  let text = new TextDecoder().decode((await reader.read()).value);
  const ticking = new Promise<void>(r => { bufferedHeartbeat = setTimeout(r, 15_100); });
  await ticking;
  text += new TextDecoder().decode((await reader.read()).value);
  expect(text).toContain('"role":"assistant"'); expect(text).not.toContain(content);
  expect(text).toContain('"delta":{}');
  if (bufferedHeartbeat) clearTimeout(bufferedHeartbeat);
  release!(); await reader.cancel();
}, 20_000);
for (const wire of ["chathub", "streamhub"]) for (const size of [300_000, 1_100_000]) it(`strict counts actual multipart acknowledgments ${wire} size=${size}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); vi.stubEnv("M365_TURN_CHUNK_BYTES", "1024"); transport = wire; multipartSize = size;
  const body = ChatCompletionRequest.parse({ model: "claude-sonnet", stream: true, messages: [{ role: "user", content: "Q".repeat(2600) }] });
  const response = await handleChatCompletion(body, new SessionPool({ getToken: async () => token, useAgent: false }));
  const text = await response.text();
  expect(response.status).toBe(200); expect(text).toContain('"role":"assistant"');
  expect(multipartSent.length).toBe(size > 1_000_000 ? 2 : 3);
  expect(multipartPrompts[0]).toContain("part 1 of"); expect(multipartPrompts[1]).toContain("part 2 of");
  expect(multipartSent[0]).toBeLessThan(2 * 1024 * 1024); expect(multipartSent[1]).toBeLessThan(2 * 1024 * 1024);
  expect(multipartSent[0] + multipartSent[1] > 2 * 1024 * 1024).toBe(size > 1_000_000);
  expect(text).not.toContain("PPPPPP");
  if (size > 1_000_000) { expect(text).toContain('"error"'); expect(text).not.toContain("FINAL-ANSWER"); }
  else { expect(text).toContain("FINAL-ANSWER"); expect(text).not.toContain('"error"'); }
}, 10_000);
for (const wire of ["chathub", "streamhub"]) for (const size of [300_000, 1_100_000]) it(`strict aggregates wire budget across retry ${wire} bytes=${size}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = "Success"; retrySequence = true; firstPadding = size; payload = "Y".repeat(size);
  const pending = request(true, true); await started; release!();
  const text = await (await pending).text(); expect(attempts).toBe(2); expect(text).not.toContain("first refused content");
  if (size > 1_000_000) { expect(text).toContain("error"); expect(text).not.toContain("YYYYY"); }
  else { expect(text).not.toContain("error"); expect(text).toContain("YYYYY"); }
});
it("a second apology with Success is an error, not a reply", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub"; terminal = "second-apology"; retrySequence = true;
  const text = await (await request(true, true)).text();
  expect(attempts).toBe(2); expect(text).not.toContain("first refused content"); expect(text).toContain("error");
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) it(`strict suppresses successful confab followed by refusal ${wire} stream=${streaming}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = "ForbiddenRequest"; confabSequence = true;
  const pending = request(streaming, true); await started; release!();
  const text = await (await pending).text(); expect(attempts).toBe(2); expect(text).not.toContain(content); expect(text).not.toContain("calc.py"); expect(text).toContain("error");
});
for (const wire of ["chathub", "streamhub"]) for (const final of ["Success", "ForbiddenRequest"]) it(`strict fences F22 retry ${wire} final=${final}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = final; f22Sequence = true;
  const pending = request(true, true); await started; release!();
  const text = await (await pending).text(); expect(attempts).toBe(2);
  if (final === "Success") expect(text.split(content)).toHaveLength(2);
  else { expect(text).not.toContain(content); expect(text).toContain("error"); }
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const final of ["Success", "ForbiddenRequest"]) it(`strict fences apology retry ${wire} stream=${streaming} final=${final}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = final; retrySequence = true;
  const pending = request(streaming, true); await started; release!();
  const text = await (await pending).text(); expect(attempts).toBe(2); expect(text).not.toContain("first refused content");
  if (final === "Success") expect(text.split(content)).toHaveLength(2);
  else { expect(text).not.toContain(content); expect(text).toContain("error"); }
});
it("strict fences an Apology retry from the succeeding attempt", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub"; terminal = "Success"; retryApology = true;
  const pending = request(true, true); await started; release!();
  const text = await (await pending).text();
  expect(attempts).toBe(2); expect(text).not.toContain("first refused content"); expect(text.split(content)).toHaveLength(2);
});
it("absolute deadline is enforced across always-ready async iterator microtasks", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub");
  let clock = 0; let yielded = 0;
  const time = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const stream = { fullText: content, hasContent: true, result: { value: "Success" }, images: [], [Symbol.asyncIterator]() { return { next() { yielded++; if (yielded === 20) clock = 180_001; if (yielded > 100) return Promise.resolve({ value: undefined, done: true }); return Promise.resolve({ value: content, done: false }); }, return() { return Promise.resolve({ value: undefined, done: true }); } }; } };
  const seam = vi.spyOn(ModelSession.prototype, "run").mockImplementation(async () => stream as any);
  try {
    const response = await request(false); const text = await response.text();
    expect(yielded).toBe(20); expect(response.status).toBe(502); expect(text).not.toContain(content);
  } finally { seam.mockRestore(); time.mockRestore(); }
});
it("strict enforces monotonic deadline while upstream keeps producing", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub"; terminal = "flood";
  let clock = 100;
  const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    const pending = request(false); await started; clock += 180_001;
    const text = await (await pending).text(); expect(text).not.toContain(content); expect(text).toContain("error");
  } finally { clockSpy.mockRestore(); }
});
it("strict rejects a terminal success arriving after the absolute deadline even if the timer cannot fire", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub"; terminal = "Success";
  let clock = 100;
  const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    const pending = request(true); await started; clock += 180_001; release!();
    const text = await (await pending).text(); expect(text).not.toContain(content); expect(text).toContain("error");
  } finally { clockSpy.mockRestore(); }
});
it("deadline aborts a pending upstream response without exposing its content", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub";
  const original = AbortSignal.timeout;
  const shorten = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => original(ms === 180_000 ? 30 : ms));
  try {
    const response = await request(true); await started;
    const result = await response.text();
    expect(result).not.toContain(content); expect(result).toContain("error");
  } finally { shorten.mockRestore(); }
});
it("abort before JSON headers while token resolution is pending dispatches no upstream turn", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub";
  let releaseToken!: (value: string) => void; let entered!: () => void;
  const gate = new Promise<string>(r => { releaseToken = r; }); const reached = new Promise<void>(r => { entered = r; });
  const abort = new AbortController();
  const pending = request(false, false, { signal: abort.signal, getToken: () => { entered(); return gate; } });
  await reached; abort.abort(); releaseToken(token);
  const response = await pending; expect(response.status).toBeGreaterThanOrEqual(400); expect(attempts).toBe(0);
  await new Promise<void>(r => setImmediate(r)); expect(server.clients.size).toBe(0);
});
it("strict aborts the upstream socket when the SSE reader cancels", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub";
  const response = await request(true); await started;
  const peerClosed = new Promise<void>(r => { closed = r; });
  await response.body!.cancel(); await peerClosed;
});
it("strict rejects cumulative sub-limit deltas before their success", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub";
  payload = "X".repeat(120_000); repeatedFrames = 20; terminal = "Success";
  const pending = request(false); await started; release!();
  const text = await (await pending).text(); expect(text).not.toContain("XXXXX"); expect(text).toContain("error");
});
it("strict rejects oversized upstream frames", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub";
  payload = "X".repeat(2 * 1024 * 1024 + 1);
  const pending = request(false); await started;
  const text = await (await pending).text();
  expect(text).not.toContain("XXXXX"); expect(text).toContain("error");
});
it("default still streams before upstream success", async () => {
  vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub"; terminal = "Success";
  const response = await request(true); const reader = response.body!.getReader(); await started;
  let got = ""; while (!got.includes(content)) { const r = await reader.read(); got += new TextDecoder().decode(r.value); }
  expect(got).toContain(content); release!(); await reader.cancel();
});
