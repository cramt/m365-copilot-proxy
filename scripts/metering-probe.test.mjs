// The metering probe's offline parts: cell parsing, reading and diffing the
// allowances, and the answer's timing from recorded frames. No M365 turns.
import { describe, expect, it } from "vitest";
import { allowances, changed, parseCell, textTiming } from "./metering-probe.mjs";

describe("parseCell", () => {
  it("reads transport, scenario, tone, prompt and the Bing switch", () => {
    expect(parseCell("streamhub@paid:Claude_Auto:id:nobing")).toMatchObject({
      transport: "streamhub", scenario: "OfficeWebPaidCopilot", licenseType: "Premium",
      tone: "Claude_Auto", prompt: "id", bing: false, read: false,
    });
    expect(parseCell("streamhub@officeweb:Claude_Opus")).toMatchObject({ scenario: "officeweb", prompt: "pong", bing: true });
  });

  it("reads the allowances with an unmetered Chathub paid-scenario turn", () => {
    expect(parseCell("read")).toMatchObject({ transport: "chathub", scenario: "OfficeWebPaidCopilot", tone: "Gpt_5_5_Chat", read: true });
  });

  it("refuses anything else", () => {
    for (const bad of ["webhub@paid:X", "chathub@nowhere:X", "chathub@paid:X:loud", "chathub@paid"]) {
      expect(() => parseCell(bad)).toThrow(/Bad cell/);
    }
  });
});

describe("allowances and changed", () => {
  it("keeps each key's remainingAllowance and reports only the keys that moved", () => {
    const before = allowances({ ClaudeOpusQueryDaily: { remainingAllowance: 38 }, ClaudeOpusQuery75: { remainingAllowance: 73 }, Odd: {} });
    expect(before).toEqual({ ClaudeOpusQueryDaily: 38, ClaudeOpusQuery75: 73 });
    expect(changed(before, { ClaudeOpusQueryDaily: 37, ClaudeOpusQuery75: 73 })).toEqual({ ClaudeOpusQueryDaily: [38, 37] });
    expect(changed(before, before)).toEqual({});
    expect(allowances(null)).toBeNull();
  });
});

describe("textTiming", () => {
  const part = (argument) => ({ type: 2, item: { type: "message_part", argument } });

  it("times StreamHub answer text, not the chain of thought, and notes answer_complete", () => {
    const records = [
      { t: 1000, f: {} },
      { t: 1500, f: part({ messages: [{ author: "bot", messageType: "Progress", contentOrigin: "ChainOfThoughtSummary", text: "thinking" }] }) },
      { t: 3000, f: part({ cursor: { j: "$['m1']" }, messages: [{ author: "bot", contentOrigin: "DeepLeo", text: "Once" }] }) },
      { t: 3400, f: part({ w: " upon a time" }) },
      { t: 3500, f: part({ throttling: { numUserMessagesInConversation: 1 } }) },
      { t: 5000, f: { type: 2, item: { type: "answer_complete" } } },
    ];
    expect(textTiming(records)).toEqual({ firstTextMs: 2000, lastTextMs: 2400, answerCompleteMs: 4000 });
  });

  it("times Chathub updates and ignores the final item's restatement", () => {
    const records = [
      { t: 0, f: {} },
      { t: 800, f: { type: 1, target: "update", arguments: [{ writeAtCursor: "po" }] } },
      { t: 900, f: { type: 1, target: "update", arguments: [{ writeAtCursor: "ng" }] } },
      { t: 2000, f: { type: 2, item: { messages: [{ author: "bot", text: "pong" }] } } },
    ];
    expect(textTiming(records)).toEqual({ firstTextMs: 800, lastTextMs: 900, answerCompleteMs: null });
  });
});
