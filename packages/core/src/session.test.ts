import { describe, it, expect } from "vitest";
import { buildCopilotWebSocketUrl, cursorMessageId, foldStreamText, TurnTextComposer } from "./session.js";
import { MessageUpdate } from "./schemas.js";

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
    const r = replay([
      { s: "alpha" },
      { d: "\nbeta" },
      { d: "\ngamma" },
    ]);
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

describe("GraphicArt image frame parsing (§14)", () => {
  // The exact shape captured from a live GUI image turn — the fields zod used to
  // strip. If BotMessage is ever re-tightened, this fails and the image is lost.
  const graphicArtFrame = {
    messages: [
      {
        text: "Loading image",
        contentGenerationProgressList: [
          {
            contentType: "image",
            size: "Xlimage",
            orientation: "Landscape",
            pollUrl: "eyJQb2xsSWQiOiJ4In0=",
            fileToken: "359965a5-6ca9-409d-a4ca-43b0cc9cdf81",
            ImageReferenceUrls: ["https://designerapp.officeapps.live.com/designerapp/document.ashx?path=%2Fx%2FDallEGeneratedImages%2Fdalle-abc.png"],
            status: 2,
          },
        ],
        contentType: "GraphicArt",
        author: "bot",
        messageType: "Progress",
        contentOrigin: "ImageGeneration",
      },
    ],
  };

  it("retains the image payload instead of stripping it", () => {
    const parsed = MessageUpdate.safeParse(graphicArtFrame);
    expect(parsed.success).toBe(true);
    const m = parsed.data!.messages[0] as any;
    expect(m.contentType).toBe("GraphicArt");
    const entry = m.contentGenerationProgressList[0];
    expect(entry.ImageReferenceUrls[0]).toContain("DallEGeneratedImages");
    expect(entry.fileToken).toBe("359965a5-6ca9-409d-a4ca-43b0cc9cdf81");
    expect(entry.status).toBe(2);
  });

  it("still parses an ordinary text bot message with no image fields", () => {
    const parsed = MessageUpdate.safeParse({
      messages: [{ text: "just text", author: "bot", messageType: "Chat" }],
    });
    expect(parsed.success).toBe(true);
    const m = parsed.data!.messages[0] as any;
    expect(m.contentGenerationProgressList).toBeUndefined();
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
      if (f.cursor) c.cursor(cursorMessageId(f.cursor)!); // as session.ts does
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
      { d: " me look" }, { d: " through" }, { d: " the files" }, { d: " in the notes/" },
      { d: " directory to find the SECRET_CODE" }, { d: "." },
      { s: "Let me look through the files in the notes/ directory to find the SECRET_CODE.", id: "m1" },
      { cursor: cur("m2"), s: "```", id: "m2" },
      { d: "bash\ngrep -r" }, { d: ' "^' }, { d: 'SECRET_CODE=" notes' }, { d: "/" }, { d: "\n```" },
      { s: '```bash\ngrep -r "^SECRET_CODE=" notes/\n```', id: "m2" },
    ]);
    expect(r.text).toBe(
      'Let me look through the files in the notes/ directory to find the SECRET_CODE.\n\n```bash\ngrep -r "^SECRET_CODE=" notes/\n```',
    );
    expect(r.answer).toBe(r.text);
    expect(r.streamed).toBe(r.text); // prefix-safe: everything streamed, nothing duplicated
  });

  it("is byte-identical to the old fold for a single-message turn", () => {
    const frames: F[] = [{ cursor: cur("a"), s: "alpha", id: "a" }, { d: "\nbeta" }, { s: "alpha\nbeta", id: "a" }];
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
    expect(cursorMessageId("$['1051ab91-f905'].adaptiveCards[0].body[0].text")).toBe("1051ab91-f905");
    expect(cursorMessageId(undefined)).toBeNull();
    expect(cursorMessageId("garbage")).toBeNull();
  });
});
