import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DigestableMessage,
  type StickySessionMode,
  TurnQueue,
  messageDigest,
  parseStickySessionMode,
  stickyConversationKey,
  stickyDeltaStart,
  stickySessionMode,
} from "./sticky-session.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

const system: DigestableMessage = { role: "system", content: "you are pi" };
const summary: DigestableMessage = { role: "user", content: "Summary of earlier work: ..." };

function userMessage(text: string): DigestableMessage {
  return { role: "user", content: text };
}

function assistantCall(callId: string, args = '{"path":"a.ts"}'): DigestableMessage {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: callId, function: { name: "read", arguments: args } }],
  };
}

function toolResult(callId: string, text: string): DigestableMessage {
  return { role: "tool", content: text, tool_call_id: callId };
}

function flushTimers(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("parseStickySessionMode", () => {
  const cases: Array<[string | undefined, StickySessionMode]> = [
    ["model", "model"],
    [" ALL ", "all"],
    ["", "all"],
    [undefined, "all"],
    ["garbage", "all"],
    ["off", "off"],
    [" OFF ", "off"],
    ["0", "off"],
    ["false", "off"],
    ["no", "off"],
  ];
  for (const [input, expected] of cases) {
    it(`parses ${JSON.stringify(input)} as ${expected}`, () => {
      expect(parseStickySessionMode(input)).toBe(expected);
    });
  }
});

describe("stickySessionMode", () => {
  it("reads M365_STICKY_SESSION on every call", () => {
    vi.stubEnv("M365_STICKY_SESSION", "model");
    expect(stickySessionMode()).toBe("model");
    vi.stubEnv("M365_STICKY_SESSION", "all");
    expect(stickySessionMode()).toBe("all");
    vi.stubEnv("M365_STICKY_SESSION", "");
    expect(stickySessionMode()).toBe("all");
    vi.stubEnv("M365_STICKY_SESSION", "off");
    expect(stickySessionMode()).toBe("off");
  });
});

describe("stickyConversationKey", () => {
  it("uses one key for all models in all mode", () => {
    expect(stickyConversationKey("all", "claude-sonnet")).toBe("sticky:all");
    expect(stickyConversationKey("all", "gpt-5.5")).toBe("sticky:all");
  });

  it("keys per model in model mode", () => {
    expect(stickyConversationKey("model", "gpt-5.5")).toBe("sticky:model:gpt-5.5");
    expect(stickyConversationKey("model", "claude-sonnet")).not.toBe(
      stickyConversationKey("model", "gpt-5.5"),
    );
  });
});

describe("messageDigest", () => {
  it("is equal for equal messages", () => {
    expect(messageDigest(userMessage("hi"))).toBe(messageDigest(userMessage("hi")));
  });

  it("differs when content differs", () => {
    expect(messageDigest(userMessage("hi"))).not.toBe(messageDigest(userMessage("bye")));
  });

  it("differs when role differs", () => {
    expect(messageDigest({ role: "user", content: "x" })).not.toBe(
      messageDigest({ role: "assistant", content: "x" }),
    );
  });

  it("differs when tool_call_id differs", () => {
    expect(messageDigest(toolResult("c1", "ok"))).not.toBe(messageDigest(toolResult("c2", "ok")));
  });

  it("differs when tool call arguments differ", () => {
    expect(messageDigest(assistantCall("c1", '{"path":"a"}'))).not.toBe(
      messageDigest(assistantCall("c1", '{"path":"b"}')),
    );
  });

  it("handles string, parts-array, and null content", () => {
    const parts: DigestableMessage = {
      role: "user",
      content: [{ type: "text", text: "hi" }],
    };
    expect(messageDigest(parts)).not.toBe(messageDigest(userMessage("hi")));
    expect(messageDigest(parts)).toBe(messageDigest({ ...parts }));
    expect(messageDigest({ role: "assistant", content: null })).toBe(
      messageDigest({ role: "assistant", content: null }),
    );
    expect(messageDigest({ role: "assistant", content: null })).not.toBe(
      messageDigest({ role: "assistant", content: "" }),
    );
  });
});

describe("stickyDeltaStart", () => {
  it("rule 1: nothing sent yet sends everything", () => {
    const messages = [system, userMessage("a"), userMessage("b")];
    expect(stickyDeltaStart(messages, 0, null)).toEqual({ start: 0, reason: "full" });
  });

  it("rule 2: no digest recorded falls back to append at sentMessageCount", () => {
    const messages = [system, userMessage("a"), assistantCall("c1"), toolResult("c1", "ok")];
    expect(stickyDeltaStart(messages, 2, null)).toEqual({ start: 2, reason: "append" });
    expect(stickyDeltaStart(messages.slice(0, 1), 3, null)).toEqual({
      start: 1,
      reason: "append",
    });
  });

  it("rule 3: history grew and the last sent message is unchanged", () => {
    const messages = [system, userMessage("a"), assistantCall("c1"), toolResult("c1", "ok")];
    const lastDigest = messageDigest(messages[2]);
    expect(stickyDeltaStart(messages, 3, lastDigest)).toEqual({ start: 3, reason: "append" });
  });

  it("rule 4: pi compaction rewrote the head; the last sent message survives", () => {
    const sentTool = toolResult("c2", "first result");
    const sent = [
      system,
      userMessage("task"),
      assistantCall("c1"),
      toolResult("c1", "r1"),
      assistantCall("c2"),
      sentTool,
    ];
    const compacted = [
      system,
      summary,
      assistantCall("c2"),
      sentTool,
      toolResult("c3", "new result"),
    ];
    expect(stickyDeltaStart(compacted, sent.length, messageDigest(sentTool))).toEqual({
      start: 4,
      reason: "rebased",
    });
  });

  it("rule 5: last sent message is gone; resume after the last assistant message", () => {
    const sent = [system, userMessage("task"), assistantCall("c1"), toolResult("c1", "r1")];
    const rewritten = [system, summary, assistantCall("c9"), toolResult("c9", "fresh")];
    expect(stickyDeltaStart(rewritten, sent.length, messageDigest(sent[3]))).toEqual({
      start: 3,
      reason: "rewritten",
    });
  });

  it("rule 5: no assistant message; resume at the last user message", () => {
    const rewritten = [system, summary, userMessage("next question")];
    expect(stickyDeltaStart(rewritten, 4, "missing")).toEqual({
      start: 2,
      reason: "rewritten",
    });
  });

  it("rule 5: no assistant or user message; send nothing new", () => {
    expect(stickyDeltaStart([system], 4, "missing")).toEqual({
      start: 1,
      reason: "rewritten",
    });
  });

  it("rule 4 picks the last match when the digest occurs more than once", () => {
    const repeated = userMessage("ok");
    const messages = [repeated, system, repeated, userMessage("new")];
    expect(stickyDeltaStart(messages, 10, messageDigest(repeated))).toEqual({
      start: 3,
      reason: "rebased",
    });
  });
});

describe("TurnQueue", () => {
  it("runs acquirers strictly in FIFO order without overlap", async () => {
    const queue = new TurnQueue();
    const events: string[] = [];
    let active = 0;
    let maxActive = 0;

    const runTurn = async (name: string): Promise<void> => {
      const release = await queue.acquire();
      active++;
      maxActive = Math.max(maxActive, active);
      events.push(`start:${name}`);
      await flushTimers();
      events.push(`end:${name}`);
      active--;
      release();
    };

    await Promise.all([runTurn("a"), runTurn("b"), runTurn("c")]);

    expect(events).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
    expect(maxActive).toBe(1);
  });

  it("makes release idempotent", async () => {
    const queue = new TurnQueue();
    const first = await queue.acquire();
    const secondPromise = queue.acquire();
    let thirdResolved = false;
    const thirdPromise = queue.acquire().then((release) => {
      thirdResolved = true;
      return release;
    });

    first();
    first();
    const second = await secondPromise;
    await flushTimers();
    expect(thirdResolved).toBe(false);
    expect(queue.busy).toBe(true);

    second();
    const third = await thirdPromise;
    expect(queue.busy).toBe(true);
    third();
    expect(queue.busy).toBe(false);
  });

  it("reports busy while held and idle after release", async () => {
    const queue = new TurnQueue();
    expect(queue.busy).toBe(false);
    const release = await queue.acquire();
    expect(queue.busy).toBe(true);
    release();
    expect(queue.busy).toBe(false);
  });
});
