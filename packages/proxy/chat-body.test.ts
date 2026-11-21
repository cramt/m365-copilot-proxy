import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The route is exercised through the real cors.ts middleware, in Nitro's order
// (global middleware, then the route), over a real socket.
const handled = vi.hoisted(() => vi.fn(async () => Response.json({ ok: true })));
vi.mock("@m365-copilot/proxy-lib", async (importActual) => ({
  ...(await importActual<typeof import("@m365-copilot/proxy-lib")>()),
  handleChatCompletion: handled,
}));

const ORIGIN = "https://app.example";
const here = dirname(fileURLToPath(import.meta.url));
let server: Server;
let port: number;

beforeAll(async () => {
  process.env.M365_CORS_ORIGIN = ORIGIN;
  process.env.M365_MAX_REQUEST_BYTES = "1000";
  process.env.M365_REQUEST_BODY_TIMEOUT_MS = "150";
  // h3 is nitropack's dependency; Nitro auto-imports its helpers into routes.
  const nitro = realpathSync(join(here, "node_modules/nitropack"));
  const h3 = await import(pathToFileURL(createRequire(join(nitro, "package.json")).resolve("h3")).href);
  Object.assign(globalThis, h3);
  const app = h3.createApp();
  app.use((await import("./middleware/cors")).default);
  app.use("/v1/chat/completions", (await import("./routes/v1/chat/completions.post")).default);
  server = createServer(h3.toNodeListener(app));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
}, 30_000); // loading the route loads the whole proxy: past the default 10 s in a full parallel run
afterAll(() => { server.close(); });

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body,
  });
const valid = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });

describe("POST /v1/chat/completions body handling", () => {
  it("passes the client's user-agent through to the handler", async () => {
    const res = await post(valid, { "user-agent": "pi/1.2" });
    expect(res.status).toBe(200);
    expect(handled).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: "gpt-5.5-think-deeper" }),
      expect.anything(),
      expect.objectContaining({ userAgent: "pi/1.2" }),
    );
  });

  it("still answers a schema-invalid body with the zod message and a 400", async () => {
    const res = await post(JSON.stringify({ messages: [] }));
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.type).toBe("invalid_request_error");
    expect(error.message).toContain("messages");
    expect(error.message).toContain("Too small");
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
  });

  it("answers malformed JSON and invalid UTF-8 with a 400", async () => {
    const json = await post("{nope");
    expect(json.status).toBe(400);
    expect((await json.json()).error.message).toBe("Invalid JSON body");
    const utf8 = await post(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]));
    expect(utf8.status).toBe(400);
    expect((await utf8.json()).error.message).toBe("Invalid UTF-8 body");
  });

  it("answers an oversize body with a 413 that carries the CORS headers", async () => {
    const res = await post(JSON.stringify({ messages: [{ role: "user", content: "x".repeat(2000) }] }));
    expect(res.status).toBe(413);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect((await res.json()).error.type).toBe("invalid_request_error");
  });

  it("answers a body that stops arriving with a 408 that carries the CORS headers", async () => {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      let text = "";
      socket.on("data", (d) => { text += d; });
      socket.on("close", () => resolve(text));
      socket.on("error", reject);
      socket.write(
        `POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nOrigin: ${ORIGIN}\r\n` +
        "Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"messages\":",
      );
    });
    expect(reply).toMatch(/^HTTP\/1\.1 408 /);
    expect(reply.toLowerCase()).toContain(`access-control-allow-origin: ${ORIGIN}`);
  });
});
