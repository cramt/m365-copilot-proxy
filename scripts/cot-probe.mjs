// Probe: how a turn's chain of thought arrives, model by model, on the
// transport the proxy uses (Chathub, or StreamHub under M365_TRANSPORT=streamhub).
//
// Sends one turn per model through the proxy's own CopilotSession (so the
// payload is exactly the proxy's), with frame dumping on, then reads the turn's
// dump back and reports every bot message that isn't plain answer text: its
// contentOrigin / messageType / contentType, how its text arrived (snapshot
// lengths, cursor frames naming it, deltas after such a cursor), and when it
// arrived relative to the answer's first text. Chain of thought is the
// `Progress` messages with `contentOrigin: "ChainOfThoughtSummary"` (API doc §6).
//
// Usage (inside `nix develop`, unsandboxed; one fresh conversation per model):
//   M365_AVOID_THROTTLING=1 M365_DEBUG=1 M365_DUMP_FRAMES=1 M365_FRAME_DIR=frames-cot \
//     node scripts/cot-probe.mjs --models claude-sonnet,gpt-5.5-think-deeper [--prompt "…"]
//   node scripts/cot-probe.mjs --analyze <dump.ndjson>…   # offline, no M365 turn
//
// Writes scripts/cot-probe-out/<timestamp>.json (gitignored). Each model costs
// one M365 turn in a fresh conversation; the metered models (Opus 5.5, Sonnet
// 5.5 on the paid scenario) spend one unit of their priority-access budget.

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_PROMPT =
  "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. " +
  "Work out what the ball costs, check your answer, then reply in one sentence.";

const arg = (k, def = null) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

/** The messageId a streaming `cursor` names: `$['<id>'].adaptiveCards[0]…`. */
function cursorId(j) {
  const m = typeof j === "string" ? j.match(/^\$\['([^']+)'\]/) : null;
  return m ? m[1] : null;
}

/**
 * Summarize one turn's frame dump (session.ts's NDJSON, either transport).
 * Returns { transport, tone, requestId, answerFirstAt, messages: [...] } where
 * each message records how its text arrived.
 */
export function analyzeDump(lines) {
  let transport = "chathub";
  let tone = null;
  let requestId = null;
  let t0 = null;
  let target = null;
  let answerFirstAt = null;
  const byId = new Map();
  const msg = (id) => {
    if (!byId.has(id)) byId.set(id, { id, firstAt: null, snapshots: [], cursorRestates: [], deltas: 0, deltaChars: 0, finalLen: null, text: "" });
    return byId.get(id);
  };
  const noteMessage = (m, at, kind, cursorTarget) => {
    if (!m || typeof m !== "object" || !m.messageId) return;
    if (m.author !== "bot" && !(m.author == null && transport === "streamhub")) return;
    const r = msg(m.messageId);
    r.origin = m.contentOrigin ?? r.origin ?? null;
    r.messageType = m.messageType ?? r.messageType ?? null;
    r.contentType = m.contentType ?? r.contentType ?? null;
    if (m.addToChainOfThought !== undefined) r.addToChainOfThought = m.addToChainOfThought;
    if (r.firstAt === null) r.firstAt = at;
    const text = typeof m.text === "string" ? m.text : "";
    if (kind === "final") r.finalLen = text.length;
    else if (cursorTarget === m.messageId) r.cursorRestates.push(text.length);
    else r.snapshots.push(text.length);
    if (text.length >= r.text.length) r.text = text;
    if (typeof m.hiddenText === "string" && m.hiddenText) r.hiddenText = m.hiddenText.slice(0, 200);
    if (!m.messageType && text && answerFirstAt === null && kind !== "final") answerFirstAt = at;
  };
  const noteArg = (a, at) => {
    if (!a || typeof a !== "object") return;
    const cur = cursorId(a.cursor?.j);
    if (cur) target = cur;
    const delta = typeof a.writeAtCursor === "string" ? a.writeAtCursor : typeof a.w === "string" ? a.w : null;
    if (delta !== null) {
      const r = msg(target ?? "(no cursor)");
      if (r.firstAt === null) r.firstAt = at;
      r.deltas++;
      r.deltaChars += delta.length;
      if (!r.messageType && delta && answerFirstAt === null) answerFirstAt = at;
      return;
    }
    for (const m of Array.isArray(a.messages) ? a.messages : []) noteMessage(m, at, "update", cur);
  };
  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const f = o?.frame;
    if (!f || typeof f !== "object") continue;
    if (o.dir === "send") {
      if (f.target === "chat") { tone = f.arguments?.[0]?.tone ?? tone; requestId = f.arguments?.[0]?.message?.requestId ?? requestId; }
      if (f.item?.type === "chat_request") {
        transport = "streamhub";
        tone = f.item.chatStreamRequest?.tone ?? tone;
        requestId = f.item.chatStreamRequest?.requestId ?? requestId;
      }
      continue;
    }
    if (t0 === null) t0 = o.t;
    const at = o.t - t0;
    if (f.type === 1 && f.target === "update") {
      for (const a of f.arguments ?? []) noteArg(a, at);
    } else if (f.type === 2 && f.item?.type) {
      const item = f.item;
      const rid = typeof item.requestId === "string" ? item.requestId.replace(/-/g, "").toLowerCase() : null;
      if (rid && requestId && rid !== requestId.replace(/-/g, "").toLowerCase()) continue; // a replayed earlier turn
      if (item.type === "message_part") noteArg(item.argument, at);
    } else if (f.type === 2) {
      for (const m of f.item?.messages ?? []) noteMessage(m, at, "final", null);
    }
  }
  const messages = [...byId.values()].map((r) => ({
    ...r,
    text: r.text.slice(0, 600),
    beforeAnswer: answerFirstAt === null || (r.firstAt ?? Infinity) <= answerFirstAt,
  }));
  return { transport, tone, requestId, answerFirstAt, messages };
}

function printSummary(label, s) {
  console.log(`\n=== ${label}: transport=${s.transport} tone=${s.tone} answerFirstAt=${s.answerFirstAt}ms`);
  for (const m of s.messages) {
    if (!m.messageType && !m.origin?.startsWith("ChainOfThought") && m.origin !== "DeepLeo") continue;
    const kind = [m.origin, m.messageType, m.contentType].filter(Boolean).join("/") || "(content)";
    const how = `snap=[${m.snapshots.join(",")}] restate=[${m.cursorRestates.join(",")}] deltas=${m.deltas}/${m.deltaChars}ch final=${m.finalLen}`;
    console.log(`  ${String(m.firstAt).padStart(6)}ms ${kind.padEnd(44)} ${how}${m.beforeAnswer ? " (before answer)" : ""}`);
    if (m.origin === "ChainOfThoughtSummary") console.log(`           ${JSON.stringify(m.text.slice(0, 240))}`);
  }
}

async function live() {
  const ROOT = pathToFileURL(process.cwd()).href;
  const core = await import(`${ROOT}/packages/core/dist/index.mjs`);
  const { getToken, CopilotSession, awaitTurnBudget, FRAME_DIR, getTransport } = core;
  if (!process.env.M365_DUMP_FRAMES) throw new Error("set M365_DUMP_FRAMES=1: the probe reads the turn back from its frame dump");
  const models = (arg("--models", "claude-sonnet") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const prompt = arg("--prompt", DEFAULT_PROMPT);
  const out = [];
  for (const model of models) {
    await awaitTurnBudget();
    const token = await getToken();
    const before = new Set(safeList(FRAME_DIR));
    const t = Date.now();
    let error = null;
    let stream = null;
    try {
      stream = await new CopilotSession().chat(token, prompt, model);
      for await (const _ of stream) { /* drain */ }
    } catch (e) {
      error = e?.message ?? String(e);
    }
    const dump = safeList(FRAME_DIR).filter((f) => !before.has(f)).map((f) => join(FRAME_DIR, f))
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).pop();
    const s = dump ? analyzeDump(readFileSync(dump, "utf8").split("\n")) : null;
    const row = {
      model, transport: getTransport(), elapsedMs: Date.now() - t, error, dump,
      result: stream?.result ?? null, answer: (stream?.fullText ?? "").slice(0, 400),
      summary: s,
    };
    out.push(row);
    if (s) printSummary(model, s);
    console.log(`  result=${JSON.stringify(row.result)} elapsed=${row.elapsedMs}ms error=${error} answer=${JSON.stringify(row.answer.slice(0, 160))}`);
  }
  const dir = resolve("scripts", "cot-probe-out");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${file}`);
}

function safeList(dir) {
  try { return readdirSync(dir).filter((f) => f.endsWith(".ndjson")); } catch { return []; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const i = process.argv.indexOf("--analyze");
  if (i >= 0) {
    for (const f of process.argv.slice(i + 1)) printSummary(f, analyzeDump(readFileSync(f, "utf8").split("\n")));
  } else {
    await live();
    process.exit(0);
  }
}
