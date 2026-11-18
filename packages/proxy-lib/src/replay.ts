import { formatMessages, type Message, type ToolChoice, type ToolDef } from "@m365-copilot/core";

// --- Turns M365 can't keep whole ----------------------------------------------
//
// M365 answers a turn of several hundred thousand characters but doesn't keep
// it in the conversation, and the next turn has no context: it kept a
// 420k-character opening and dropped a 540k one on GPT-6.2 Sol (docs/
// hypotheses.md §46 F125), and dropped a 900k one on Claude Sonnet 5 (§47 F129).
// A conversation of turns that fit holds as much as the model can take: Claude
// read back 1.6M characters sent as 400k-character turns, while GPT-6.x keeps
// about 270k tokens and summarizes what came before (F130). So a turn over the
// limit goes up as several: what comes first is acknowledged, the last one is
// answered.

/** The longest turn sent whole, in UTF-8 bytes. */
export const DEFAULT_TURN_CHUNK_BYTES = 400_000;

/** M365_TURN_CHUNK_BYTES, or the default. 0 sends every turn whole. */
export function turnChunkBytes(): number {
  const raw = process.env.M365_TURN_CHUNK_BYTES?.trim();
  const v = Number(raw);
  return raw && Number.isFinite(v) && v >= 0 ? Math.floor(v) : DEFAULT_TURN_CHUNK_BYTES;
}

/** A turn as sent: `parts` go up first, in order, and the model only acknowledges
 *  them; `final` is the turn it answers. */
export interface TurnPlan {
  parts: string[];
  final: string;
}

/** The UTF-8 length of `s`, without encoding it. */
export function utf8Bytes(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/** `s` cut between code points into pieces of at most `maxBytes`, the first of
 *  at most `firstRoom` (it can be empty). */
function cutByBytes(s: string, maxBytes: number, firstRoom = maxBytes): string[] {
  const out: string[] = [];
  let start = 0;
  let bytes = 0;
  let room = firstRoom;
  for (let i = 0; i < s.length; ) {
    const c = s.codePointAt(i)!;
    const width = c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    if (bytes + width > room && (i > start || room < maxBytes)) {
      out.push(s.slice(start, i));
      start = i;
      bytes = 0;
      room = maxBytes;
    }
    bytes += width;
    i += c >= 0x10000 ? 2 : 1;
  }
  out.push(s.slice(start));
  return out;
}

/** `text` in pieces of at most `maxBytes` UTF-8 bytes, cut at line breaks where
 *  it can be. The pieces join back into `text`. */
export function splitText(text: string, maxBytes: number): string[] {
  const pieces: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (const line of text.split(/(?<=\n)/)) {
    const lineBytes = utf8Bytes(line);
    if (currentBytes + lineBytes <= maxBytes) {
      current += line;
      currentBytes += lineBytes;
    } else if (lineBytes <= maxBytes) {
      if (current) pieces.push(current);
      current = line;
      currentBytes = lineBytes;
    } else {
      // A line that has to be cut anyway: its head fills the current piece,
      // and its tail starts the next one.
      const cuts = cutByBytes(line, maxBytes, maxBytes - currentBytes);
      current += cuts[0];
      if (current) pieces.push(current);
      pieces.push(...cuts.slice(1, -1));
      current = cuts[cuts.length - 1];
      currentBytes = utf8Bytes(current);
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

// The notes around the parts. User voice, no tags: some models read a tagged
// block in a user turn as an injected system prompt (AGENTS.md, Sonnet 5).
const textPartNote = (i: number, n: number) =>
  `[This message is too long to send at once, so it comes in ${n} parts. This is part ${i} of ${n}. Reply with only: OK]`;
const textEndNote = (n: number) =>
  `[This is part ${n} of ${n}, the end of the message. Respond to the whole message now.]`;
const historyPartNote = (i: number, n: number) =>
  `[Earlier conversation, part ${i} of ${n}. This conversation is too long to send in one message, so its earlier messages come first, in ${n} part${n === 1 ? "" : "s"}, and the current request follows. Read this part for context only, don't act on it, and reply with only: OK]`;
const historyEndNote = (n: number) =>
  `[${n === 1 ? "The message" : `The ${n} messages`} before this one carried the earlier part of this conversation. The rest of it, with the current request, follows.]`;

// Room for a note's numbers to grow, and the blank line after it.
const NOTE_SLACK = 16;

/** One turn's text as parts that each fit in `limit` bytes, to be acknowledged,
 *  and the last part, to be answered. Whole when it fits or `limit` is 0. */
export function planText(text: string, limit: number): TurnPlan {
  if (limit <= 0 || utf8Bytes(text) <= limit) return { parts: [], final: text };
  const room = Math.max(1024, limit - utf8Bytes(textPartNote(1, 1)) - NOTE_SLACK);
  const pieces = splitText(text, room);
  const n = pieces.length;
  return {
    parts: pieces.slice(0, -1).map((p, i) => `${textPartNote(i + 1, n)}\n\n${p}`),
    final: `${textEndNote(n)}\n\n${pieces[n - 1]}`,
  };
}

/**
 * A whole history, the opening of a new M365 conversation, as turns that each
 * fit in `limit` bytes. The final turn is the prompt the request would have had,
 * cut short: the leading system messages, the tool framing and as many of the
 * latest messages as fit. The older messages go ahead of it as transcript parts.
 * When not even the system messages and the last message fit, the prompt is cut
 * as plain text instead (planText).
 */
export function planFullPrompt(
  messages: Message[],
  tools: ToolDef[] | undefined,
  toolChoice: ToolChoice | undefined,
  conversationId: string,
  framingVariant: string,
  limit: number,
): TurnPlan {
  const full = formatMessages(messages, tools, toolChoice, conversationId, framingVariant);
  if (limit <= 0 || utf8Bytes(full) <= limit) return { parts: [], final: full };

  let lead = 0;
  while (lead < messages.length && messages[lead].role === "system") lead++;
  const system = messages.slice(0, lead);
  const finalFrom = (k: number) =>
    formatMessages([...system, ...messages.slice(k)], tools, toolChoice, conversationId, framingVariant, messages);
  // Each later message as the transcript renders it: the request's tool specs, no framing.
  const cache = new Map<number, { text: string; bytes: number }>();
  const rendered = (i: number) => {
    let r = cache.get(i);
    if (!r) {
      const text = formatMessages([messages[i]], tools, "none", undefined, framingVariant, messages);
      r = { text, bytes: utf8Bytes(text) };
      cache.set(i, r);
    }
    return r;
  };

  const finalRoom = limit - utf8Bytes(historyEndNote(1)) - NOTE_SLACK;
  let k = messages.length;
  let size = utf8Bytes(finalFrom(k));
  while (k > lead && size + 2 + rendered(k - 1).bytes <= finalRoom) {
    size += 2 + rendered(k - 1).bytes;
    k--;
  }
  if (k === messages.length) return planText(full, limit);
  let final = finalFrom(k);
  while (utf8Bytes(final) > finalRoom && k < messages.length - 1) final = finalFrom(++k);
  if (utf8Bytes(final) > finalRoom) return planText(full, limit);

  const partRoom = limit - utf8Bytes(historyPartNote(1, 1)) - NOTE_SLACK;
  const chunks: string[] = [];
  let current = "";
  let currentBytes = 0;
  for (let i = lead; i < k; i++) {
    const { text, bytes } = rendered(i);
    if (current && currentBytes + 2 + bytes <= partRoom) {
      current += `\n\n${text}`;
      currentBytes += 2 + bytes;
      continue;
    }
    if (current) chunks.push(current);
    if (bytes <= partRoom) {
      current = text;
      currentBytes = bytes;
    } else {
      chunks.push(...splitText(text, partRoom));
      current = "";
      currentBytes = 0;
    }
  }
  if (current) chunks.push(current);
  const n = chunks.length;
  return {
    parts: chunks.map((c, i) => `${historyPartNote(i + 1, n)}\n\n${c}`),
    final: `${historyEndNote(n)}\n\n${final}`,
  };
}
