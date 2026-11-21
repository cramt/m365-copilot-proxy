import { afterEach, describe, expect, it, vi } from "vitest";

// A stand-in for `ws`, for both transports: answers the SignalR handshake and
// plays the scripted server frames once the chat goes up (Chathub's `chat`
// invocation, StreamHub's `chat_request` item).
const fake = vi.hoisted(() => {
  const RS = "\x1e";
  const state = { sockets: [] as any[], script: [] as unknown[] };
  class FakeWs {
    static OPEN = 1;
    readyState = 1;
    private handlers: Record<string, ((...a: any[]) => void)[]> = {};
    constructor(public url: string) {
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
        if (frame.protocol === "json") setTimeout(() => this.emit("message", Buffer.from("{}" + RS)), 0);
        const rid = frame.item?.type === "chat_request"
          ? frame.item.chatStreamRequest.requestId
          : frame.target === "chat" ? frame.arguments[0].message.requestId : null;
        if (!rid) continue;
        state.script.forEach((s, i) => setTimeout(() => {
          if (this.readyState === 1) this.emit("message", Buffer.from(JSON.stringify(s).replaceAll("$RID", rid) + RS));
        }, i + 1));
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

const cursor = (id: string) => ({ j: `$['${id}'].adaptiveCards[0].body[0].text`, p: -1 });
const thought = (text: string, id = "cot-1") => ({
  author: "bot", text, messageId: id, messageType: "Progress", contentOrigin: "ChainOfThoughtSummary", addToChainOfThought: true,
});
const early = { author: "bot", text: "Sorting it out…", messageId: "p1", messageType: "Progress", contentOrigin: "EarlyProgress" };
const code = { author: "bot", text: "Coding and executing", hiddenText: "pwd", messageId: "c1", messageType: "Progress", contentType: "Code" };

// Live 2026-11-20 (Claude_Sonnet_5): the summary grows a sentence per snapshot.
const S1 = "I'm setting up the equations: the ball and bat together cost 1.10.";
const S2 = `${S1} Substituting gives 2 times the ball equals 0.10, so the ball is 0.05.`;
const ANSWER = "The ball costs $0.05.";

async function turn(script: unknown[]) {
  fake.state.script = script;
  const pieces: string[] = [];
  const stream = await new CopilotSession().chat(TOKEN, "hi", "claude-sonnet-5", undefined, { onReasoning: (d) => pieces.push(d) });
  let streamed = "";
  for await (const d of stream) streamed += d;
  return { stream, pieces, streamed };
}

describe("chain of thought over StreamHub", () => {
  afterEach(() => {
    delete process.env.M365_TRANSPORT;
    fake.state.sockets.length = 0;
  });

  it("streams a growing summary as it arrives and keeps it out of the answer (live shape)", async () => {
    process.env.M365_TRANSPORT = "streamhub";
    const part = (argument: object) => ({ type: 2, invocationId: "1", item: { type: "message_part", target: "update", requestId: "$RID", argument } });
    const { stream, pieces, streamed } = await turn([
      part({ messages: [early] }),
      part({ messages: [thought(S1)] }),
      part({ messages: [thought(S2)] }),
      part({ cursor: cursor("a1"), messages: [{ author: "bot", text: "The ball", contentOrigin: "DeepLeo", messageId: "a1" }] }),
      part({ w: " costs $0.05." }),
      { type: 2, invocationId: "1", item: { type: "request_end", requestId: "$RID", outcome: { category: "Success" } } },
    ]);
    expect(pieces).toEqual([S1, S2.slice(S1.length)]);
    expect(stream.reasoning).toBe(S2);
    expect(streamed).toBe(ANSWER);
    expect(stream.fullText).toBe(ANSWER);
  });
});

describe("chain of thought over Chathub", () => {
  afterEach(() => { fake.state.sockets.length = 0; });

  it("takes each message once, leaves the other Progress messages out, and ignores the final restatement", async () => {
    const update = (arg: object) => ({ type: 1, target: "update", arguments: [arg] });
    const { stream, pieces, streamed } = await turn([
      update({ messages: [early] }),
      update({ messages: [thought(S1)] }),
      update({ messages: [code] }),
      update({ messages: [thought("Now checking the answer.", "cot-2")] }),
      update({ cursor: cursor("a1"), messages: [{ author: "bot", text: "The ball", contentOrigin: "DeepLeo", messageId: "a1" }] }),
      update({ writeAtCursor: " costs $0.05." }),
      { type: 2, invocationId: "0", item: {
        messages: [thought(S1), code, thought("Now checking the answer.", "cot-2"), { author: "bot", text: ANSWER, contentOrigin: "DeepLeo", messageId: "a1" }],
        result: { value: "Success" },
      } },
    ]);
    expect(pieces).toEqual([S1, "\n\nNow checking the answer."]);
    expect(stream.reasoning).toBe(`${S1}\n\nNow checking the answer.`);
    expect(streamed).toBe(ANSWER);
  });

  it("has no reasoning when the model sends none", async () => {
    const { stream, pieces } = await turn([
      { type: 1, target: "update", arguments: [{ cursor: cursor("a1"), messages: [{ author: "bot", text: ANSWER, contentOrigin: "DeepLeo", messageId: "a1" }] }] },
      { type: 2, invocationId: "0", item: { messages: [{ author: "bot", text: ANSWER, messageId: "a1" }], result: { value: "Success" } } },
    ]);
    expect(pieces).toEqual([]);
    expect(stream.reasoning).toBe("");
  });
});
