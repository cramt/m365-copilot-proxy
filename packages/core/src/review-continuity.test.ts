import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

// Exercise the real WebSocket implementation, but force every client connection
// onto our private Unix socket rather than allowing an upstream network request.
const peer = vi.hoisted(() => ({ path: "", clients: [] as import("ws").WebSocket[] }));
vi.mock("ws", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ws")>();
  return {
    ...actual,
    default: class LoopbackWebSocket extends actual.default {
      constructor(_url: string, options: import("ws").ClientOptions) {
        super(`ws+unix://${peer.path}:/`, options);
        peer.clients.push(this);
      }
    },
  };
});

import { ModelSession } from "./model.js";

const RS = "\x1e";
const syntheticToken = `e30.${Buffer.from(JSON.stringify({
  tid: "11111111-1111-1111-1111-111111111111",
  oid: "22222222-2222-2222-2222-222222222222",
  aud: "synthetic",
  iss: "synthetic",
  exp: 9999999999,
})).toString("base64url")}.sig`;

it.each(["chathub", "streamhub"] as const)(
  "%s keeps same-conversation resets as continuations and starts a new conversation afresh",
  async (transport) => {
    const directory = mkdtempSync(join(tmpdir(), "continuity-"));
    const previousPolicyPath = process.env.M365_ACCOUNT_POLICY_PATH;
    const previousTransport = process.env.M365_TRANSPORT;
    peer.path = join(directory, "socket");
    peer.clients = [];
    process.env.M365_ACCOUNT_POLICY_PATH = join(directory, "policy.sqlite");
    process.env.M365_TRANSPORT = transport;

    const server = createServer();
    const websocketServer = new WebSocketServer({ server });
    const starts: boolean[] = [];
    const conversations: string[] = [];
    websocketServer.on("connection", (socket) => {
      socket.on("message", (data) => {
        for (const raw of data.toString().split(RS).filter(Boolean)) {
          const frame = JSON.parse(raw);
          if (frame.protocol) {
            socket.send(`{}${RS}`);
            continue;
          }
          const request = frame.item?.type === "chat_request"
            ? frame.item.chatStreamRequest
            : frame.target === "chat" ? frame.arguments[0] : null;
          if (!request) continue;
          starts.push(request.isStartOfSession);
          const requestId = request.requestId ?? request.message?.requestId;
          const reply = frame.item
            ? { type: 2, invocationId: "1", item: { type: "request_end", requestId, outcome: { category: "Success" } } }
            : { type: 2, item: { result: { value: "Success" } } };
          socket.send(JSON.stringify(reply) + RS);
        }
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(peer.path, () => { server.off("error", reject); resolve(); });
      });
      const model = new ModelSession({ useAgent: false, getToken: async () => syntheticToken });
      for (let turn = 0; turn < 3; turn++) {
        if (turn === 1) model.reset();
        if (turn === 2) model.newConversation();
        conversations.push(model.conversationId);
        const stream = await model.run("hello", "gpt-5.6", undefined, false);
        for await (const _delta of stream) { /* Drain the real stream before the next turn. */ }
      }

      expect(starts).toEqual([true, false, true]);
      expect(conversations[1]).toBe(conversations[0]);
      expect(conversations[2]).not.toBe(conversations[0]);
      expect(peer.clients).toHaveLength(3);
    } finally {
      // Wait for both ends of every connection before closing the listening
      // server and removing the SQLite store and socket directory.
      try {
        const closed = peer.clients.map((client) => client.readyState === client.CLOSED
          ? Promise.resolve()
          : new Promise<void>((resolve) => { client.once("close", () => resolve()); client.terminate(); }));
        for (const socket of websocketServer.clients) socket.terminate();
        await Promise.all(closed);
        await new Promise<void>((resolve, reject) => websocketServer.close((error) => error ? reject(error) : resolve()));
        if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      } finally {
        peer.path = "";
        peer.clients = [];
        if (previousPolicyPath === undefined) delete process.env.M365_ACCOUNT_POLICY_PATH;
        else process.env.M365_ACCOUNT_POLICY_PATH = previousPolicyPath;
        if (previousTransport === undefined) delete process.env.M365_TRANSPORT;
        else process.env.M365_TRANSPORT = previousTransport;
        rmSync(directory, { recursive: true, force: true });
      }
    }
  },
);
