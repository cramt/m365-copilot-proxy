// RE probe: which priority-access budget does a route spend?
//
// A route is a transport, a scenario and a tone. StreamHub carries no
// `metering` map (API doc §13), so a StreamHub turn can't say what it spent.
// Chathub's paid scenario can: its final item carries the whole map (API doc
// §5, priority access) on every turn, whatever the tone. So this probe runs the
// cells of a plan one at a time, and a `read` cell (a Chathub paid-scenario turn
// on `Gpt_5_5_Chat`, which no budget counts) reads the allowances between them.
// Each budget key that changed between two readings is printed against the
// cells that ran in between. A Chathub paid-scenario cell reads the map itself.
//
// A cell is `<transport>@<scenario>:<tone>[:<prompt>][:nobing]`:
//   transport  chathub | streamhub
//   scenario   paid (OfficeWebPaidCopilot + Premium) | included
//              (OfficeWebIncludedCopilot + Starter) | officeweb (officeweb + Premium)
//   prompt     pong (default) | id (self-ID, training cutoff, and two events of
//              February 2026, from memory: a test of the training cutoff)
//              | story (about 400 words: the answer's characters per second,
//              from its first text frame to its last, measure the model's output speed)
//              | recent (seven events from 2025 to April 2026, from memory: two a
//              model with a 2025 cutoff knows, five only a later one does)
//   nobing     send no Bing plugin (the proxy sends it on agent-less turns)
// Agent-less, one fresh conversation per cell, cells in plan order.
//
// Usage (inside `nix develop`, unsandboxed; a premium account only: a non-premium
// account is refused every Claude tone):
//   node scripts/metering-probe.mjs --plan read,streamhub@paid:Claude_Opus:id,read [--gap 45]
//
// Cost: one M365 turn per cell, and each cell on a metered route spends one unit
// of its budget (Opus 5.5: 40 a day, 75 a week). Writes
// scripts/metering-out/<timestamp>/ (gitignored): results.json and each turn's
// frames as NDJSON.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getToken, decodeJwt } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

const SCENARIOS = {
  paid: { scenario: "OfficeWebPaidCopilot", licenseType: "Premium" },
  included: { scenario: "OfficeWebIncludedCopilot", licenseType: "Starter" },
  officeweb: { scenario: "officeweb", licenseType: "Premium" },
};

const PROMPTS = {
  pong: "Reply with exactly the single word: pong",
  id:
    "Answer from memory, without searching the web, on four numbered lines:\n" +
    "1. The exact name and version of the model you run on.\n" +
    "2. Your training-data cutoff (YYYY-MM).\n" +
    "3. Who won Super Bowl LX (February 2026), and the final score, or Unknown.\n" +
    "4. Which country won the most gold medals at the 2026 Winter Olympics, or Unknown.",
  story: "Write a story of about 400 words about a lighthouse keeper. Plain prose, no title, no headings.",
  recent:
    "Answer from memory, without searching the web, one numbered line each; write Unknown where you aren't sure:\n" +
    "1. Who won the 2025 Nobel Prize in Literature?\n" +
    "2. Who won the 2025 men's Ballon d'Or?\n" +
    "3. Who won the men's singles at the 2026 Australian Open?\n" +
    "4. Who won Super Bowl LX (February 2026), and the final score?\n" +
    "5. Which country won the most gold medals at the 2026 Winter Olympics?\n" +
    "6. Which film won Best Picture at the Academy Awards ceremony held in March 2026?\n" +
    "7. Which party won the most seats in Hungary's April 2026 parliamentary election?",
};

const READ = "chathub@paid:Gpt_5_5_Chat:pong";

/** The budgets the summary names; any other key that changes is printed too. */
const WATCHED = ["ClaudeOpusQueryDaily", "ClaudeOpusQuery75", "ClaudeSonnet55QueryDaily", "ClaudeSonnet55QueryWeekly"];

export function parseCell(spec) {
  const s = spec === "read" ? READ : spec;
  const m = s.match(/^(chathub|streamhub)@(paid|included|officeweb):([A-Za-z0-9_]+)((?::(?:pong|id|story|recent|nobing))*)$/);
  if (!m) throw new Error(`Bad cell ${JSON.stringify(spec)}: use <transport>@<scenario>:<tone>[:<prompt>][:nobing]`);
  const flags = m[4].split(":").filter(Boolean);
  return {
    spec,
    transport: m[1],
    scenarioKey: m[2],
    ...SCENARIOS[m[2]],
    tone: m[3],
    prompt: flags.find((f) => f in PROMPTS) ?? "pong",
    bing: !flags.includes("nobing"),
    read: spec === "read",
  };
}

/** `{key: remainingAllowance}` from a raw `metering` object. */
export function allowances(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v?.remainingAllowance === "number") out[k] = v.remainingAllowance;
  }
  return Object.keys(out).length ? out : null;
}

/** Keys whose allowance differs between two readings: `{key: [before, after]}`. */
export function changed(before, after) {
  const out = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[k] !== after[k]) out[k] = [before[k] ?? null, after[k] ?? null];
  }
  return out;
}

/**
 * What a turn's frames say beyond the answer: the chain-of-thought text, per
 * message, and every field whose name mentions a model, with its values.
 */
function frameNotes(frames) {
  const cot = new Map();
  const modelFields = new Map();
  const walk = (v, depth) => {
    if (!v || typeof v !== "object" || depth > 12) return;
    if (v.contentOrigin === "ChainOfThoughtSummary" && typeof v.text === "string") {
      const id = String(v.messageId ?? "");
      if ((cot.get(id) ?? "").length < v.text.length) cot.set(id, v.text);
    }
    for (const [k, child] of Object.entries(v)) {
      if (/model/i.test(k) && (typeof child === "string" || typeof child === "number" || typeof child === "boolean")) {
        const set = modelFields.get(k) ?? new Set();
        set.add(String(child).slice(0, 120));
        modelFields.set(k, set);
      }
      if (child && typeof child === "object") walk(child, depth + 1);
    }
  };
  for (const f of frames) walk(f, 0);
  return {
    chainOfThought: [...cot.values()],
    modelFields: Object.fromEntries([...modelFields].map(([k, s]) => [k, [...s]])),
  };
}

/** Whether a streaming argument (a Chathub `update`'s, a StreamHub `message_part`'s) carries answer text. */
function carriesAnswer(a) {
  if (!a || typeof a !== "object") return false;
  if ((typeof a.w === "string" && a.w) || (typeof a.writeAtCursor === "string" && a.writeAtCursor)) return true;
  return Array.isArray(a.messages) && a.messages.some((m) =>
    m?.author === "bot" && !m.messageType && m.contentOrigin !== "ChainOfThoughtSummary" && typeof m.text === "string" && m.text);
}

/**
 * When the answer's first and last text arrived, in ms after the turn's first
 * frame, from `{t, f}` records. Chathub's final item restates the answer after
 * the stream, so only streaming frames count.
 */
export function textTiming(records) {
  if (!records.length) return { firstTextMs: null, lastTextMs: null, answerCompleteMs: null };
  const t0 = records[0].t;
  let first = null;
  let last = null;
  let complete = null;
  for (const { t, f } of records) {
    if (f?.type === 2 && f.item?.type === "answer_complete") complete ??= t - t0;
    const args = f?.type === 2 && f.item?.type === "message_part" ? [f.item.argument]
      : f?.type === 1 && f.target === "update" && Array.isArray(f.arguments) ? f.arguments : [];
    if (!args.some(carriesAnswer)) continue;
    first ??= t - t0;
    last = t - t0;
  }
  // StreamHub only: `answer_complete` (Chathub has no such item).
  return { firstTextMs: first, lastTextMs: last, answerCompleteMs: complete };
}

async function main() {
  const arg = (k, def) => {
    const i = process.argv.indexOf(k);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
  };
  const plan = arg("--plan", "").split(",").filter(Boolean).map(parseCell);
  if (!plan.length) throw new Error("Pass --plan <cell>,<cell>,…");
  const gapMs = Number(arg("--gap", "45")) * 1000;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const out = join(process.cwd(), "scripts", "metering-out", ts);
  mkdirSync(out, { recursive: true });

  const token = await getToken();
  const claims = decodeJwt(token);
  const rows = [];
  let lastReading = null;
  let since = [];

  for (const [i, cell] of plan.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
    const frames = [];
    const startedAt = new Date().toISOString();
    const r = await oneTurn({
      token, claims, agentId: null,
      transport: cell.transport, scenario: cell.scenario, licenseType: cell.licenseType,
      tone: cell.tone, text: PROMPTS[cell.prompt], timeoutMs: 120000,
      ...(cell.bing ? {} : { plugins: [] }),
      onFrame: (f) => frames.push({ t: Date.now(), f }),
    });
    const name = `${String(i).padStart(2, "0")}-${cell.transport}-${cell.scenarioKey}-${cell.tone}`;
    writeFileSync(join(out, `${name}.ndjson`), frames.map((x) => JSON.stringify(x)).join("\n") + "\n");
    const notes = frameNotes(frames.map((x) => x.f));
    const metering = allowances(r.throttle?.metering);
    const timing = textTiming(frames);
    const reply = (r.fullText || "").trim();
    const streamMs = timing.firstTextMs !== null ? timing.lastTextMs - timing.firstTextMs : null;
    const row = {
      i, ...cell, startedAt, transport: r.transport, elapsedMs: r.elapsedMs, ...timing,
      charsPerSec: streamMs ? Math.round((reply.length / streamMs) * 1000) : null,
      reply, contentOrigin: r.contentOrigin, result: r.result,
      messageTypes: r.messageTypes, searched: r.messageTypes.some((t) => /SearchQuery/.test(t)),
      billing: r.billing, serviceVersion: r.serviceVersion, error: r.error,
      metering, ...notes,
    };
    rows.push(row);

    const watched = metering ? WATCHED.filter((k) => k in metering).map((k) => `${k}=${metering[k]}`).join(" ") : "no metering";
    console.log(
      `[meter] #${i} ${cell.spec.padEnd(44)} ${String(r.elapsedMs).padStart(6)}ms origin=${r.contentOrigin} ` +
      `result=${r.result?.value ?? "-"}${r.result?.errorCode ? "/" + r.result.errorCode : ""} cot=${notes.chainOfThought.length} ` +
      `searched=${row.searched} billing=${r.billing.length} ${watched}`,
    );
    if (cell.prompt === "story") {
      console.log(`        story: ${reply.length} chars, first text at ${timing.firstTextMs} ms, last at ${timing.lastTextMs} ms ` +
        `(${row.charsPerSec} chars/s), answer_complete at ${timing.answerCompleteMs} ms`);
    } else if (cell.prompt === "id" || cell.prompt === "recent" || !cell.read) {
      console.log(`        reply: ${JSON.stringify(reply.slice(0, cell.prompt === "recent" ? 900 : 400))}`);
    }
    if (Object.keys(notes.modelFields).length) console.log(`        model fields: ${JSON.stringify(notes.modelFields)}`);

    if (metering) {
      if (lastReading) {
        const diff = changed(lastReading, metering);
        const ran = since.map((c) => `#${c.i} ${c.spec}`).join(", ") || "(nothing)";
        console.log(`        since the last reading (${ran}${cell.read ? "" : `, #${i} ${cell.spec}`}): ` +
          (Object.keys(diff).length ? JSON.stringify(diff) : "no budget key changed"));
        row.changedSinceLastReading = diff;
      }
      lastReading = metering;
      since = [];
    } else {
      since.push({ i, spec: cell.spec });
    }
  }

  writeFileSync(join(out, "results.json"), JSON.stringify(rows, null, 2));
  console.log(`[meter] out: ${out}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
