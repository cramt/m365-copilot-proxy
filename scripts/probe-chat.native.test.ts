import { afterAll, expect, it, vi } from "vitest";
import { once } from "node:events";

const transport = vi.hoisted(() => ({ url: "" }));
// Preserve real WS framing/connection lifecycle; redirect only the endpoint.
vi.mock("../node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs", async (original) => {
  const ws = await original<any>();
  return { ...ws, default: class extends ws.default {
    constructor(_url: string, options: object) { super(transport.url, options); }
  } };
});
// @ts-expect-error ws's wrapper does not ship declarations at this store path.
const { WebSocketServer } = await import("../node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs");
// @ts-expect-error The probe is a JavaScript entrypoint.
const { oneTurn } = await import("./_probe-chat.mjs");
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
transport.url = `ws://127.0.0.1:${server.address().port}`;
const chats: any[] = [];
server.on("connection", (socket: any) => {
  socket.on("message", (data: Buffer) => {
    for (const frame of data.toString().split("\x1e").filter(Boolean).map((f) => JSON.parse(f))) {
      if (frame.protocol) socket.send("{}\x1e");
      if (frame.target === "chat") {
        chats.push(frame);
        if (frame.arguments[0].message.text === "drop") socket.terminate();
        else socket.send(JSON.stringify({ type: 2, item: { result: { value: "Success" }, messages: [{ author: "bot", text: "synthetic reply" }] } }) + "\x1e");
      }
    }
  });
});
afterAll(async () => { for (const socket of server.clients) socket.terminate(); await new Promise<void>((resolve) => server.close(resolve)); vi.unstubAllEnvs(); });

it("exercises actual oneTurn over a real local WS peer, charging failed/successful retries and refusing the third dispatch", async () => {
  vi.stubEnv("M365_PROBE_MAX_ATTEMPTS", "2");
  const claims = { aud: "synthetic", iss: "synthetic", tid: "11111111-1111-1111-1111-111111111111", oid: "22222222-2222-2222-2222-222222222222", exp: 2000000000 };
  const input = { token: `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`, claims, timeoutMs: 1000 };
  const dropped = await oneTurn({ ...input, text: "drop" });
  expect(chats).toHaveLength(1);
  const success = await oneTurn({ ...input, text: "reply" });
  expect(success.fullText).toBe("synthetic reply");
  expect(chats).toHaveLength(2);
  const refused = await oneTurn({ ...input, text: "over cap" });
  expect(chats).toHaveLength(2);
  expect(refused.error).toBe("probe run cap reached");
  expect(refused.attempted).toBe(false);
  expect(dropped.attempted).toBe(true);
  expect(success.attempted).toBe(true);
});
