import { describe, it, expect } from "vitest";
import { foldStreamText } from "./session.js";
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
