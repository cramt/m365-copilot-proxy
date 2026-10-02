// RE probe: which `tone` strings does our Copilot Studio tool agent honour?
//
// tone-probe.mjs asks "is this tone a real model?" with NO agent. This asks the
// question the proxy depends on for tool calls: with the declarative agent
// attached (threadLevelGptId + gpts[], exactly what session.ts sends on a tool
// request), does the tone still reach the model it names? June 2026 said no for
// Claude — agent + Claude_Sonnet self-identified as GPT-5 (API doc §5). On
// 2026-10-01 the answer depended on the ACCOUNT: a premium account gets Claude
// through the agent, a non-premium one gets a dead route (hypotheses §22). So
// say which account a result came from.
//
// Attaching the agent adds failure modes tone-probe never sees, so a reply is
// classified on more than "did it answer":
//   REJECTED             type:3 error — the validator says no such tone
//   REGISTERED_BUT_DEAD  BotConnection apology — the route serves nothing
//   UNLICENSED           result ForbiddenRequest/InvalidCopilotLicense — this
//                        ACCOUNT can't use the cell's scenario at all (a paid
//                        cell on a non-premium account). Says nothing about the
//                        agent; run the cell on a premium account
//   AGENT_DROPPED        a real answer, but not tagged 3PDeclarativeAgent —
//                        something other than our agent handled the turn
//   OVERRIDDEN(x)        (--baseline) the agent turn self-identifies as x, but
//                        the same tone agent-less does not: the agent changed it
//   WRONG_MODEL(x)       (no baseline) self-identifies as x, not what the tone
//                        is named after. NOT attributable to the agent: the tone
//                        may serve x agent-less too. Re-run the cell with
//                        --baseline to find out
//   VERSION_MISMATCH(x)  (no baseline) right family, wrong stated GPT major
//                        version — may just be the model misremembering
//   UNIDENTIFIED         agent-handled, but the reply names no model
//   SUPPORTED            agent-handled, self-ID consistent with the tone (or,
//                        with --baseline, with the tone's agent-less self-ID)
// With --baseline, a tone that isn't what its name says EVEN AGENT-LESS is
// flagged separately ("tone itself serves x") — that's a MODEL_TONES problem,
// not an agent one.
//
// So the prompt is a self-ID question rather than `pong`: "it answered" proves
// only that *a* model answered (§12.15, Claude_Fable).
//
// The invalid-tone CONTROL matters more here than agent-less: if the agent path
// ANSWERS an invalid tone, it ignores `tone` altogether, and every SUPPORTED
// row is just the agent's own default model.
//
// Usage: M365_NO_INTERACTIVE=1 CHROMIUM_PATH=$(which chromium) node scripts/agent-tone-probe.mjs \
//          [--tones=Gpt_5_6_Chat,Claude_Sonnet@paid] [--baseline] [--cooldown-ms=5000]
//   --tones     probe these instead of the default list; `@paid` / `@included`
//               pins the scenario, otherwise it's what the proxy would send
//   --baseline  also run every cell agent-less and compare self-IDs (2x cost)
// Cost: 1 message AND 1 fresh conversation per cell (2 with --baseline), so it
// spends the thread-rate budget (F13) — don't loop it. The sweep stops at the
// first Throttled turn. Claude_Opus@paid can spend Opus priority access (§15)
// if the agent lets the tone through.
//
// Everything but the sweep is exported, so a saved run can be re-classified and
// re-summarized without spending threads:
//   import { summarize, reclassify } from "./agent-tone-probe.mjs";
//   console.log(summarize(reclassify(JSON.parse(readFileSync(".../results.json")))).join("\n"));
// Importing it runs nothing.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  getToken,
  decodeJwt,
  getOrCreateAgent,
  getScenarioForTone,
  parsePriorityAccessExhaustion,
} from "../packages/core/dist/index.mjs";

const INCLUDED = { scenario: "OfficeWebIncludedCopilot", licenseType: "Starter" };
const PAID = { scenario: "OfficeWebPaidCopilot", licenseType: "Premium" };
export const CONTROL_TONE = "Definitely_Not_A_Real_Tone_XYZ";

const PROMPT =
  "Which AI model are you exactly? State your underlying model name and version and the company that made you, in one short sentence. Do not add anything else.";

/** @type {{tone: string, note: string, scenario?: string, licenseType?: string}[]} */
export const DEFAULT_CELLS = [
  { tone: "magic", note: "proxy default (m365-copilot) — the agent's home path" },
  { tone: "Gpt_5_5_Chat", note: "quick / gpt-5.5" },
  { tone: "Gpt_5_5_Reasoning", note: "think-deeper / gpt-5.5-think-deeper" },
  { tone: "Gpt_5_6_Chat", note: "gpt-5.6", ...INCLUDED },
  { tone: "Gpt_5_6_Chat", note: "gpt-5.6 — paid scenario", ...PAID },
  { tone: "Gpt_5_6_Reasoning", note: "gpt-5.6-think-deeper" },
  { tone: "Gpt_6_Reasoning", note: "gpt-6-think-deeper (paid — the only scenario it serves on)" },
  // Serves with the agent on a premium account, dead route on a non-premium
  // one (#23) — the proxy learns which at runtime (PREMIUM_ONLY_AGENT_TONES).
  { tone: "Gpt_6_Sol_Reasoning", note: "gpt-6-sol — agent only on a premium account" },
  // One tone, two models agent-less: Sonnet 4.6 included, Sonnet 5 paid (§21).
  { tone: "Claude_Sonnet", note: "claude-sonnet (Sonnet 4.6 agent-less)", ...INCLUDED },
  { tone: "Claude_Sonnet", note: "claude-sonnet-5 (Sonnet 5 agent-less)", ...PAID },
  { tone: "Claude_Opus", note: "claude-opus (paid) — may spend priority access" },
  { tone: CONTROL_TONE, note: "CONTROL: invalid tone" },
];

export function parseCells(spec) {
  return spec.split(",").map((s) => s.trim()).filter(Boolean).map((s) => {
    const [tone, where] = s.split("@");
    const pin = where === "paid" ? PAID : where === "included" ? INCLUDED : {};
    if (where && !pin.scenario) throw new Error(`unknown scenario "@${where}" — use @paid or @included`);
    return { tone, note: "from --tones", ...pin };
  });
}

// --- classification ----------------------------------------------------------

/** What the reply says it is. Family is reliable; versions are the model's guess. */
export function selfId(text) {
  const claude = /\b(claude|anthropic)\b/i.test(text);
  const gpt = /\b(gpt|openai|chatgpt)\b/i.test(text);
  const family = claude && gpt ? "ambiguous" : claude ? "claude" : gpt ? "gpt" : "unknown";
  // Replies use typographic hyphens ("GPT‑5", U+2011) as often as ASCII ones.
  const gptVersion = text.match(/\bGPT[\s\-\u2010-\u2015]?(\d+(?:\.\d+)?)/i)?.[1] ?? null;
  const cm = text.match(/\b(Sonnet|Opus|Haiku|Fable)\b(?:\s*(\d+(?:\.\d+)?))?/i);
  const claudeModel = cm ? [cm[1].toLowerCase(), cm[2]].filter(Boolean).join(" ") : null;
  return { family, gptVersion, claudeModel };
}

const majorOf = (v) => (v ? v.split(".")[0] : null);

/** What the tone's NAME claims. `magic` routes itself; the control is nothing. */
function expectedFromTone(tone) {
  if (/^Claude_/i.test(tone)) return { family: "claude" };
  const gpt = tone.match(/^Gpt_(\d+)/i);
  if (gpt) return { family: "gpt", gptMajor: gpt[1] };
  return null;
}

/** What a turn MEASURED itself as, in the same shape as expectedFromTone. */
const expectedFromTurn = (t) => ({ family: t.id.family, gptMajor: majorOf(t.id.gptVersion), claudeModel: t.id.claudeModel });

/**
 * Compare a self-ID against an expectation, only at the granularity both state
 * ("Claude Sonnet" doesn't contradict "Sonnet 4.6"). `level` says how strong the
 * mismatch is: a family or Claude-model mismatch is a different model; a GPT
 * major-version mismatch may be the model misremembering its own version.
 */
function identityMismatch(id, want) {
  if (!want || ["unknown", "ambiguous"].includes(id.family)) return null;
  if (want.family && !["unknown", "ambiguous"].includes(want.family) && id.family !== want.family) {
    return { level: "family", what: id.family };
  }
  const gotMajor = majorOf(id.gptVersion);
  if (want.gptMajor && gotMajor && gotMajor !== want.gptMajor) {
    return { level: "version", what: `GPT-${id.gptVersion}` };
  }
  if (want.claudeModel && id.claudeModel) {
    const [wantName, wantVer] = want.claudeModel.split(" ");
    const [gotName, gotVer] = id.claudeModel.split(" ");
    if (wantName !== gotName || (wantVer && gotVer && wantVer !== gotVer)) {
      return { level: "model", what: id.claudeModel };
    }
  }
  return null;
}

/** Turn-level outcome, before any question of identity. */
export function outcome(t) {
  if (t.error === "timeout") return "TIMEOUT";
  if (t.error) return "REJECTED";
  if (t.result?.value === "Throttled") return "THROTTLED";
  // Before the BotConnection check: the licence refusal ALSO comes from
  // BotConnection, but it's about the account, not the route (§22).
  if (t.result?.errorCode === "InvalidCopilotLicense") return "UNLICENSED";
  const text = t.reply.trim();
  if (!text) return t.disengaged ? "DISENGAGED" : "EMPTY";
  if (parsePriorityAccessExhaustion(text)) return "QUOTA_EXHAUSTED";
  if (t.answerOrigin === "BotConnection") return "REGISTERED_BUT_DEAD";
  return "ANSWERED";
}

const answered = (t) => !!t && outcome(t) === "ANSWERED";

export function verdict(cell, agentTurn, baselineTurn) {
  const o = outcome(agentTurn);
  if (o !== "ANSWERED") return o;
  if (!agentTurn.agentHandled) return "AGENT_DROPPED";
  if (cell.tone === CONTROL_TONE) return "ANSWERED";
  if (answered(baselineTurn)) {
    // The question is exactly "does attaching the agent change the model?", so
    // compare against what the same tone said agent-less — not its name.
    const miss = identityMismatch(agentTurn.id, expectedFromTurn(baselineTurn));
    if (miss) return `OVERRIDDEN(${miss.what})`;
  } else {
    // Only the tone's name to go on, and a mismatch can't be pinned on the agent:
    // the tone may not serve what it's named after even agent-less.
    const miss = identityMismatch(agentTurn.id, expectedFromTone(cell.tone));
    if (miss) return `${miss.level === "version" ? "VERSION_MISMATCH" : "WRONG_MODEL"}(${miss.what})`;
  }
  if (agentTurn.id.family === "unknown") return "UNIDENTIFIED";
  return "SUPPORTED";
}

/**
 * The tone itself isn't what its name says — measured agent-less, so it's not
 * the agent's doing.
 */
export function toneMisnamed(cell, baselineTurn) {
  if (!answered(baselineTurn)) return null;
  const miss = identityMismatch(baselineTurn.id, expectedFromTone(cell.tone));
  return miss && miss.level !== "version" ? miss.what : null;
}

/** One sweep row from a cell and its turns (`baseline` may be null). */
export function classifyRow(cell, agent, baseline) {
  return {
    tone: cell.tone, note: cell.note,
    verdict: verdict(cell, agent, baseline),
    toneMisnamed: toneMisnamed(cell, baseline),
    agent, baseline,
  };
}

/**
 * Re-run classification over a saved results.json. Rows from older runs keep
 * their raw turns, so the current rules apply to them too — self-ID included,
 * since it is re-read from the reply.
 */
export function reclassify(saved) {
  const reread = (t) => t && { ...t, id: selfId(t.reply ?? "") };
  return {
    ...saved,
    results: saved.results.map((r) => classifyRow({ tone: r.tone, note: r.note }, reread(r.agent), reread(r.baseline))),
  };
}

// --- reporting ---------------------------------------------------------------

const short = (s, n = 90) => JSON.stringify(s.length > n ? `${s.slice(0, n)}…` : s);
// The final item's result.value: "Success" is the norm, so only show the rest
// (a dead route under the agent comes back "InternalError", not an error frame).
const resultTag = (t) => (t.result && t.result.value !== "Success" ? ` result=${t.result.value}${t.result.errorCode ? `/${t.result.errorCode}` : ""}` : "");

/** The per-cell lines printed as the sweep goes. */
export function cellLines({ tone, verdict: v, agent, baseline }) {
  const lines = [
    `[agent-tone] ${tone.padEnd(30)} ${agent.scenario.padEnd(25)} ${v.padEnd(22)} ` +
    `origin=${agent.answerOrigin} agentTag=${agent.agentNames.join("|") || "-"}${resultTag(agent)} ${agent.elapsedMs}ms` +
    `${agent.error ? ` ERR=${agent.error}` : ""} reply=${short(agent.reply)}`,
  ];
  if (baseline) {
    lines.push(`[agent-tone] ${"".padEnd(30)} ${"  └ agent-less".padEnd(25)} ${outcome(baseline).padEnd(22)} origin=${baseline.answerOrigin}${resultTag(baseline)} ${baseline.elapsedMs}ms reply=${short(baseline.reply)}`);
  }
  return lines;
}

// Only verdicts that pin the failure on the agent count as NOT SUPPORTED. An
// UNLICENSED cell is about the account, and the rest (identity unclear, turn
// didn't complete) say nothing either way.
const NOT_SUPPORTED = /^(REJECTED|REGISTERED_BUT_DEAD|AGENT_DROPPED|OVERRIDDEN)/;
export const bucket = (v) =>
  v === "SUPPORTED" ? "SUPPORTED" : v === "UNLICENSED" ? "UNLICENSED" : NOT_SUPPORTED.test(v) ? "NOT SUPPORTED" : "INCONCLUSIVE";
const describeId = ({ family, gptVersion, claudeModel }) =>
  family === "unknown" ? "" : ` self-ID=${[family, gptVersion ?? claudeModel].filter(Boolean).join(" ")}`;

/** The end-of-sweep verdict block, as lines. Pure: takes a results.json object. */
export function summarize({ account, baseline: ranBaseline, results }) {
  const out = [`[agent-tone] === VERDICT (agent attached${account ? `, ${account}` : ""}) ===`];
  const control = results.find((r) => r.tone === CONTROL_TONE);
  if (control) {
    out.push(
      control.verdict === "REJECTED"
        ? `[agent-tone] control (invalid tone): REJECTED → the agent path still validates tones, so the rows below are about the tone`
        : `[agent-tone] control (invalid tone): ${control.verdict} → the agent path does NOT validate tones; treat every row below with suspicion`,
    );
  }
  for (const r of results) {
    if (r.tone === CONTROL_TONE) continue;
    const b = bucket(r.verdict);
    const misnamed = r.toneMisnamed ? ` — tone itself serves ${r.toneMisnamed} agent-less (not the agent's doing)` : "";
    out.push(`  ${b.padEnd(14)} ${`${r.tone} @ ${r.agent.scenario}`.padEnd(52)} ${["SUPPORTED", "UNLICENSED"].includes(b) ? "" : r.verdict}${describeId(r.agent.id)}${misnamed}`.trimEnd());
  }
  // A cell this account isn't licensed for can't differ "by scenario" in any
  // sense that matters to the agent, so leave those out of the comparison.
  for (const tone of new Set(results.map((r) => r.tone))) {
    const cells = results.filter((r) => r.tone === tone && r.verdict !== "UNLICENSED");
    if (cells.length > 1 && new Set(cells.map((c) => c.verdict)).size > 1) {
      out.push(`[agent-tone] SCENARIO-SENSITIVE: ${tone} → ${cells.map((c) => `${c.agent.scenario}=${c.verdict}`).join(", ")}`);
    }
  }
  const unlicensed = [...new Set(results.filter((r) => r.verdict === "UNLICENSED").map((r) => r.agent.scenario))];
  if (unlicensed.length) {
    out.push(`[agent-tone] UNLICENSED: ${account ?? "this account"} can't use ${unlicensed.join(", ")} at all (InvalidCopilotLicense). Those cells say nothing about the agent; run them on an account that has the licence.`);
  }
  if (!ranBaseline && results.some((r) => /^(WRONG_MODEL|VERSION_MISMATCH)/.test(r.verdict))) {
    out.push(`[agent-tone] re-run the WRONG_MODEL / VERSION_MISMATCH cells with --baseline to tell an agent override from a misnamed tone.`);
  }
  return out;
}

// --- one probe turn ----------------------------------------------------------

/** Pull the agent tag, every contentOrigin and the final result out of a frame. */
function scanFrame(frame, acc) {
  const walk = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) { for (const v of o) walk(v); return; }
    if (o.author === "bot") {
      if (o.contentOrigin) acc.origins.add(o.contentOrigin);
      for (const g of Array.isArray(o.gptIdentifiers) ? o.gptIdentifiers : []) {
        if (g?.compliantAgentName) acc.agentNames.add(g.compliantAgentName);
      }
    }
    if (o.result && typeof o.result.value === "string") {
      acc.result = { value: o.result.value, errorCode: o.result.errorCode ?? null };
    }
    for (const v of Object.values(o)) walk(v);
  };
  walk(frame);
}

async function probeTurn({ oneTurn, token, claims, agentId, cell, framesFile }) {
  const scenario = cell.scenario ?? getScenarioForTone(cell.tone).scenario;
  const licenseType = cell.licenseType ?? getScenarioForTone(cell.tone).licenseType;
  const acc = { origins: new Set(), agentNames: new Set(), result: null };
  const frames = [];
  const r = await oneTurn({
    token, claims, agentId, tone: cell.tone, scenario, licenseType,
    timeoutMs: 90000, text: PROMPT,
    onFrame: (f) => { frames.push(f); scanFrame(f, acc); },
  });
  writeFileSync(framesFile, frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
  const reply = (r.fullText || "").trim();
  return {
    scenario, licenseType,
    reply,
    id: selfId(reply),
    answerOrigin: r.contentOrigin,
    origins: [...acc.origins].sort(),
    agentNames: [...acc.agentNames].sort(),
    agentHandled: acc.agentNames.has("3PDeclarativeAgent") || acc.origins.has("3PDeclarativeAgent"),
    result: acc.result,
    disengaged: r.disengaged,
    messageTypes: r.messageTypes,
    error: r.error,
    elapsedMs: r.elapsedMs,
    serviceVersion: r.serviceVersion,
  };
}

// --- sweep -------------------------------------------------------------------

async function main(argv) {
  const flag = (name) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  const flagValue = (name) => flag(name)?.split("=").slice(1).join("=");
  const BASELINE = !!flag("baseline");
  const COOLDOWN_MS = Number(flagValue("cooldown-ms") ?? 5000);
  const CELLS = flagValue("tones") ? parseCells(flagValue("tones")) : DEFAULT_CELLS;

  // Loaded here, not at the top: _probe-chat resolves `ws` from the cwd, and
  // importing this module for its classifiers shouldn't depend on that.
  const { oneTurn } = await import("./_probe-chat.mjs");

  const TS = new Date().toISOString().replace(/[:.]/g, "-");
  const OUT = join(process.cwd(), "scripts", "agent-tone-out", TS);
  mkdirSync(OUT, { recursive: true });

  const token = await getToken();
  const claims = decodeJwt(token);
  // Results depend on the account's licence (§22), so every run records whose it was.
  const account = claims.upn ?? claims.name ?? claims.oid;
  const agentId = await getOrCreateAgent();
  if (!agentId) {
    console.error("[agent-tone] no agent — getOrCreateAgent() returned null (see M365_DEBUG log)");
    process.exit(1);
  }
  console.log(`[agent-tone] account=${account}`);
  console.log(`[agent-tone] agent=${agentId}`);
  console.log(`[agent-tone] ${CELLS.length} cells${BASELINE ? " × 2 (agent + agent-less baseline)" : ""}, cooldown ${COOLDOWN_MS}ms\n`);

  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const results = [];
  let stoppedEarly = false;

  for (const [i, cell] of CELLS.entries()) {
    const slug = `${String(i).padStart(2, "0")}-${cell.tone}-${cell.scenario ?? "default"}`;
    if (i > 0) await sleep(COOLDOWN_MS);
    const agent = await probeTurn({ oneTurn, token, claims, agentId, cell, framesFile: join(OUT, `${slug}.agent.jsonl`) });

    let baseline = null;
    if (BASELINE && agent.result?.value !== "Throttled") {
      await sleep(COOLDOWN_MS);
      baseline = await probeTurn({ oneTurn, token, claims, agentId: null, cell, framesFile: join(OUT, `${slug}.agentless.jsonl`) });
    }

    const row = classifyRow(cell, agent, baseline);
    results.push(row);
    for (const line of cellLines(row)) console.log(line);
    if ([agent, baseline].some((t) => t?.result?.value === "Throttled")) {
      console.log(`\n[agent-tone] THROTTLED (${agent.result?.errorCode ?? baseline?.result?.errorCode}) — stopping; later cells would read as failures. A fresh login clears it (AGENTS.md).`);
      stoppedEarly = true;
      break;
    }
  }

  const run = { account, agentId, prompt: PROMPT, baseline: BASELINE, stoppedEarly, results };
  writeFileSync(join(OUT, "results.json"), JSON.stringify(run, null, 2));
  console.log("");
  for (const line of summarize(run)) console.log(line);
  console.log(`[agent-tone] out: ${OUT}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
