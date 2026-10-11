import { beforeEach, describe, it, expect, vi } from "vitest";
import WebSocket from "ws";
import { z } from "zod/v4";
import {
  buildCopilotWebSocketUrl,
  CopilotSession,
  cursorMessageId,
  foldStreamText,
  TurnTextComposer,
} from "./session.js";
import { MessageUpdate } from "./schemas.js";

vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    default: vi.fn(
      class extends EventEmitter {
        send = vi.fn();
        close = vi.fn(() => this.emit("close"));
      },
    ),
  };
});

/** Replay a sequence of raw M365 frames (deltas as {d}, snapshots as {s}) through
 *  foldStreamText and collect what would be streamed + the final buffered answer. */
function replay(frames: Array<{ d: string } | { s: string }>) {
  let answer = "";
  const emitted: string[] = [];
  for (const f of frames) {
    const next = "d" in f ? answer + f.d : f.s;
    const r = foldStreamText(answer, next);
    answer = r.answer;
    if (r.emit) emitted.push(r.emit);
  }
  return { emitted, streamed: emitted.join(""), answer };
}

describe("foldStreamText", () => {
  it("streams pure token deltas as-is", () => {
    const r = replay([{ d: "Hello" }, { d: ", " }, { d: "world" }]);
    expect(r.emitted).toEqual(["Hello", ", ", "world"]);
    expect(r.answer).toBe("Hello, world");
  });

  it("recovers the head token when it arrives only as a snapshot (the live bug)", () => {
    // M365 delivered "alpha" as a full-text snapshot, then token deltas for the rest.
    const r = replay([{ s: "alpha" }, { d: "\nbeta" }, { d: "\ngamma" }]);
    expect(r.streamed).toBe("alpha\nbeta\ngamma");
    expect(r.answer).toBe("alpha\nbeta\ngamma");
  });

  it("streams the appended suffix when snapshots grow monotonically", () => {
    const r = replay([{ s: "The " }, { s: "The quick " }, { s: "The quick fox" }]);
    expect(r.emitted).toEqual(["The ", "quick ", "fox"]);
    expect(r.answer).toBe("The quick fox");
  });

  it("emits the extending tail of a snapshot exactly once (no duplication)", () => {
    // Deltas gave "Hello wor"; a final snapshot "Hello world" EXTENDS it, so only the
    // "ld" tail is emitted — never the whole snapshot on top of the deltas.
    const r = replay([{ d: "Hello " }, { d: "wor" }, { s: "Hello world" }]);
    expect(r.emitted).toEqual(["Hello ", "wor", "ld"]);
    expect(r.streamed).toBe("Hello world");
    expect(r.answer).toBe("Hello world");
  });

  it("ignores shorter/equal snapshots (no negative-length slice, no re-emit)", () => {
    const r = replay([{ d: "abcdef" }, { s: "abc" }, { s: "abcdef" }]);
    expect(r.emitted).toEqual(["abcdef"]);
    expect(r.answer).toBe("abcdef");
  });

  it("adopts a divergent longer snapshot as authoritative but does not stream it", () => {
    // Deltas streamed "xy"; a later snapshot reveals a different, longer head. We keep
    // the snapshot for the buffered result but must NOT stream it (can't unsend "xy").
    const r = replay([{ d: "xy" }, { s: "ZZZxy extra" }]);
    expect(r.streamed).toBe("xy");
    expect(r.answer).toBe("ZZZxy extra");
    expect(r.answer.startsWith(r.streamed)).toBe(false); // divergence recorded, not streamed
  });
});

describe("GraphicArt image frame parsing", () => {
  it("retains image payloads on Progress snapshots", () => {
    const result = MessageUpdate.parse({
      messages: [
        {
          text: "Loading image",
          author: "bot",
          messageType: "Progress",
          contentType: "GraphicArt",
          contentOrigin: "ImageGeneration",
          contentGenerationProgressList: [
            {
              contentType: "image",
              size: "Xlimage",
              orientation: "Landscape",
              pollUrl: "poll-id",
              fileToken: "image-token",
              ImageReferenceUrls: [
                "https://designerapp.officeapps.live.com/DallEGeneratedImages/image.png",
              ],
              status: 2,
            },
          ],
        },
      ],
    });
    expect(result.messages[0].contentType).toBe("GraphicArt");
    expect(result.messages[0].contentGenerationProgressList?.[0]).toMatchObject({
      fileToken: "image-token",
      status: 2,
      ImageReferenceUrls: [
        "https://designerapp.officeapps.live.com/DallEGeneratedImages/image.png",
      ],
    });
  });

  it("still parses ordinary text without image fields", () => {
    const result = MessageUpdate.parse({ messages: [{ text: "just text", author: "bot" }] });
    expect(result.messages[0].contentGenerationProgressList).toBeUndefined();
  });
});

describe("image-generation transport", () => {
  const imageUrl = "https://designerapp.officeapps.live.com/DallEGeneratedImages/image.png";
  const token = `header.${Buffer.from(
    JSON.stringify({
      aud: "test",
      iss: "test",
      oid: "object-id",
      tid: "tenant-id",
      exp: 2_000_000_000,
    }),
  ).toString("base64url")}.signature`;

  beforeEach(() => vi.clearAllMocks());

  async function startTurn(generateImages: boolean) {
    const pending = new CopilotSession().chat(token, "draw a bicycle", "m365-copilot", undefined, {
      generateImages,
    });
    const socket = vi.mocked(WebSocket).mock.instances.at(-1);
    if (!socket) throw new Error("Expected a WebSocket instance");
    socket.emit("open");
    socket.emit("message", Buffer.from("{}\x1e"));
    const stream = await pending;
    const payload = z.string().parse(vi.mocked(socket).send.mock.calls[1][0]).split("\x1e")[0];
    const request = z
      .object({
        arguments: z.array(
          z.object({
            optionsSets: z.array(z.string()),
            allowedMessageTypes: z.array(z.string()),
          }),
        ),
      })
      .parse(JSON.parse(payload));
    return { socket, stream, request: request.arguments[0] };
  }

  it.each([false, true])(
    "declares image capabilities only when requested (%s)",
    async (enabled) => {
      const { socket, stream, request } = await startTurn(enabled);
      expect(request.optionsSets.includes("cwc_flux_image")).toBe(enabled);
      expect(request.optionsSets.includes("flux_v3_image_gen_enable_non_watermarked_storage")).toBe(
        enabled,
      );
      expect(request.allowedMessageTypes.includes("GenerateGraphicArt")).toBe(enabled);
      expect(request.allowedMessageTypes).toContain("GeneratedCode");
      const address = vi.mocked(WebSocket).mock.calls.at(-1)?.[0];
      const variants = new URL(String(address)).searchParams.get("variants");
      expect(variants).toContain("feature.enableGenerateGraphicArtOptionsSet");
      expect(variants).toContain("cdximagen");
      socket.close();
      expect(stream.images).toEqual([]);
      expect(await stream[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
    },
  );

  it("captures Progress and final images without duplicates or readiness regressions", async () => {
    const { socket, stream } = await startTurn(true);
    const imageMessage = (fileToken: string, status: number, url = imageUrl) => ({
      author: "bot",
      messageType: "Progress",
      contentType: "GraphicArt",
      contentGenerationProgressList: [
        {
          fileToken,
          status,
          ImageReferenceUrls: [url],
          orientation: "Landscape",
          size: "Xlimage",
        },
      ],
    });
    const update = (status: number, url: string) =>
      socket.emit(
        "message",
        Buffer.from(
          `${JSON.stringify({
            type: 1,
            target: "update",
            arguments: [{ messages: [imageMessage("first", status, url)] }],
          })}\x1e`,
        ),
      );
    update(1, `${imageUrl}?preview=1`);
    expect(stream.images).toMatchObject([{ status: 1 }]);
    update(2, imageUrl);
    update(1, `${imageUrl}?preview=1`);
    expect(stream.images).toMatchObject([{ status: 2, referenceUrls: [imageUrl] }]);
    socket.emit(
      "message",
      Buffer.from(
        `${JSON.stringify({
          type: 2,
          item: {
            result: { value: "Success" },
            messages: [imageMessage("first", 2), imageMessage("second", 2, `${imageUrl}?second=1`)],
          },
        })}\x1e`,
      ),
    );
    expect(await stream[Symbol.asyncIterator]().next()).toMatchObject({ done: true });
    expect(stream.images).toHaveLength(2);
    expect(stream.images[1]).toMatchObject({ fileToken: "second", status: 2 });
    expect(stream.fullText).toBe("");
  });
});

describe("temporary-chat WebSocket URL", () => {
  it("preserves disableMemory=1 when temporary chat is enabled", () => {
    const params = new URLSearchParams({
      ConversationId: "conversation-1",
      disableMemory: "1",
    });
    const url = new URL(buildCopilotWebSocketUrl("oid-1", "tid-1", params));

    expect(url.hostname).toBe("substrate.office.com");
    expect(url.pathname).toBe("/m365Copilot/Chathub/oid-1@tid-1");
    expect(url.searchParams.get("ConversationId")).toBe("conversation-1");
    expect(url.searchParams.get("disableMemory")).toBe("1");
  });

  it("does not invent disableMemory when saved history is requested", () => {
    const params = new URLSearchParams({ ConversationId: "conversation-1" });
    const url = new URL(buildCopilotWebSocketUrl("oid-1", "tid-1", params));

    expect(url.searchParams.has("disableMemory")).toBe(false);
  });
});

describe("TurnTextComposer (multi-message turns)", () => {
  type F = { cursor?: string } & ({ d: string } | { s: string; id: string });
  /** Replay frames through the composer AND the streaming fold, like session.ts. */
  function compose(frames: F[]) {
    const c = new TurnTextComposer();
    let answer = "";
    let streamed = "";
    for (const f of frames) {
      if (f.cursor) {
        const messageId = cursorMessageId(f.cursor);
        if (messageId !== null) c.cursor(messageId);
      }
      if ("d" in f) c.delta(f.d);
      else c.snapshot(f.id, f.s);
      const r = foldStreamText(answer, c.text);
      answer = r.answer;
      if (r.emit) streamed += r.emit;
    }
    return { text: c.text, answer, streamed };
  }
  const cur = (id: string) => `$['${id}'].adaptiveCards[0].body[0].text`;

  it("keeps the head of a second message — the live turn that lost a tool fence", () => {
    // Verbatim shape of the Sep 28 Sonnet 4.6 find-needle turn: narration in one
    // message, the ```bash fence in the next. The old single-string fold dropped
    // the second message's head snapshot "```" and produced "…SECRET_CODE.bash\ngrep".
    const r = compose([
      { cursor: cur("m1"), s: "Let", id: "m1" },
      { d: " me look" },
      { d: " through" },
      { d: " the files" },
      { d: " in the notes/" },
      { d: " directory to find the SECRET_CODE" },
      { d: "." },
      {
        s: "Let me look through the files in the notes/ directory to find the SECRET_CODE.",
        id: "m1",
      },
      { cursor: cur("m2"), s: "```", id: "m2" },
      { d: "bash\ngrep -r" },
      { d: ' "^' },
      { d: 'SECRET_CODE=" notes' },
      { d: "/" },
      { d: "\n```" },
      { s: '```bash\ngrep -r "^SECRET_CODE=" notes/\n```', id: "m2" },
    ]);
    expect(r.text).toBe(
      'Let me look through the files in the notes/ directory to find the SECRET_CODE.\n\n```bash\ngrep -r "^SECRET_CODE=" notes/\n```',
    );
    expect(r.answer).toBe(r.text);
    expect(r.streamed).toBe(r.text); // prefix-safe: everything streamed, nothing duplicated
  });

  it("is byte-identical to the old fold for a single-message turn", () => {
    const frames: F[] = [
      { cursor: cur("a"), s: "alpha", id: "a" },
      { d: "\nbeta" },
      { s: "alpha\nbeta", id: "a" },
    ];
    expect(compose(frames).text).toBe("alpha\nbeta");
    expect(compose(frames).streamed).toBe("alpha\nbeta");
  });

  it("routes deltas by cursor, not by whichever snapshot arrived last", () => {
    // A late final snapshot of message 1 lands after message 2's cursor; the
    // deltas that follow still belong to message 2.
    const r = compose([
      { cursor: cur("m1"), s: "one", id: "m1" },
      { cursor: cur("m2"), s: "two", id: "m2" },
      { s: "one!", id: "m1" },
      { d: " more" },
    ]);
    expect(r.text).toBe("one!\n\ntwo more");
  });

  it("falls back to the snapshot's message when no cursor was ever sent", () => {
    const r = compose([{ s: "x", id: "m1" }, { d: "yz" }]);
    expect(r.text).toBe("xyz");
  });

  it("parses the message id out of a cursor path", () => {
    expect(cursorMessageId("$['1051ab91-f905'].adaptiveCards[0].body[0].text")).toBe(
      "1051ab91-f905",
    );
    expect(cursorMessageId(undefined)).toBeNull();
    expect(cursorMessageId("garbage")).toBeNull();
  });
});
