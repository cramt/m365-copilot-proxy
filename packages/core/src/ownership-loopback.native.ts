import { it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const peer = vi.hoisted(() => ({ path: "" }));
vi.mock("ws", async load => {
  const actual = await load<typeof import("ws")>();
  return { ...actual, default: class extends actual.default {
    constructor(_url: any, options: any) { super(`ws+unix://${peer.path}:/`, options); }
  } };
});
import { createApp } from "../../proxy-lib/src/index.js";
const A = "11111111-1111-1111-1111-111111111111", B = "22222222-2222-2222-2222-222222222222";
const token = (oid: string) => `e30.${Buffer.from(JSON.stringify({ tid: A, oid, aud: "test", iss: "test", exp: 9999999999 })).toString("base64url")}.sig`;

it("real loopback A→B placement replays full lineage, then B continues and keyed requests replay", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ownership-loop-"));
  peer.path = join(dir, "socket");
  process.env.M365_ACCOUNT_POLICY_PATH = join(dir, "state.sqlite");
  const http = createServer(), wss = new WebSocketServer({ server: http });
  const prompts: string[] = []; const starts: boolean[] = []; const ids: string[] = [];
  wss.on("connection", ws => ws.on("message", bytes => {
    for (const raw of bytes.toString().split("\x1e").filter(Boolean)) {
      const msg = JSON.parse(raw);
      if (msg.protocol) { ws.send("{}\x1e"); continue; }
      if (msg.target !== "chat") continue;
      const arg = msg.arguments[0]; prompts.push(arg.message.text); starts.push(arg.isStartOfSession); ids.push(arg.sessionId);
      ws.send(JSON.stringify({ type: 1, target: "update", arguments: [{ messages: [{ author: "bot", text: "visible answer", messageId: "m" }] }] }) + "\x1e");
      ws.send(JSON.stringify({ type: 2, item: { result: { value: "Success" } } }) + "\x1e");
    }
  }));
  await new Promise<void>(resolve => http.listen(peer.path, resolve));
  try {
    let oid = A;
    const app = createApp({ useAgent: false, getToken: async () => token(oid) });
    const messages: any[] = [{ role: "user", content: "first question" }];
    const request = (key: string) => app.fetch(new Request("http://local/v1/chat/completions", { method: "POST", headers: { "idempotency-key": key, "x-opencode-session": "s" }, body: JSON.stringify({ model: "gpt-5.6", messages }) }));
    const one = await request("one"); expect(one.status).toBe(200); const answer = (await one.json()).choices[0].message;
    messages.push(answer, { role: "user", content: "second question" }); oid = B;
    const two = await request("two"); expect(two.status).toBe(200); const answer2 = (await two.json()).choices[0].message;
    expect(prompts[1]).toContain("first question"); expect(prompts[1]).toContain("visible answer"); expect(ids[1]).not.toBe(ids[0]);
    messages.push(answer2, { role: "user", content: "third question" });
    const three = await request("three"); expect(three.status).toBe(200); const bytes = await three.text();
    expect((await request("three")).status).toBe(200); expect(await (await request("three")).text()).toBe(bytes);
    expect(prompts).toHaveLength(3); expect(ids[2]).toBe(ids[1]); expect(starts).toEqual([true, true, false]);
    expect(prompts[2]).toContain("third question"); expect(prompts[2]).not.toContain("first question");
  } finally {
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    delete process.env.M365_ACCOUNT_POLICY_PATH; rmSync(dir, { recursive: true, force: true });
  }
});
