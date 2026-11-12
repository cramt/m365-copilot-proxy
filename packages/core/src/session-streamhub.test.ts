import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// A stand-in for `ws`: answers the SignalR handshake, records what the session
// sends, and plays the scripted server frames once the chat_request arrives.
const fake = vi.hoisted(() => {
  const RS = "\x1e";
  const state = { sockets: [] as any[], script: [] as unknown[] };
  class FakeWs {
    static OPEN = 1;
    readyState = 1;
    sent: any[] = [];
    private handlers: Record<string, ((...a: any[]) => void)[]> = {};
    constructor(public url: string, public opts: { headers: Record<string, string> }) {
      state.sockets.push(this);
      setTimeout(() => this.emit("open"), 0);
    }
    on(ev: string, fn: (...a: any[]) => void) {
      (this.handlers[ev] ??= []).push(fn);
      return this;
    }
    emit(ev: string, ...a: any[]) {
      for (const fn of this.handlers[ev] ?? []) fn(...a);
    }
    send(data: string) {
      for (const f of data.split(RS).filter(Boolean)) {
        const frame = JSON.parse(f);
        this.sent.push(frame);
        if (frame.protocol === "json") setTimeout(() => this.emit("message", Buffer.from("{}" + RS)), 0);
        if (frame.item?.type === "chat_request") {
          // `$RID` in a scripted frame stands for this turn's request id.
          const rid = frame.item.chatStreamRequest.requestId;
          state.script.forEach((s, i) => setTimeout(() => {
            if (this.readyState === 1) this.emit("message", Buffer.from(JSON.stringify(s).replaceAll("$RID", rid) + RS));
          }, i + 1));
        }
      }
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close");
    }
  }
  return { state, FakeWs };
});
vi.mock("ws", () => ({ default: fake.FakeWs }));

import { CopilotSession } from "./session.js";

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const TOKEN = `${b64({ alg: "none" })}.${b64({ aud: "https://substrate.office.com/sydney", iss: "test", oid: "oid-1", tid: "tid-1", exp: 9999999999 })}.sig`;

const item = (it: object) => ({ type: 2, invocationId: "1", item: it });
const part = (argument: object, requestId = "$RID") => item({ type: "message_part", target: "update", requestId, argument });
const cursor = (id: string) => ({ j: `$['${id}'].adaptiveCards[0].body[0].text`, p: -1 });
const restate = (id: string, requestId = "$RID") => part({ cursor: cursor(id), messages: [{ author: "bot", text: "", contentOrigin: "DeepLeo", messageId: id }] }, requestId);
const endOf = (requestId: string) => item({ type: "request_end", requestId, outcome: { category: "Success" } });
const end = endOf("$RID");

async function turn(session: CopilotSession, script: unknown[], text = "hi") {
  fake.state.script = script;
  const stream = await session.chat(TOKEN, text, "gpt-6.1-sol");
  const streamed: string[] = [];
  for await (const d of stream) streamed.push(d);
  const ws = fake.state.sockets[fake.state.sockets.length - 1];
  const items = ws.sent.filter((f: any) => f.type === 2).map((f: any) => f.item);
  return { stream, streamed, ws, items };
}

describe("CopilotSession over StreamHub", () => {
  beforeAll(() => { process.env.M365_TRANSPORT = "streamhub"; });
  afterAll(() => { delete process.env.M365_TRANSPORT; });
  afterEach(() => { fake.state.sockets.length = 0; });

  it("keeps a restated message's text once — the live long-answer shape", async () => {
    // 2026-11-11 dump (GPT-6.1 Sol, 250-word story): deltas, then a second
    // cursor frame restating the message as "" and ONE delta with the whole text.
    const { stream, streamed, ws, items } = await turn(new CopilotSession(), [
      item({ type: "network_info", networkInfo: {} }),
      part({ messages: [{ author: "bot", text: "Putting it together…", messageType: "Progress", contentOrigin: "EarlyProgress", messageId: "p1" }] }),
      part({ throttling: { maxNumUserMessagesInConversation: 600, numUserMessagesInConversation: 1, numLongDocSummaryUserMessagesInConversation: 0 } }),
      restate("m1"),
      part({ w: "Every evening, " }),
      part({ w: "Mara climbed" }),
      restate("m1"),
      part({ w: "Every evening, Mara climbed the stairs." }),
      part({ patches: [{ op: "replace", path: "/m1/metadata", value: {} }], isLastUpdate: true }),
      item({ type: "answer_complete", requestId: "$RID" }),
      end,
    ]);

    expect(stream.fullText).toBe("Every evening, Mara climbed the stairs.");
    expect(streamed.join("")).toBe("Every evening, Mara climbed the stairs.");
    expect(stream.result).toEqual({ value: "Success" });
    expect(stream.throttle).toEqual({ current: 1, max: 600 });

    const url = new URL(ws.url);
    expect(url.host).toBe("substrate.svc.cloud.microsoft");
    expect(url.pathname).toBe("/m365Copilot/StreamHub/oid-1@tid-1");
    expect(url.searchParams.get("disableMemory")).toBe("1");
    expect(url.searchParams.get("XRoutingParameterSessionKey")).toBe("oid-1");
    expect(url.searchParams.get("scenario")).toBe("officeweb");
    expect(ws.opts.headers.Origin).toBe("https://copilot.cloud.microsoft");
    expect(ws.sent.some((f: any) => f.type === 4 && f.target === "stream" && f.invocationId === "1")).toBe(true);
    expect(items.map((i: any) => i.type)).toEqual(["subscribe", "chat_request"]);
    const req = items[1].chatStreamRequest;
    expect(req.tone).toBe("Gpt_61_Sol_Reasoning");
    expect(req.streamingMode).toBe("ConciseV2");
    expect(req.message.text).toBe("hi");
    expect(req.gpts).toEqual([{ id: "bizchat-as-gpt-scenario", source: "BuiltInAgents" }]);
  });

  it("subscribes to the same topic with action create on every turn, keeps the conversation, and skips its replay", async () => {
    const session = new CopilotSession();
    const first = await turn(session, [restate("a"), part({ w: "one" }), end]);
    // Live: re-subscribing replays the earlier turn's items, its request_end too.
    const second = await turn(session, [
      restate("a", "turn-1"), part({ w: "one" }, "turn-1"), endOf("turn-1"),
      restate("b"), part({ w: "two" }), end,
    ]);

    // The web client resuming a conversation on a fresh socket: `create` again.
    expect(first.items[0]).toMatchObject({ type: "subscribe", action: "create" });
    expect(second.items[0]).toMatchObject({ type: "subscribe", action: "create", topicId: first.items[0].topicId });
    expect(second.items[1].topicId).toBe(first.items[0].topicId);
    expect(first.items[1].chatStreamRequest.isStartOfSession).toBe(true);
    expect(second.items[1].chatStreamRequest.isStartOfSession).toBe(false);
    expect(second.items[1].chatStreamRequest.conversationId).toBe(first.items[1].chatStreamRequest.conversationId);
    expect(second.stream.fullText).toBe("two");
  });

  it("ends the turn on an error item instead of waiting for the server to close", async () => {
    // An unknown tone: the server answers with this item and holds the socket ~120 s.
    const { stream, ws } = await turn(new CopilotSession(), [
      item({ type: "error", errorCategory: "InvalidRequest", errorCode: "InvalidNote", message: "Sorry, I wasn't able to respond to that.", detail: "System.ArgumentException" }),
    ]);

    expect(stream.result).toEqual({ value: "InvalidRequest", errorCode: "InvalidNote", message: "Sorry, I wasn't able to respond to that." });
    expect(stream.fullText).toBe("");
    expect(ws.readyState).toBe(3);
  });

  it("reads a refused turn's reason from request_end's outcome.code", async () => {
    // Live (GPT-6.1 Sol under OfficeWebIncludedCopilot): an apology message, then this.
    const { stream } = await turn(new CopilotSession(), [
      item({
        type: "request_end",
        requestId: "$RID",
        outcome: {
          category: "InvalidRequest",
          code: "InputTokenLimitExceeded",
          message: "Sorry, I wasn't able to respond to that.",
          error: "Microsoft.TuringBot.Common.InputTokenLimitExceededException … prompt is too long",
        },
      }),
    ]);
    expect(stream.result).toEqual({ value: "InvalidRequest", errorCode: "InputTokenLimitExceeded", message: "Sorry, I wasn't able to respond to that." });
  });

  it("asks for the StreamHub 1.1 items that end a turn", async () => {
    const { ws } = await turn(new CopilotSession(), [end]);
    expect(new URL(ws.url).searchParams.get("variants")!.split(",")).toContain("streamhub11");
  });

  it("returns the model's own text where the final snapshot lost a [Type]: (live edit-config shape)", async () => {
    // Codex edit-config, live: a partial delta, a restatement, then the
    // final snapshot with `[regex]:` gone — run as is, it emptied config.json.
    const raw = "```powershell\n$u = [regex]::Replace($c, '3000', '8080')\n";
    const { stream, streamed } = await turn(new CopilotSession(), [
      restate("m1"),
      part({ w: raw }),
      restate("m1"),
      part({ messages: [{ author: "bot", text: "```powershell\n$u = :Replace($c, '3000', '8080')\nSet-Content config.json $u\n```", contentOrigin: "DeepLeo", messageId: "m1" }], isLastUpdate: true }),
      end,
    ]);
    expect(stream.fullText).toBe(raw + "Set-Content config.json $u\n```");
    expect(streamed.join("")).toBe(stream.fullText);
  });

  it("closes the turn after EndOfRequest when request_end never comes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fake.state.script = [
        restate("m1"),
        part({ w: "done" }),
        // Live shape: the EndOfRequest message has no author.
        part({ messages: [{ author: null, messageType: "EndOfRequest", messageId: "e1" }] }),
      ];
      const stream = await new CopilotSession().chat(TOKEN, "hi", "gpt-6.1-sol");
      await vi.advanceTimersByTimeAsync(20);
      const ws = fake.state.sockets[fake.state.sockets.length - 1];
      expect(ws.readyState).toBe(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(ws.readyState).toBe(3);
      expect(stream.fullText).toBe("done");
    } finally {
      vi.useRealTimers();
    }
  });
});
