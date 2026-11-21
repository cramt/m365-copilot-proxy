import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

// Logger configuration is captured at module import; use its real private file sink.
const logPath = vi.hoisted(() => {
  const path = `${process.env.TMPDIR ?? "/tmp"}/m365-info-${process.pid}.log`;
  process.env.M365_DEBUG = "1";
  process.env.M365_LOG_FILE = path;
  return path;
});

const setupMocks = vi.hoisted(() => ({ agent: null as null | (() => Promise<any>), image: null as null | (() => Promise<any>), file: null as null | (() => Promise<any>) }));
vi.mock("./packages/core/src/file-upload.js", async original => {
  const real = await original<any>(); return { ...real, uploadFile: (...args: any[]) => setupMocks.file ? setupMocks.file() : real.uploadFile(...args) };
});
vi.mock("./packages/core/src/agent.js", async original => {
  const real = await original<any>(); return { ...real, getOrCreateAgent: (...args: any[]) => setupMocks.agent ? setupMocks.agent() : real.getOrCreateAgent(...args) };
});
vi.mock("./packages/core/src/image-input.js", async original => {
  const real = await original<any>(); return { ...real, uploadImage: (...args: any[]) => setupMocks.image ? setupMocks.image() : real.uploadImage(...args) };
});
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
const { resetPriorityAccessState, activePriorityAccessExhaustion } = await import("./packages/core/src/priority-access.js");
const { ChatCompletionRequest } = await import("./packages/proxy-lib/src/schemas.js");
const http = createServer();
const server = new WebSocketServer({ server: http });
const sockpath = `${process.env.TMPDIR ?? "/tmp"}/m365-strict-${process.pid}.sock`;
await new Promise<void>(resolve => http.listen(sockpath, resolve));
endpoint.url = `ws+unix://${sockpath}:/`;
const token = `e30.${Buffer.from(JSON.stringify({ oid: "synthetic", tid: "synthetic", aud: "synthetic", iss: "synthetic", exp: 9999999999 })).toString("base64url")}.sig`;
let terminal = "ForbiddenRequest";
let terminalCode: string | undefined;
let terminalMessage: string | undefined;
let terminalApology = false;
let automaticFallback = false;
let automaticBingFallback = false;
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
let f22Progress = false;
let confabSequence = false;
let graphics = false;
let completionError = false;
let contradictoryTerminal = false;
let terminalRecords: string[] | null = null;
let separateRecords = false;
let rawTerminalFrames: string[] | null = null;
let repeatedFrames = 1;
let attempts = 0;
let multipartSize = 0;
let handshakeReply = "{}";
let multipartSent: number[] = [];
let multipartPrompts: string[] = [];
let started: Promise<void>;
server.on("connection", (ws: any) => { ws.on("close", () => closed?.()); ws.on("message", (raw: Buffer) => {
  let terminalError = false;
  try {
    for (const line of raw.toString().split("\x1e").filter(Boolean)) {
      const f = JSON.parse(line);
      if (f.protocol) ws.send(handshakeReply + "\x1e");
      if (f.target === "stop" || f.item?.type === "stop") { ws.close(); continue; }
      if (f.target !== "chat" && f.item?.type !== "chat_request") continue;
      const id = f.item?.chatStreamRequest?.requestId;
      const send = (x: object) => ws.send(JSON.stringify(x) + "\x1e");
      attempts++;
      if (automaticBingFallback) {
        const text = attempts === 1 ? "refused precursor" : "bing fallback success";
        const update = transport === "streamhub" ? { type: 2, item: { type: "message_part", requestId: id, argument: { w: text } } } : { type: 1, target: "update", arguments: [{ writeAtCursor: text }] };
        const outcome = attempts === 1 ? { category: "InvalidRequest", code: "InputTokenLimitExceeded" } : { category: "Success" };
        const end = transport === "streamhub" ? { type: 2, item: { type: "request_end", requestId: id, outcome } } : { type: 2, item: { result: { value: outcome.category, ...(outcome.code ? { errorCode: outcome.code } : {}) } } };
        send(update); send(end); continue;
      }
      if (automaticFallback) {
        const text = attempts === 1 ? "refused precursor" : "fallback success";
        const update = transport === "streamhub" ? { type: 2, item: { type: "message_part", requestId: id, argument: { w: text } } } : { type: 1, target: "update", arguments: [{ writeAtCursor: text }] };
        const end = transport === "streamhub" ? { type: 2, item: { type: "request_end", requestId: id, outcome: { category: attempts === 1 ? "OutOfCredits" : "Success", ...(attempts === 1 ? { message: "You've used your available priority access to the Sonnet model for today." } : {}) } } } : { type: 2, item: { result: { value: attempts === 1 ? "OutOfCredits" : "Success", ...(attempts === 1 ? { message: "You've used your available priority access to the Sonnet model for today." } : {}) } } };
        send(update); send(end); continue;
      }
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
        if (f22Progress) send(transport === "streamhub" ? { type: 2, item: { type: "message_part", requestId: id, argument: { w: "F22_PRIVATE_PREFIX" } } } : { type: 1, target: "update", arguments: [{ writeAtCursor: "F22_PRIVATE_PREFIX" }] });
        const msg = { messages: [{ author: "bot", messageType: "Disengaged", messageId: "m1" }, ...(f22Progress ? [{ author: "bot", messageType: "Progress", messageId: "m2" }] : [])] };
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
      const part = terminalApology ? (transport === "streamhub" ? { type: 2, item: { type: "message_part", requestId: id, argument: { messages: [{ author: "bot", text: payload, contentOrigin: "Apology", messageId: "apology" }] } } } : { type: 1, target: "update", arguments: [{ messages: [{ author: "bot", text: payload, contentOrigin: "Apology", messageId: "apology" }] }] }) : makePart(payload);
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
        if (rawTerminalFrames) {
          const frames = rawTerminalFrames.map(x => x === "success" ? JSON.stringify(transport === "streamhub" ? { type: 2, item: { type: "request_end", requestId: id, outcome: { category: "Success" } } } : { type: 2, item: { result: { value: "Success" } } }) : x);
          if (separateRecords) for (const frame of frames) ws.send(frame + "\x1e"); else ws.send(frames.map(frame => frame + "\x1e").join(""));
          return;
        }
        if (terminalRecords) {
          const frames = terminalRecords.map(value => transport === "streamhub"
            ? { type: 2, item: { type: "request_end", requestId: id, ...(value === "missing" ? {} : { outcome: { category: value } }) } }
            : { type: 2, item: value === "missing" ? {} : { result: { value } } });
          if (separateRecords) for (const frame of frames) ws.send(JSON.stringify(frame) + "\x1e");
          else ws.send(frames.map(frame => JSON.stringify(frame) + "\x1e").join(""));
          return;
        }
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
        send(transport === "streamhub" ? { type: 2, item: { type: "request_end", requestId: id, outcome: { category: terminal, ...(terminalCode ? { code: terminalCode } : {}), ...(terminalMessage ? { message: terminalMessage } : {}) } } } : { type: 2, item: { result: { value: terminal, ...(terminalCode ? { errorCode: terminalCode } : {}), ...(terminalMessage ? { message: terminalMessage } : {}) }, ...(graphics ? { messages: [{ author: "bot", contentGenerationProgressList: [{ ImageReferenceUrls: ["https://example.invalid/picture"], fileToken: "synthetic", status: 2 }] }] } : {}) } });
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
beforeEach(() => { vi.stubEnv("M365_NO_BACKOFF", "1"); });
afterEach(() => { vi.unstubAllEnvs(); for (const c of server.clients) c.terminate(); release = undefined; payload = content; chunks = null; closed = undefined; retryApology = false; retrySequence = false; firstPadding = 0; f22Sequence = false; f22Progress = false; confabSequence = false; graphics = false; completionError = false; contradictoryTerminal = false; terminalRecords = null; separateRecords = false; rawTerminalFrames = null; repeatedFrames = 1; attempts = 0; multipartSize = 0; handshakeReply = "{}"; terminalCode = undefined; terminalMessage = undefined; terminalApology = false; automaticFallback = false; automaticBingFallback = false; multipartSent = []; multipartPrompts = []; });
afterAll(async () => { for (const c of server.clients) c.terminate(); await new Promise<void>(r => server.close(r)); await new Promise<void>(r => http.close(() => r())); });
for (const wire of ["chathub", "streamhub"]) for (const part of [false, true]) for (const value of ["Throttled", "InvalidRequest", "PRIVATE_RESULT_CANARY"]) for (const known of [false, true]) it(`INFO strict terminal privacy ${wire} part=${part} ${value} known=${known}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire;
  if (part) vi.stubEnv("M365_TURN_CHUNK_BYTES", "1024");
  terminal = value; terminalCode = known ? (value === "Throttled" ? "PerUserThrottled" : "InvalidNote") : "PRIVATE_CODE_CANARY"; terminalMessage = "PRIVATE_MESSAGE_CANARY"; payload = "";
  writeFileSync(logPath, "");
  started = new Promise(r => { seen = r; });
  const body = ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false, messages: [{ role: "user", content: part ? "Q".repeat(2600) : "hello" }] });
  const pending = handleChatCompletion(body, new SessionPool({ getToken: async () => token, useAgent: false }));
  await started; release!(); const response = await pending; const text = await response.text();
  expect(attempts).toBe(1); expect(response.status).toBe(value === "Throttled" ? 429 : value === "InvalidRequest" ? 400 : 502);
  expect(text).not.toContain("PRIVATE_CODE_CANARY"); expect(text).not.toContain("PRIVATE_MESSAGE_CANARY");
  if (value === "Throttled") expect(response.headers.get("Retry-After")).toBeNull();
  const info = readFileSync(logPath, "utf8").split("\n").filter(line => line.includes("[INFO]" )).join("\n");
  expect(info).not.toContain("PRIVATE_CODE_CANARY"); expect(info).not.toContain("PRIVATE_RESULT_CANARY");
  if (known && value !== "PRIVATE_RESULT_CANARY") expect(info).toContain(terminalCode);
});
for (const wire of ["chathub", "streamhub"]) it(`INFO strict excludes upstream score component ${wire}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; payload = ""; terminal = "InvalidRequest";
  const update = { messages: [{ author: "bot", scores: [{ component: "PRIVATE_SCORE_CANARY", score: 0.5 }] }] };
  rawTerminalFrames = [JSON.stringify(wire === "streamhub" ? { type: 2, item: { type: "message_part", argument: update } } : { type: 1, target: "update", arguments: [update] }), JSON.stringify(wire === "streamhub" ? { type: 2, item: { type: "request_end", outcome: { category: "InvalidRequest", code: "InvalidNote" } } } : { type: 2, item: { result: { value: "InvalidRequest", errorCode: "InvalidNote" } } })];
  writeFileSync(logPath, ""); const pending = request(false); await started; release!(); const response = await pending; expect(response.status).toBe(400); await response.text();
  const info = readFileSync(logPath, "utf8").split("\n").filter(line => line.includes("[INFO]")).join("\n"); expect(info).not.toContain("PRIVATE_SCORE_CANARY");
});
for (const category of ["Throttled", "InvalidRequest"]) it(`INFO strict StreamHub error item ${category}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "streamhub"); transport = "streamhub"; payload = "";
  rawTerminalFrames = [JSON.stringify({ type: 2, item: { type: "error", errorCategory: category, errorCode: "PRIVATE_CODE_CANARY", detail: "PRIVATE_DETAIL_CANARY" } })];
  writeFileSync(logPath, ""); const pending = request(false); await started; release!(); const response = await pending; expect(response.status).toBe(category === "Throttled" ? 429 : 400); expect(await response.text()).not.toContain("PRIVATE_CODE_CANARY");
  const info = readFileSync(logPath, "utf8").split("\n").filter(line => line.includes("[INFO]")).join("\n"); expect(info).not.toContain("PRIVATE_CODE_CANARY"); expect(info).not.toContain("PRIVATE_DETAIL_CANARY");
});
for (const wire of ["chathub", "streamhub"]) it(`INFO default preserves terminal diagnostic ${wire}`, async () => {
  vi.stubEnv("M365_TRANSPORT", wire); transport = wire; payload = ""; terminal = "Throttled"; terminalCode = "PRIVATE_DEFAULT_CANARY";
  writeFileSync(logPath, ""); const pending = request(false); await started; release!(); const response = await pending; expect(response.status).toBe(429); await response.text();
  expect(readFileSync(logPath, "utf8")).toContain("PRIVATE_DEFAULT_CANARY");
});
for (const streaming of [false, true]) for (const strictMode of [false, true]) for (const entry of [
  { category: "InvalidRequest", code: "InvalidNote", status: 400, result: "m365_invalid_request" },
  { category: "Throttled", code: "PerUserThrottled", status: 429, result: "m365_throttled" },
  { category: "OutOfCredits", code: undefined, status: 429, result: "priority_access_exhausted" },
]) it(`StreamHub error item classification ${entry.category} stream=${streaming} strict=${strictMode}`, async () => {
  resetPriorityAccessState(); if (strictMode) vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "streamhub"); transport = "streamhub"; payload = strictMode ? content : "";
  rawTerminalFrames = [JSON.stringify({ type: 2, item: { type: "error", errorCategory: entry.category, ...(entry.code ? { errorCode: entry.code } : {}), message: "PRIVATE_CANARY_MESSAGE", detail: "PRIVATE_CANARY_DETAIL" } })];
  const body = ChatCompletionRequest.parse({ model: "claude-sonnet-5.5", stream: streaming, messages: [{ role: "user", content: "hello" }] });
  try { started = new Promise(r => { seen = r; }); const pending = handleChatCompletion(body, new SessionPool({ getToken: async () => token, useAgent: false })); await started; release!(); const response = await pending; const text = await response.text();
    expect(response.status).toBe(streaming ? 200 : entry.status); expect(text).toContain(entry.result); expect(attempts).toBe(1);
    if (strictMode) { expect(text).not.toContain(content); expect(text).not.toContain("PRIVATE_CANARY"); }
    if (entry.code && !streaming) expect(JSON.parse(text).error.param).toBe(entry.code);
    if (entry.category === "OutOfCredits") { expect(activePriorityAccessExhaustion("sonnet-5.5")).not.toBeNull(); if (streaming) expect(text).toContain("retry_after"); else expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0); }
  } finally { resetPriorityAccessState(); }
});
for (const streaming of [false, true]) for (const category of [undefined, "Success", "unknown"]) it(`strict StreamHub error category cannot authorize ${category ?? "missing"} stream=${streaming}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "streamhub"); transport = "streamhub";
  rawTerminalFrames = [JSON.stringify({ type: 2, item: { type: "error", ...(category ? { errorCategory: category } : {}), errorCode: "PRIVATE_CANARY_CODE", message: content } })];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text(); expect(response.status).toBe(streaming ? 200 : 502); expect(text).not.toContain(content); expect(text).not.toContain("PRIVATE_CANARY"); expect(attempts).toBe(1);
});
for (const streaming of [false, true]) it(`StreamHub retains bot text beside null-author control stream=${streaming}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "streamhub"); transport = "streamhub"; payload = "";
  rawTerminalFrames = [JSON.stringify({ type: 2, item: { type: "message_part", argument: { messages: [{ author: null, messageType: "EndOfRequest" }, { author: "bot", messageId: "m", text: "synthetic mixed answer" }] } } }), "success"];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text(); expect(text).toContain("synthetic mixed answer"); expect(attempts).toBe(1);
});
for (const streaming of [false, true]) for (const strictMode of [false, true]) for (const mixed of [false, true]) it(`mixed null control strict-only stream=${streaming} strict=${strictMode} mixed=${mixed}`, async () => {
  if (strictMode) vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "streamhub"); transport = "streamhub";
  const messages = [...(mixed ? [{ author: null, messageType: "EndOfRequest" }] : []), { author: "bot", messageId: "unique", text: "SYNTHETIC_BOT_REPLY" }];
  rawTerminalFrames = [JSON.stringify({ type: 2, item: { type: "message_part", argument: { messages } } }), "success"];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text();
  expect(response.status).toBe(200); expect(text).toContain(content); if (strictMode || !mixed) expect(text).toContain("SYNTHETIC_BOT_REPLY"); else expect(text).not.toContain("SYNTHETIC_BOT_REPLY"); expect(attempts).toBe(1);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) it(`default ForbiddenRequest with content remains ordinary answer ${wire} stream=${streaming}`, async () => {
  vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = "ForbiddenRequest"; terminalCode = "InvalidCopilotLicense";
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text(); expect(response.status).toBe(200); expect(text).toContain(content); expect(attempts).toBe(1);
});
for (const source of ["chathub", "streamhub-end", "streamhub-error"]) for (const streaming of [false, true]) it(`standalone strict ForbiddenRequest is generic ${source} stream=${streaming}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); transport = source === "chathub" ? "chathub" : "streamhub"; vi.stubEnv("M365_TRANSPORT", transport);
  terminal = "ForbiddenRequest"; terminalCode = "InvalidCopilotLicense"; terminalMessage = "PRIVATE_REFUSAL";
  if (source === "streamhub-error") rawTerminalFrames = [JSON.stringify({ type: 2, item: { type: "error", errorCategory: "ForbiddenRequest", errorCode: "InvalidCopilotLicense", message: "PRIVATE_REFUSAL" } })];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text();
  expect(response.status).toBe(streaming ? 200 : 502); expect(text).toContain("upstream_error"); expect(text).not.toContain(content); expect(text).not.toContain("PRIVATE_REFUSAL"); expect(text).not.toContain("InvalidCopilotLicense"); expect(text).not.toContain("m365_account_not_licensed"); expect(attempts).toBe(1);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) it(`strict input-limit Bing fallback succeeds ${wire} stream=${streaming}`, async () => {
  const core = await import("./packages/core/src/copilot.js"); core.resetWebSearchOverflow();
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; automaticBingFallback = true;
  try { const response = await request(streaming); const text = await response.text(); expect(response.status).toBe(200); expect(text).toContain("bing fallback success"); expect(text).not.toContain("refused precursor"); expect(attempts).toBe(2); expect(core.toneUsesWebSearch("Claude_Sonnet")).toBe(false); }
  finally { core.resetWebSearchOverflow(); }
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) it(`strict priority fallback succeeds ${wire} stream=${streaming}`, async () => {
  resetPriorityAccessState(); vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); vi.stubEnv("M365_SONNET_FALLBACK_MODEL", "claude-sonnet"); transport = wire; automaticFallback = true;
  const body = ChatCompletionRequest.parse({ model: "claude-sonnet-5.5", stream: streaming, messages: [{ role: "user", content: "hello" }] });
  try { const response = await handleChatCompletion(body, new SessionPool({ getToken: async () => token, useAgent: false })); const text = await response.text(); expect(response.status).toBe(200); expect(text).toContain("fallback success"); expect(text).not.toContain("refused precursor"); expect(attempts).toBe(2); expect(activePriorityAccessExhaustion("sonnet-5.5")).not.toBeNull(); }
  finally { resetPriorityAccessState(); }
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const value of ["Throttled", "InvalidRequest"]) it(`strict sanitizes upstream error fields ${wire} stream=${streaming} ${value}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = value; terminalCode = "PRIVATE_CANARY_CODE"; terminalMessage = "PRIVATE_CANARY_MESSAGE";
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text();
  expect(response.status).toBe(streaming ? 200 : value === "Throttled" ? 429 : 400); expect(text).not.toContain("PRIVATE_CANARY"); expect(text).not.toContain(content); expect(attempts).toBe(1);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const value of ["Throttled", "OutOfCredits", "ForbiddenRequest"]) for (const mode of ["structured", "text"]) it(`strict apology terminal no retry ${wire} stream=${streaming} ${value} ${mode}`, async () => {
  resetPriorityAccessState(); vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); vi.stubEnv("M365_STREAM_ERROR_MODE", mode); transport = wire; terminal = value; terminalApology = true;
  try { const pending = request(streaming, true); await started; release!(); const response = await pending; const text = await response.text(); expect(attempts).toBe(1); expect(text).not.toContain(content); expect(text).toContain(mode === "text" && streaming ? "m365-proxy" : "error"); }
  finally { resetPriorityAccessState(); }
});
for (const wire of ["chathub", "streamhub"]) for (const value of ["Throttled", "OutOfCredits", "ForbiddenRequest"]) it(`strict does not retry ${value} disguised as Apology ${wire}`, async () => {
  resetPriorityAccessState(); vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = value; terminalApology = true;
  try { const pending = request(true, true); await started; release!(); const response = await pending; const text = await response.text(); expect(text).toContain("error"); expect(text).not.toContain(content); expect(attempts).toBe(1); }
  finally { resetPriorityAccessState(); }
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const strictMode of [false, true]) it(`priority wall classification ${wire} stream=${streaming} strict=${strictMode}`, async () => {
  resetPriorityAccessState(); if (strictMode) vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = "OutOfCredits"; terminalMessage = "You've used your available priority access to the Opus model for today."; payload = strictMode ? content : "";
  const body = ChatCompletionRequest.parse({ model: "claude-sonnet-5.5", stream: streaming, messages: [{ role: "user", content: "hello" }] });
  try {
    started = new Promise(r => { seen = r; }); const pending = handleChatCompletion(body, new SessionPool({ getToken: async () => token, useAgent: false })); await started; release!();
    const response = await pending; const text = await response.text(); expect(response.status).toBe(streaming ? 200 : 429); expect(text).toContain("priority_access_exhausted"); expect(text).toContain(streaming ? "retry_after" : "rate_limit_error"); if (!streaming) expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0); if (strictMode) expect(text).not.toContain(content); expect(attempts).toBe(1); expect(activePriorityAccessExhaustion("sonnet-5.5")).not.toBeNull();
  } finally { resetPriorityAccessState(); }
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const strictMode of [false, true]) it(`throttle controls ${wire} stream=${streaming} strict=${strictMode}`, async () => {
  if (strictMode) vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = "Throttled"; terminalCode = "PerUserThrottled"; payload = "";
  if (streaming && strictMode) vi.stubEnv("M365_STREAM_ERROR_MODE", "text");
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text();
  expect(response.status).toBe(streaming ? 200 : 429); expect(text).toContain("m365_throttled"); expect(text).toContain(streaming && strictMode ? '[m365-proxy:' : 'rate_limit_error'); expect(attempts).toBe(1);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const entry of [
  { value: "Throttled", upstream: "PerUserThrottled", status: 429, code: "m365_throttled" },
  { value: "InvalidRequest", upstream: "InputTokenLimitExceeded", status: 400, code: "context_length_exceeded" },
]) it(`strict classifies ${entry.value} ${wire} stream=${streaming}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = entry.value; terminalCode = entry.upstream;
  if (entry.value === "InvalidRequest") (await import("./packages/core/src/copilot.js")).noteWebSearchOverflow("Claude_Sonnet");
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text();
  expect(response.status).toBe(streaming ? 200 : entry.status); expect(text).toContain(entry.code); expect(text).not.toContain(content); expect(attempts).toBe(1);
});
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
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const handshake of ["null", "[]", "3", '{"error":3}']) it(`strict rejects invalid handshake ${wire} stream=${streaming} ${handshake}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; handshakeReply = handshake;
  const response = await request(streaming); const text = await response.text(); expect(text).toContain("error"); expect(attempts).toBe(0);
}, 5000);
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const separate of [false, true]) for (const reverse of [false, true]) for (const invalid of ["null", "0", "true", "[]", '"x"', '{"type":1,"target":"update","arguments":null}', '{"type":2,"item":null}', '{"type":2,"item":{"messages":[null]}}']) it(`strict rejects invalid protocol record ${wire} s=${streaming} separate=${separate} reverse=${reverse} record=${invalid}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; separateRecords = separate; rawTerminalFrames = reverse ? [invalid, "success"] : ["success", invalid];
  const pending = request(streaming); await started; release!(); const text = await (await pending).text(); expect(text).not.toContain(content); expect(text).toContain("error");
});
for (const streaming of [false, true]) for (const strictMode of [false, true]) it(`replay_1ce0b35_terminal malformed author stream=${streaming} strict=${strictMode}`, async () => {
  if (strictMode) vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub";
  rawTerminalFrames = [JSON.stringify({ type: 2, item: { messages: [{ author: 123 }], result: { value: "ForbiddenRequest", errorCode: "InvalidCopilotLicense" } } })];
  let peerClosed!: () => void; const peerClosedPromise = new Promise<void>(resolve => { peerClosed = resolve; }); closed = peerClosed;
  const pending = request(streaming).then(async response => ({ status: response.status, text: await response.text() })); await started; release!();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = <T>(p: Promise<T>) => Promise.race([p, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 750); })]);
  const result = await bounded(pending); if (timer) clearTimeout(timer);
  if (!result) { for (const client of server.clients) client.terminate(); await pending.catch(() => {}); }
  expect(result).not.toBeNull(); if (!result) return;
  expect(result.status).toBe(streaming ? 200 : strictMode ? 502 : 200); expect(result.text).toContain(strictMode ? "error" : content);
  if (strictMode) expect(result.text).not.toContain(content); expect(attempts).toBe(1);
  const observedClose = await bounded(peerClosedPromise.then(() => true)); if (timer) clearTimeout(timer); expect(observedClose).toBe(true);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const strictMode of [false, true]) it(`replay_1ce0b35_malformed mixed delta ${wire} stream=${streaming} strict=${strictMode}`, async () => {
  if (strictMode) vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire;
  const argument = { ...(wire === "streamhub" ? { w: "VISIBLE_DELTA" } : { writeAtCursor: "VISIBLE_DELTA" }), messages: [{ author: 123 }] };
  rawTerminalFrames = [JSON.stringify(wire === "streamhub" ? { type: 2, item: { type: "message_part", argument } } : { type: 1, target: "update", arguments: [argument] }), "success"];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text(); expect(response.status).toBe(strictMode && !streaming ? 502 : 200);
  if (strictMode) { expect(text).not.toContain(content); expect(text).not.toContain("VISIBLE_DELTA"); expect(text).toContain("error"); } else { expect(text).toContain(content); expect(text).toContain("VISIBLE_DELTA"); }
  expect(attempts).toBe(1);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const separate of [false, true]) for (const reverse of [false, true]) for (const signal of [{ contentOrigin: "Apology" }, { messageType: "Disengaged" }, { turnState: "Failed" }]) it(`replay_1ce0b35_authorless outcome ${wire} stream=${streaming} separate=${separate} reverse=${reverse} ${JSON.stringify(signal)}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; separateRecords = separate;
  const argument = { messages: [{ ...signal, text: "SYNTHETIC_WARNING" }, { author: "bot", text: "SYNTHETIC_ANSWER", messageId: "answer" }] };
  const update = JSON.stringify(wire === "streamhub" ? { type: 2, item: { type: "message_part", argument } } : { type: 1, target: "update", arguments: [argument] });
  rawTerminalFrames = reverse ? ["success", update] : [update, "success"];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text();
  expect(response.status).toBe(streaming ? 200 : 502); expect(text).not.toContain(content); expect(text).not.toContain("SYNTHETIC_WARNING"); expect(text).not.toContain("SYNTHETIC_ANSWER"); expect(text).toContain("error"); expect(attempts).toBe(1);
});
for (const streaming of [false, true]) for (const signal of [{ contentOrigin: "Apology" }, { messageType: "Disengaged" }, { turnState: "Failed" }]) it(`replay_1ce0b35_authorless final Chathub stream=${streaming} ${JSON.stringify(signal)}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub";
  rawTerminalFrames = [JSON.stringify({ type: 2, item: { result: { value: "Success" }, messages: [signal] } })];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text(); expect(response.status).toBe(streaming ? 200 : 502); expect(text).not.toContain(content); expect(text).toContain("error"); expect(attempts).toBe(1);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) it(`strict rejects bot Failed with Success ${wire} stream=${streaming}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire;
  const argument = { messages: [{ author: "bot", turnState: "Failed" }, { author: "bot", turnState: "Completed" }] }; rawTerminalFrames = [JSON.stringify(wire === "streamhub" ? { type: 2, item: { type: "message_part", argument } } : { type: 1, target: "update", arguments: [argument] }), "success"];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text(); expect(response.status).toBe(streaming ? 200 : 502); expect(text).not.toContain(content); expect(text).toContain("error"); expect(attempts).toBe(1);
});
for (const streaming of [false, true]) it(`strict rejects bot Failed in final Chathub stream=${streaming}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub"; rawTerminalFrames = [JSON.stringify({ type: 2, item: { result: { value: "Success" }, messages: [{ author: "bot", turnState: "Failed" }] } })];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text(); expect(response.status).toBe(streaming ? 200 : 502); expect(text).not.toContain(content); expect(text).toContain("error"); expect(attempts).toBe(1);
});
for (const streaming of [false, true]) for (const signal of [{ contentOrigin: "Apology" }, { turnState: "Failed" }]) it(`strict rejects contradictory null author control stream=${streaming} ${JSON.stringify(signal)}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "streamhub"); transport = "streamhub";
  const argument = { messages: [{ author: null, messageType: "EndOfRequest", ...signal }] }; rawTerminalFrames = [JSON.stringify({ type: 2, item: { type: "message_part", argument } }), "success"];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text(); expect(response.status).toBe(streaming ? 200 : 502); expect(text).not.toContain(content); expect(text).toContain("error"); expect(attempts).toBe(1);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const location of ["same", "separate", ...(wire === "chathub" ? ["final"] : [])]) for (const denial of ["Disengaged", "Apology", "Failed"]) it(`sticky refusal then progress ${wire} stream=${streaming} location=${location} ${denial}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire;
  const signal = { author: "bot", ...(denial === "Disengaged" ? { messageType: "Disengaged" } : denial === "Apology" ? { contentOrigin: "Apology" } : { turnState: "Failed" }) };
  const progress = { author: "bot", messageType: "Progress", contentOrigin: "Normal", turnState: "Completed" };
  const update = (messages: object[]) => JSON.stringify(wire === "streamhub" ? { type: 2, item: { type: "message_part", argument: { messages } } } : { type: 1, target: "update", arguments: [{ messages }] });
  rawTerminalFrames = location === "same" ? [update([signal, progress]), "success"] : location === "separate" ? [update([signal]), update([progress]), "success"] : [update([signal]), JSON.stringify({ type: 2, item: { messages: [progress], result: { value: "Success" } } })];
  separateRecords = location === "separate";
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text(); expect(response.status).toBe(streaming ? 200 : 502); expect(text).not.toContain(content); expect(text).toContain("error"); expect(attempts).toBe(1);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) it(`progress success remains usable ${wire} stream=${streaming}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire;
  const arg = { messages: [{ author: "bot", messageType: "Progress", contentOrigin: "Normal", turnState: "Completed" }] }; rawTerminalFrames = [JSON.stringify(wire === "streamhub" ? { type: 2, item: { type: "message_part", argument: arg } } : { type: 1, target: "update", arguments: [arg] }), "success"];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text(); expect(response.status).toBe(200); expect(text).toContain(content); expect(attempts).toBe(1);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const separate of [false, true]) for (const reverse of [false, true]) for (const sibling of [
  { author: 123 }, { author: null }, { author: "bot", contentOrigin: 42 }, { author: "bot", messageType: false },
  { author: "bot", text: 123 }, { author: "bot", messageId: {} }, { author: "bot", scores: [{ component: "x", score: "wrong" }] },
  { author: "bot", turnState: 7 }, { author: "bot", adaptiveCards: "wrong" },
]) it(`replay_ffd6e4c_mixed malformed sibling ${wire} stream=${streaming} separate=${separate} reverse=${reverse} ${JSON.stringify(sibling)}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; separateRecords = separate;
  const argument = { messages: [{ author: "bot", messageId: "warning", contentOrigin: "Apology", text: "SYNTHETIC_WARNING" }, sibling] };
  const update = JSON.stringify(wire === "streamhub" ? { type: 2, item: { type: "message_part", argument } } : { type: 1, target: "update", arguments: [argument] });
  rawTerminalFrames = reverse ? ["success", update] : [update, "success"];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text();
  expect(response.status).toBe(streaming ? 200 : 502); expect(text).not.toContain(content); expect(text).not.toContain("SYNTHETIC_WARNING"); expect(text).toContain("error"); expect(attempts).toBe(1);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const invalid of [{ cursor: {} }, { nonce: 4 }, { streamingMode: false }, { requestId: 9 }]) it(`strict rejects malformed message envelope ${wire} stream=${streaming} ${JSON.stringify(invalid)}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire;
  const argument = { messages: [{ author: "bot", contentOrigin: "Apology", text: "SYNTHETIC_WARNING" }], ...invalid };
  rawTerminalFrames = [JSON.stringify(wire === "streamhub" ? { type: 2, item: { type: "message_part", argument } } : { type: 1, target: "update", arguments: [argument] }), "success"];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text(); expect(response.status).toBe(streaming ? 200 : 502); expect(text).not.toContain(content); expect(text).not.toContain("SYNTHETIC_WARNING"); expect(text).toContain("error"); expect(attempts).toBe(1);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) it(`strict sees apology alongside delta ${wire} stream=${streaming}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire;
  const argument = { ...(wire === "streamhub" ? { w: "SYNTHETIC_DELTA" } : { writeAtCursor: "SYNTHETIC_DELTA" }), messages: [{ author: "bot", contentOrigin: "Apology", text: "SYNTHETIC_WARNING" }] };
  rawTerminalFrames = [JSON.stringify(wire === "streamhub" ? { type: 2, item: { type: "message_part", argument } } : { type: 1, target: "update", arguments: [argument] }), "success"];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text(); expect(response.status).toBe(streaming ? 200 : 502); expect(text).not.toContain(content); expect(text).not.toContain("SYNTHETIC_DELTA"); expect(text).not.toContain("SYNTHETIC_WARNING"); expect(text).toContain("error"); expect(attempts).toBe(1);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) it(`strict partial sibling preserves valid apology ${wire} stream=${streaming}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire;
  const argument = { messages: [{ author: "bot", contentOrigin: "Apology", text: "SYNTHETIC_WARNING" }, { messageId: "partial", futureField: { opaque: true } }] };
  rawTerminalFrames = [JSON.stringify(wire === "streamhub" ? { type: 2, item: { type: "message_part", argument } } : { type: 1, target: "update", arguments: [argument] }), "success"];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text();
  expect(response.status).toBe(streaming ? 200 : 502); expect(text).not.toContain(content); expect(text).not.toContain("SYNTHETIC_WARNING"); expect(text).toContain("error"); expect(attempts).toBe(1);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) it(`strict legitimate partial and bot reply ${wire} stream=${streaming}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; payload = "";
  const messages = [{ messageId: "partial", futureField: { opaque: true } }, { author: "bot", messageId: "answer", text: "SYNTHETIC_VALID_ANSWER" }, ...(wire === "streamhub" ? [{ author: null, messageType: "EndOfRequest" }] : [])];
  const argument = { messages }; rawTerminalFrames = [JSON.stringify(wire === "streamhub" ? { type: 2, item: { type: "message_part", argument } } : { type: 1, target: "update", arguments: [argument] }), "success"];
  const pending = request(streaming); await started; release!(); const response = await pending; const text = await response.text(); expect(response.status).toBe(200); expect(text).toContain("SYNTHETIC_VALID_ANSWER"); expect(attempts).toBe(1);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const separate of [false, true]) for (const reverse of [false, true]) for (const malformed of [{ messages: [null] }, { messages: [{ author: "bot", scores: [null] }] }, { messages: [{ author: "bot", scores: {} }] }, { messages: [{ author: "bot", scores: [{ component: "x", score: "bad" }] }] }]) it(`strict rejects nested message corruption ${wire} stream=${streaming} separate=${separate} reverse=${reverse} ${JSON.stringify(malformed)}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; separateRecords = separate;
  const record = wire === "streamhub" ? { type: 2, item: { type: "message_part", argument: malformed } } : { type: 1, target: "update", arguments: [malformed] };
  const invalid = JSON.stringify(record); rawTerminalFrames = reverse ? [invalid, "success"] : ["success", invalid];
  const pending = request(streaming); await started; release!(); const text = await (await pending).text(); expect(text).not.toContain(content); expect(text).toContain("error");
});
it("StreamHub accepts EndOfRequest author null and valid scores", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "streamhub"); transport = "streamhub";
  rawTerminalFrames = [JSON.stringify({ type: 2, item: { type: "message_part", argument: { messages: [{ author: null, messageType: "EndOfRequest" }, { author: "bot", text: "", scores: [{ component: "dea_violation", score: 0.01 }] }] } } }), "success"];
  const pending = request(true); await started; release!(); expect(await (await pending).text()).toContain(content);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const separate of [false, true]) for (const invalid of [
  '{"type":1,"target":"update","arguments":[null]}',
  '{"type":1,"target":"update","arguments":[{"messages":[null]}]}',
  '{"type":1,"target":"update","arguments":[{"messages":[{"author":"bot","scores":[null]}]}]}',
  '{"type":2,"item":{"messages":[{"author":"bot","scores":[null]}],"result":{"value":"Success"}}}',
  '{"type":2,"item":{"type":"message_part","argument":{"messages":[null]}}}',
  '{"type":2,"item":{"type":"message_part","argument":{"messages":[{"author":"bot","scores":[null]}]}}}',
]) it(`independent malformed record settles ${wire} stream=${streaming} separate=${separate} ${invalid}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; separateRecords = separate; rawTerminalFrames = [invalid, "success"];
  const pending = request(streaming); await started; release!(); const text = await (await pending).text(); expect(text).not.toContain(content);
}, 5000);
for (const wire of ["chathub", "streamhub"]) it(`default ignores a non-record without crashing ${wire}`, async () => {
  vi.stubEnv("M365_TRANSPORT", wire); transport = wire; rawTerminalFrames = ["null", "success"];
  const pending = request(true); await started; release!(); expect(await (await pending).text()).toContain(content);
});
for (const wire of ["chathub", "streamhub"]) it(`default keeps malformed-record compatibility ${wire}`, async () => {
  vi.stubEnv("M365_TRANSPORT", wire); transport = wire; rawTerminalFrames = ["{invalid", "success"];
  const pending = request(true); await started; release!(); const text = await (await pending).text(); expect(text).toContain(content);
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const separate of [false, true]) for (const reverse of [false, true]) it(`strict rejects malformed record ${wire} s=${streaming} separate=${separate} reverse=${reverse}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; separateRecords = separate; rawTerminalFrames = reverse ? ["{invalid", "success"] : ["success", "{invalid"];
  const pending = request(streaming); await started; release!(); const text = await (await pending).text(); expect(text).not.toContain(content); expect(text).toContain("error");
});
for (const streaming of [false, true]) for (const detail of [false, true]) it(`strict StreamHub error category Success cannot authorize content s=${streaming} detail=${detail}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "streamhub"); transport = "streamhub";
  rawTerminalFrames = [JSON.stringify({ type: 2, item: { type: "error", errorCategory: "Success", ...(detail ? { detail: content, message: content } : {}) } })];
  const pending = request(streaming); await started; release!(); const text = await (await pending).text(); expect(text).not.toContain(content); expect(text).toContain("error");
});
for (const wire of ["chathub", "streamhub"]) for (const records of [["Success", "ForbiddenRequest"], ["ForbiddenRequest", "Success"], ["Success", "missing"]]) it(`separate WebSocket messages ${wire} ${records.join(",")}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminalRecords = records; separateRecords = true;
  const pending = request(true); await started; release!(); const text = await (await pending).text();
  expect(text).not.toContain(content); expect(text).toContain("error");
});
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) for (const records of [["ForbiddenRequest", "Success"], ["Success", "ForbiddenRequest"], ["Success", "missing"], ["Success"]]) it(`sticky terminal ${wire} stream=${streaming} ${records.join(",")}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminalRecords = records;
  const pending = request(streaming); await started; release!();
  const text = await (await pending).text();
  if (records.length === 1) expect(text).toContain(content);
  else { expect(text).not.toContain(content); expect(text).toContain("error"); }
});
it("strict fails closed on a contradictory terminal refusal following success", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "streamhub"); transport = "streamhub"; contradictoryTerminal = true;
  const pending = request(true); await started; release!();
  const text = await (await pending).text(); expect(text).not.toContain(content); expect(text).toContain("error");
});
for (const mode of ["json", "structured", "text"]) for (const reverse of [false, true]) it(`strict rejects contradictory StreamHub success and ForbiddenRequest error ${mode} reverse=${reverse}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "streamhub"); vi.stubEnv("M365_STREAM_ERROR_MODE", mode === "text" ? "text" : "structured"); transport = "streamhub";
  const error = JSON.stringify({ type: 2, item: { type: "error", errorCategory: "ForbiddenRequest", errorCode: "InvalidCopilotLicense", message: "PRIVATE_CONTRADICTION" } });
  rawTerminalFrames = reverse ? [error, "success"] : ["success", error];
  const pending = request(mode !== "json"); await started; release!(); const response = await pending; const text = await response.text();
  expect(response.status).toBe(mode === "json" ? 502 : 200); expect(text).not.toContain(content); expect(text).not.toContain("PRIVATE_CONTRADICTION"); expect(text).not.toContain("m365_account_not_licensed"); expect(text).toContain("error"); expect(attempts).toBe(1);
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
for (const wire of ["chathub", "streamhub"]) for (const streaming of [false, true]) it(`strict F22 progress retry fences first attempt ${wire} stream=${streaming}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", wire); transport = wire; terminal = "Success"; f22Sequence = true; f22Progress = true;
  const pending = request(streaming, true); await started; release!(); const response = await pending; const text = await response.text(); expect(response.status).toBe(200); expect(attempts).toBe(2); expect(text).not.toContain("F22_PRIVATE_PREFIX"); expect(text.split(content)).toHaveLength(2);
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
for (const stage of ["agent", "image"] as const) it(`normal ${stage} setup reaches the native peer`, async () => {
    vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub"; terminal = "Success";
    if (stage === "agent") vi.stubEnv("M365_FORCE_AGENT", "1");
    setupMocks[stage] = async () => stage === "agent" ? "synthetic-agent" : { type: "synthetic" };
    const body = ChatCompletionRequest.parse({ model: "claude-sonnet", stream: true,
      messages: [{ role: "user", content: stage === "image" ? [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] : "hi" }],
      ...(stage === "agent" ? { tools: [{ type: "function", function: { name: "bash", description: "shell", parameters: { type: "object", properties: {} } } }] } : {}) });
    try {
      started = new Promise(r => { seen = r; });
      const pending = handleChatCompletion(body, new SessionPool({ getToken: async () => token, useAgent: stage === "agent" }));
      await started; release!(); const text = await (await pending).text(); expect(text).toContain(content); expect(attempts).toBe(1);
    } finally { setupMocks[stage] = null; }
  });
for (const stage of ["agent", "image"] as const) it(`strict deadline bounds an uncooperative ${stage} setup`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub");
  const original = AbortSignal.timeout; const shorten = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => original(ms === 180_000 ? 30 : ms));
  let releaseStage!: (value: any) => void; let entered!: () => void;
  const ready = new Promise<void>(r => { entered = r; }); const wait = new Promise<any>(r => { releaseStage = r; });
  setupMocks[stage] = () => { entered(); return wait; };
  if (stage === "agent") vi.stubEnv("M365_FORCE_AGENT", "1");
  const body = ChatCompletionRequest.parse({ model: "claude-sonnet", stream: false,
    messages: [{ role: "user", content: stage === "image" ? [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] : "hi" }],
    ...(stage === "agent" ? { tools: [{ type: "function", function: { name: "bash", description: "shell", parameters: { type: "object", properties: {} } } }] } : {}) });
  const bounded = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("setup did not honor deadline")), 500))]);
  try {
    const pending = handleChatCompletion(body, new SessionPool({ getToken: async () => token, useAgent: stage === "agent" }));
    await bounded(ready); const response = await bounded(pending); expect(response.status).toBe(502); expect(attempts).toBe(0);
    releaseStage(null); await new Promise<void>(r => setTimeout(r, 30)); expect(attempts).toBe(0); expect(server.clients.size).toBe(0);
  } finally { setupMocks[stage] = null; releaseStage(null); shorten.mockRestore(); }
}, 2000);
for (const stage of ["agent", "image", "file"] as const) for (const streaming of [false, true]) for (const failure of ["abort", "expire"] as const) it(`strict setup admission ${stage} stream=${streaming} ${failure}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub"); transport = "chathub"; vi.stubEnv("M365_FORCE_AGENT", "1");
  let now = 0; const time = vi.spyOn(performance, "now").mockImplementation(() => now); const abort = new AbortController();
  let tokenCalls = 0; let stageCalls = 0; let enter!: () => void; let releaseToken!: (s: string) => void;
  const ready = new Promise<void>(r => { enter = r; }); const gate = new Promise<string>(r => { releaseToken = r; });
  setupMocks[stage] = () => { stageCalls++; throw new Error("unexpected setup"); };
  const url = stage === "file" ? "data:application/pdf;base64,AA==" : "data:image/png;base64,AA==";
  const body = ChatCompletionRequest.parse({ model: "claude-sonnet", stream: streaming, messages: [{ role: "user", content: stage === "agent" ? "hi" : [{ type: "text", text: "hi" }, { type: "image_url", image_url: { url } }] }],
    ...(stage === "agent" ? { tools: [{ type: "function", function: { name: "bash", description: "shell", parameters: { type: "object", properties: {} } } }] } : {}) });
  try {
    const pending = handleChatCompletion(body, new SessionPool({ getToken: () => { tokenCalls++; enter(); return gate; }, useAgent: true }), { signal: abort.signal });
    await ready; if (failure === "abort") abort.abort(); else now = 180_001; releaseToken(token);
    const text = await (await pending).text(); expect(text).toContain("error"); expect(tokenCalls).toBe(1); expect(stageCalls).toBe(0); expect(attempts).toBe(0); expect(server.clients.size).toBe(0);
  } finally { setupMocks[stage] = null; releaseToken(token); time.mockRestore(); }
});
for (const streaming of [false, true]) for (const failure of ["abort", "expire"] as const) it(`strict initial token admission stream=${streaming} ${failure}`, async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); const abort = new AbortController(); let calls = 0; let clockCalls = 0;
  if (failure === "abort") abort.abort();
  const clock = vi.spyOn(performance, "now").mockImplementation(() => failure === "expire" && ++clockCalls > 1 ? 180_001 : 0);
  try {
    const response = await request(streaming, false, { signal: abort.signal, getToken: () => { calls++; throw new Error("unexpected call"); } });
    const text = await response.text(); expect(text).toContain("error"); expect(calls).toBe(0); expect(attempts).toBe(0);
  } finally { clock.mockRestore(); }
});
it("pre-aborted strict handler never invokes a synchronously throwing token provider", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); const abort = new AbortController(); abort.abort(); let calls = 0;
  const response = await request(false, false, { signal: abort.signal, getToken: () => { calls++; throw new Error("unexpected call"); } });
  expect(response.status).toBeGreaterThanOrEqual(400); expect(calls).toBe(0); expect(attempts).toBe(0);
});
it("strict deadline bounds an uncooperative token resolver", async () => {
  vi.stubEnv("M365_STRICT_STREAM", "1"); vi.stubEnv("M365_TRANSPORT", "chathub");
  const original = AbortSignal.timeout;
  const shorten = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => original(ms === 180_000 ? 30 : ms));
  let releaseToken!: (s: string) => void; let entered!: () => void;
  const enteredP = new Promise<void>(r => { entered = r; }); const tokenP = new Promise<string>(r => { releaseToken = r; });
  const bounded = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("token did not honor deadline")), 500))]);
  try {
    const pending = request(false, false, { getToken: () => { entered(); return tokenP; } }); await bounded(enteredP);
    const response = await bounded(pending); expect(response.status).toBe(502); expect(attempts).toBe(0);
    releaseToken(token); await new Promise<void>(r => setTimeout(r, 30)); expect(attempts).toBe(0); expect(server.clients.size).toBe(0);
  } finally { shorten.mockRestore(); releaseToken(token); }
}, 2000);
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
