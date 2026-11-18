import { afterEach, describe, expect, it } from "vitest";
import { formatMessages, type Message, type ToolDef } from "@m365-copilot/core";
import { DEFAULT_TURN_CHUNK_BYTES, planFullPrompt, planText, splitText, turnChunkBytes, utf8Bytes } from "./replay.js";

/** A part or final turn without its note: what it carries of the conversation. */
const body = (turn: string) => turn.slice(turn.indexOf("]\n\n") + 3);

describe("utf8Bytes", () => {
  it("counts UTF-8 bytes, a surrogate pair as one 4-byte character", () => {
    for (const s of ["", "abc", "é", "中文", "😀", "a😀b", "\ud800x"]) {
      expect(utf8Bytes(s), s).toBe(Buffer.byteLength(s, "utf8"));
    }
  });
});

describe("splitText", () => {
  it("cuts at line breaks into pieces that fit, which join back into the text", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
    const pieces = splitText(text, 200);
    expect(pieces.length).toBeGreaterThan(5);
    for (const p of pieces) expect(utf8Bytes(p)).toBeLessThanOrEqual(200);
    for (const p of pieces.slice(0, -1)) expect(p.endsWith("\n")).toBe(true);
    expect(pieces.join("")).toBe(text);
  });

  it("cuts a line longer than a piece between code points", () => {
    const text = "😀".repeat(100) + "中".repeat(100);
    const pieces = splitText(text, 30);
    for (const p of pieces) expect(utf8Bytes(p)).toBeLessThanOrEqual(30);
    for (const p of pieces) expect(p).not.toMatch(/[\ud800-\udbff]$/);
    expect(pieces.join("")).toBe(text);
  });

  it("fills a piece with the head of a line it has to cut, rather than sending a short line alone", () => {
    const text = `<user>\n${"x".repeat(100)}\n</user>`;
    const pieces = splitText(text, 30);
    expect(pieces[0]).toBe(`<user>\n${"x".repeat(23)}`);
    for (const p of pieces) expect(utf8Bytes(p)).toBeLessThanOrEqual(30);
    expect(pieces.join("")).toBe(text);
  });
});

describe("planText", () => {
  it("leaves a turn that fits whole, and every turn whole at limit 0", () => {
    expect(planText("short", 100)).toEqual({ parts: [], final: "short" });
    expect(planText("x".repeat(10_000), 0)).toEqual({ parts: [], final: "x".repeat(10_000) });
  });

  it("splits a longer one into numbered parts that fit, the last one to answer", () => {
    const text = Array.from({ length: 400 }, (_, i) => `row ${i} ${"y".repeat(40)}`).join("\n");
    const { parts, final } = planText(text, 4_000);
    const n = parts.length + 1;
    expect(n).toBeGreaterThan(3);
    parts.forEach((p, i) => expect(p.startsWith(`[This message is too long to send at once, so it comes in ${n} parts. This is part ${i + 1} of ${n}.`)).toBe(true));
    expect(final.startsWith(`[This is part ${n} of ${n}, the end of the message.`)).toBe(true);
    for (const t of [...parts, final]) expect(utf8Bytes(t)).toBeLessThanOrEqual(4_000);
    expect([...parts, final].map(body).join("")).toBe(text);
  });
});

describe("planFullPrompt", () => {
  const tools: ToolDef[] = [{
    type: "function",
    function: { name: "bash", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  }];
  const exchange = (i: number): Message[] => [
    { role: "user", content: `Step ${i}: ${"context ".repeat(50)}` },
    { role: "assistant", content: null, tool_calls: [{ id: `call_${i}`, function: { name: "bash", arguments: JSON.stringify({ command: `ls dir${i}` }) } }] },
    { role: "tool", tool_call_id: `call_${i}`, content: `listing of dir${i}: ${"file ".repeat(40)}` },
  ];
  const conversation = (n: number): Message[] => [
    { role: "system", content: "SYSTEM PROMPT" },
    ...Array.from({ length: n }, (_, i) => exchange(i)).flat(),
    { role: "user", content: "THE REQUEST" },
  ];

  it("sends a history that fits as the usual prompt", () => {
    const msgs = conversation(2);
    const plan = planFullPrompt(msgs, tools, "auto", "cid", "relay", 1_000_000);
    expect(plan).toEqual({ parts: [], final: formatMessages(msgs, tools, "auto", "cid", "relay") });
  });

  it("puts the system prompt, the tool framing and the latest messages in the final turn, the rest ahead of it in order", () => {
    const msgs = conversation(12);
    const limit = 3_000;
    const { parts, final } = planFullPrompt(msgs, tools, "auto", "cid", "relay", limit);
    expect(parts.length).toBeGreaterThan(1);
    for (const t of [...parts, final]) expect(utf8Bytes(t)).toBeLessThanOrEqual(limit);
    parts.forEach((p, i) => expect(p.startsWith(`[Earlier conversation, part ${i + 1} of ${parts.length}.`)).toBe(true));
    expect(final.startsWith(`[The ${parts.length} messages before this one carried the earlier part of this conversation.`)).toBe(true);
    expect(final).toContain("SYSTEM PROMPT");
    expect(final).toContain("<conversation_id>cid</conversation_id>");
    expect(final).toContain("bash — Run a shell command"); // the tool framing
    expect(final).toContain("THE REQUEST");
    for (const p of parts) expect(p).not.toContain("SYSTEM PROMPT");
    // Each step goes up exactly once, in order.
    const turns = [...parts, final];
    const where = (i: number) => turns.findIndex((t) => t.includes(`Step ${i}:`));
    for (let i = 0; i < 12; i++) expect(turns.filter((t) => t.includes(`Step ${i}:`))).toHaveLength(1);
    for (let i = 1; i < 12; i++) expect(where(i)).toBeGreaterThanOrEqual(where(i - 1));
  });

  it("names a tool result for its call when the call went up in an earlier part", () => {
    const msgs = conversation(12);
    const { parts, final } = planFullPrompt(msgs, tools, "auto", "cid", "relay", 3_000);
    const turns = [...parts, final];
    for (let i = 0; i < 12; i++) {
      const result = turns.find((t) => t.includes(`listing of dir${i}:`))!;
      expect(result).toContain(`command="ls dir${i}"`);
    }
  });

  it("splits a message longer than a part across parts", () => {
    const huge = Array.from({ length: 300 }, (_, i) => `old line ${i} ${"z".repeat(40)}`).join("\n");
    const msgs: Message[] = [{ role: "system", content: "SYSTEM PROMPT" }, { role: "user", content: huge }, { role: "assistant", content: "ok" }, { role: "user", content: "THE REQUEST" }];
    const { parts, final } = planFullPrompt(msgs, undefined, undefined, "cid", "relay", 4_000);
    expect(parts.length).toBeGreaterThan(2);
    for (const t of [...parts, final]) expect(utf8Bytes(t)).toBeLessThanOrEqual(4_000);
    expect(parts.map(body).join("")).toBe(formatMessages([msgs[1]], undefined, "none", undefined, "relay"));
    expect(final).toContain("THE REQUEST");
  });

  it("cuts the whole prompt as text when not even the system prompt and the last message fit", () => {
    const msgs: Message[] = [{ role: "system", content: "S".repeat(5_000) }, { role: "user", content: "THE REQUEST" }];
    const { parts, final } = planFullPrompt(msgs, undefined, undefined, "cid", "relay", 2_000);
    expect(parts[0]).toMatch(/^\[This message is too long to send at once/);
    expect([...parts, final].map(body).join("")).toBe(formatMessages(msgs, undefined, undefined, "cid", "relay"));
  });
});

describe("turnChunkBytes", () => {
  afterEach(() => { delete process.env.M365_TURN_CHUNK_BYTES; });

  it("reads M365_TURN_CHUNK_BYTES, 0 included, and falls back to 400 kB", () => {
    expect(turnChunkBytes()).toBe(DEFAULT_TURN_CHUNK_BYTES);
    process.env.M365_TURN_CHUNK_BYTES = "250000";
    expect(turnChunkBytes()).toBe(250_000);
    process.env.M365_TURN_CHUNK_BYTES = "0";
    expect(turnChunkBytes()).toBe(0);
    process.env.M365_TURN_CHUNK_BYTES = "lots";
    expect(turnChunkBytes()).toBe(DEFAULT_TURN_CHUNK_BYTES);
  });
});
