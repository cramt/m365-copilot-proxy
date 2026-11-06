import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const h3 = await import(require.resolve("h3", { paths: [fileURLToPath(import.meta.resolve("nitropack"))] }));
const observed = vi.hoisted(() => ({ current: undefined as undefined | { signal?: AbortSignal; turns: number; health: number; completed: number; healthBeforeCompletion: boolean; gate: Promise<void>; release: () => void; tasks: Set<Promise<unknown>> } }));
function fixture(held = false) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const state = { signal: undefined as AbortSignal | undefined, turns: 0, health: 0, completed: 0, healthBeforeCompletion: false, gate, release, tasks: new Set<Promise<unknown>>() };
  if (!held) release();
  observed.current = state;
  return state;
}
let state: ReturnType<typeof fixture>;
beforeEach(() => { state = fixture(); });
vi.stubGlobal("defineEventHandler", h3.defineEventHandler);
vi.stubGlobal("readBody", h3.readBody);
vi.stubGlobal("getHeader", h3.getHeader);
vi.mock("@m365-copilot/proxy-lib", async (original) => ({
  ...await original<typeof import("@m365-copilot/proxy-lib")>(),
  handleChatCompletion: async (_body: unknown, _pool: unknown, { signal }: { signal: AbortSignal }) => {
    const owner = observed.current!;
    owner.turns++;
    owner.signal = signal;
    const task = (async () => {
      await owner.gate;
      owner.completed++;
      return Response.json({ aborted: signal.aborted });
    })();
    owner.tasks.add(task);
    try { return await task; } finally { owner.tasks.delete(task); }
  },
}));
const ingress = (await import("./middleware/00-ingress.js")).default;
const route = (await import("./routes/v1/chat/completions.post.js")).default;
let server: Server;
afterEach(async () => {
  state.release();
  await Promise.all(state.tasks);
  vi.unstubAllEnvs();
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
async function send(payload: string | Buffer, drip = false) {
  const owner = state;
  const app = h3.createApp();
  app.use(ingress);
  const router = h3.createRouter({ preemptive: true });
  router.post("/v1/chat/completions", route);
  router.get("/health", h3.defineEventHandler(() => { owner.health++; owner.healthBeforeCompletion = owner.completed === 0; owner.release(); return "reused"; }));
  app.use(router.handler);
  server = createServer(h3.toNodeListener(app));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  return new Promise<string>((resolve, reject) => {
    const socket = connect(address.port, "127.0.0.1");
    let result = "";
    let interval: ReturnType<typeof setInterval> | undefined;
    let writeError: Error | undefined;
    let eof = false;
    const stop = () => { clearInterval(interval); };
    const timeout = setTimeout(() => { stop(); socket.destroy(); reject(new Error("HTTP response/EOF deadline missing")); }, 1200);
    socket.on("connect", () => {
      socket.write(payload);
      if (drip) interval = setInterval(() => {
        if (socket.destroyed || socket.writableEnded || eof) { stop(); return; }
        socket.write("1\r\n \r\n", error => { if (error) { writeError = error; stop(); } });
      }, 5);
    });
    socket.on("data", chunk => { result += chunk.toString(); if (drip) stop(); });
    socket.on("end", () => { eof = true; stop(); });
    socket.on("error", error => { writeError = error; stop(); });
    socket.on("close", () => {
      clearTimeout(timeout); stop();
      if (!eof) reject(writeError ?? new Error("HTTP response closed without readable EOF"));
      else if (writeError) reject(writeError);
      else resolve(result);
    });
  });
}
it("native H3 sends 413 before closing unread HTTP1 upload and never reuses pipelined bytes", async () => {
  vi.stubEnv("M365_MAX_REQUEST_BYTES", "8");
  const result = await send("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\n{}GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n");
  expect(result).toMatch(/^HTTP\/1\.1 413/);
  expect(result.toLowerCase()).toContain("connection: close");
  expect(result).toContain("request_too_large");
  expect(result).not.toContain("reused");
  expect(result).toMatch(/0\r\n\r\n$/);
  expect(state.health).toBe(0);
  expect(state.turns).toBe(0);
});
it("native H3 bounds continuous chunked upload by total deadline and sends 408 before EOF", async () => {
  vi.stubEnv("M365_REQUEST_BODY_TIMEOUT_MS", "40");
  const result = await send("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n", true);
  expect(result).toMatch(/^HTTP\/1\.1 408/);
  expect(result).toContain("request_body_timeout");
  expect(result.toLowerCase()).toContain("connection: close");
  expect(result).toMatch(/0\r\n\r\n$/);
  expect(state.health).toBe(0);
  expect(state.turns).toBe(0);
});
it("native completed upload close is not a disconnect while handler is running", async () => {
  const body = JSON.stringify({ model: "m365-copilot", messages: [{ role: "user", content: "hello" }] });
  const result = await send(`POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  expect(result).toContain("200");
  expect(result).toContain('"aborted":false');
});
it("native H3 aborts the turn when the peer disconnects after a completed upload", async () => {
  state = fixture(true);
  const app = h3.createApp();
  app.use(ingress);
  app.use("/v1/chat/completions", route);
  server = createServer(h3.toNodeListener(app));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  const socket = connect(address.port, "127.0.0.1");
  socket.on("error", () => {});
  const text = JSON.stringify({ model: "m365-copilot", messages: [{ role: "user", content: "hello" }] });
  await new Promise<void>(resolve => socket.once("connect", resolve));
  socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  await vi.waitFor(() => expect(state.signal).toBeDefined(), { interval: 1 });
  expect(state.signal!.aborted).toBe(false);
  socket.destroy();
  await vi.waitFor(() => expect(state.signal!.aborted).toBe(true), { interval: 1 });
});
it("fixture isolation: disconnected mock must not mutate next fixture counters", async () => {
  state = fixture(true);
  const retired = state;
  const app = h3.createApp(); app.use(ingress); app.use("/v1/chat/completions", route);
  server = createServer(h3.toNodeListener(app));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  const socket = connect(address.port, "127.0.0.1");
  await new Promise<void>(resolve => socket.once("connect", resolve));
  const body = JSON.stringify({ model: "m365-copilot", messages: [{ role: "user", content: "hello" }] });
  socket.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  await vi.waitFor(() => expect(state.signal).toBeDefined(), { interval: 1 });
  socket.destroy();
  await vi.waitFor(() => expect(state.signal!.aborted).toBe(true), { interval: 1 });
  state = fixture();
  retired.release();
  await Promise.all(retired.tasks);
  expect(retired.completed).toBe(1);
  expect(state.completed).toBe(0);
  expect(state.turns).toBe(0);
});
it("native H3 counts chunked bytes without Content-Length", async () => {
  vi.stubEnv("M365_MAX_REQUEST_BYTES", "8");
  const result = await send("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n9\r\n123456789\r\n");
  expect(result).toContain("413");
  expect(result).toContain("request_too_large");
});
it("native H3 rejects invalid JSON with terminal 400", async () => {
  const result = await send("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1\r\n\r\n{");
  expect(result).toContain("400");
  expect(result).toContain("invalid_request_body");
  expect(result.toLowerCase()).toContain("x-should-retry: false");
});
it("native adapter removes body listeners on cancellation and successful EOF", async () => {
  const { PassThrough } = await import("node:stream");
  const { incomingRequestBody } = await import("./incoming-body.js");
  for (const cancel of [false, true]) {
    const req = new PassThrough();
    const events = ["data", "end", "error", "aborted", "close"];
    const counts = events.map(event => req.listenerCount(event));
    const stream = incomingRequestBody(req as unknown as import("node:http").IncomingMessage);
    if (cancel) await stream.cancel();
    else {
      req.end(Buffer.from("{}"));
      const reader = stream.getReader();
      while (!(await reader.read()).done) { /* drain */ }
      reader.releaseLock();
    }
    expect(events.map(event => req.listenerCount(event))).toEqual(counts);
    if (cancel) expect(req.destroyed).toBe(false);
    req.destroy();
  }
});

const validBody = JSON.stringify({ model: "m365-copilot", messages: [{ role: "user", content: "hello" }] });
const post = (body: string | Buffer, close = false, path = "/v1/chat/completions") => Buffer.concat([
  Buffer.from(`POST ${path} HTTP/1.1\r\nHost: localhost\r\n${close ? "Connection: close\r\n" : ""}Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`), Buffer.from(body),
]);
for (const path of ["/v1/chat/completions", "/v1/chat/completions/", "/v1/chat/completions/?x=1", "/v1/chat/%63ompletions"]) {
for (const [name, body] of [["malformed JSON", Buffer.from("{")], ["strict UTF8", Buffer.from([0xff])], ["schema error", Buffer.from("{}")]] as const) {
  for (const second of ["health", "chat"]) it(`${path} ${name} fences actual second ${second} execution`, async () => {
    const result = await send(Buffer.concat([post(body, false, path), second === "health"
      ? Buffer.from("GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n") : post(validBody, true)]));
    expect(state.health).toBe(0);
    expect(state.turns).toBe(0);
    expect(result).toMatch(/^HTTP\/1\.1 400/);
    expect(result).toContain("invalid_request_body");
    expect(result.toLowerCase()).toContain("x-should-retry: false");
    expect(result.toLowerCase()).toContain("connection: close");
    expect(result.match(/HTTP\/1\.1/g)).toHaveLength(1);
    expect(result).toMatch(/0\r\n\r\n$/);
  });
}
it(`${path} successful admission opens later routes before inference completes`, async () => {
  state = fixture(true);
  const result = await send(Buffer.concat([post(validBody, false, path), Buffer.from("GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")]));
  expect(state.health).toBe(1);
  expect(state.healthBeforeCompletion).toBe(true);
  expect(state.turns).toBe(1);
  expect(result.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
});
it(`${path} valid pipelined chat requests both execute`, async () => {
  const result = await send(Buffer.concat([post(validBody, false, path), post(validBody, true, path)]));
  expect(state.turns).toBe(2);
  expect(result.match(/HTTP\/1\.1 200/g)).toHaveLength(2);
});
for (const count of [16, 17]) it(`${path} admits exactly 16 pending waiters: ${count}`, async () => {
  const requests = Array.from({ length: count }, (_, i) => `GET /health HTTP/1.1\r\nHost: localhost\r\n${i === count - 1 ? "Connection: close\r\n" : ""}\r\n`).join("");
  const result = await send(Buffer.concat([post(validBody, false, path), Buffer.from(requests)]));
  expect(state.health).toBe(count === 16 ? 16 : 0);
  expect(state.turns).toBe(count === 16 ? 1 : 0);
  expect(result.match(/HTTP\/1\.1 /g)).toHaveLength(count === 16 ? 17 : 1);
  expect(result).toMatch(count === 16 ? /^HTTP\/1\.1 200/ : /^HTTP\/1\.1 400/);
});
}
for (const path of ["/v1/chat/completions//", "/v1//chat/completions", "/v1/chat%2fcompletions", "/v1/chat%2Fcompletions", "/v1/chat/%2563ompletions", "/v1/chat/../chat/completions"]) it(`router does not normalize ${path} into chat`, async () => {
  const result = await send(post(validBody, true, path));
  expect(result).toMatch(/^HTTP\/1\.1 404/);
  expect(state.turns).toBe(0);
});
it("deep pipeline is bounded and fails closed without downstream handlers", async () => {
  const result = await send(Buffer.concat([post(validBody), Buffer.from("GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n".repeat(100))]));
  expect(state.health).toBe(0);
  expect(state.turns).toBe(0);
  expect(result).toMatch(/^HTTP\/1\.1 400/);
});

it("sequential keepalive admits a later ordinary request", async () => {
  const { request } = await import("node:http");
  const { Agent } = await import("node:http");
  const app = h3.createApp();
  app.use(ingress); app.use("/v1/chat/completions", route);
  app.use("/health", h3.defineEventHandler(() => "healthy"));
  server = createServer(h3.toNodeListener(app));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  const call = (path: string, body?: string) => new Promise<{ text: string; socket: unknown }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: address.port, path, agent, method: body ? "POST" : "GET", headers: body ? { "Content-Length": Buffer.byteLength(body) } : {} }, res => {
      const socket = res.socket;
      let text = ""; res.on("data", chunk => { text += chunk; });
      res.on("end", () => resolve({ text, socket })); res.on("error", reject);
    });
    req.on("error", reject); req.end(body);
  });
  try {
    const first = await call("/v1/chat/completions", validBody);
    const second = await call("/health");
    expect(first.text).toContain('"aborted":false');
    expect(second.text).toBe("healthy");
    expect(second.socket).toBe(first.socket);
  } finally { agent.destroy(); }
});
it("disconnect during pending admission releases upload listeners and never dispatches", async () => {
  state.turns = 0;
  const app = h3.createApp(); app.use(ingress); app.use("/v1/chat/completions", route);
  server = createServer(h3.toNodeListener(app));
  let incoming: import("node:http").IncomingMessage | undefined;
  server.on("request", req => { incoming = req; });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no TCP address");
  const socket = connect(address.port, "127.0.0.1"); socket.on("error", () => {});
  await new Promise<void>(resolve => socket.once("connect", resolve));
  socket.write("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1000\r\n\r\n{");
  await vi.waitFor(() => expect(incoming).toBeDefined(), { interval: 1 });
  socket.destroy();
  await vi.waitFor(() => expect(incoming!.listenerCount("aborted")).toBe(0), { interval: 1 });
  expect(incoming!.listenerCount("data")).toBe(0);
  expect(state.turns).toBe(0);
});
