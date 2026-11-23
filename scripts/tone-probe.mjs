// RE probe (H8.6): which `tone` strings are real models vs silent fallback?
// g365 uses Gpt_5_5_Chat/Gpt_5_5_Reasoning; MS shipped Claude in Copilot.
// A bogus control tone reveals how the server treats an unknown tone
// (error => it validates tones; content => it silently falls back).
//
// Tone validation is THREE-state (§12.15), and the third state is the trap:
//   live             → content + contentOrigin "DeepLeo"
//   rejected         → type:3 error "Failed to invoke 'Chat'", ~250ms
//   registered-dead  → canned apology + contentOrigin "BotConnection", ~1.6s
// So "it didn't error" is NOT evidence a tone works — require DeepLeo.
//
// A tone can also be dead on ONE entitlement and live on another: Claude_Opus
// deflects with the BotConnection apology under the default included scenario
// and serves normally under `scenario=OfficeWebPaidCopilot`. Cells below carry
// their own scenario so that difference is visible in one sweep rather than
// being misfiled as a dead tone (which is what the old F23 "Opus 0/3" was, and
// then again what §12.15's "Gpt_5_6_Chat is dead" was — that one was gated too,
// and has since been ungated entirely, so a "dead" cell is worth re-probing).
//
// So: never conclude "dead" from a single scenario, and treat the third state
// as a property of the CONNECTION, not of the tone.
//
// Over StreamHub (M365_TRANSPORT=streamhub) the proxy sends every model under
// one scenario pair, so there each tone is probed once, under that pair.
//
// Usage: M365_NO_INTERACTIVE=1 CHROMIUM_PATH=$(which chromium) node scripts/tone-probe.mjs
// Cost: 1 message per cell. A full sweep includes priority-metered Opus and
// Sonnet and credit-billed Astra and Fable; other/unknown tones may also cost.
// Obtain spending approval and check current pricing before any live probe.
// Use --only=TONE --included --dry-run to inspect one selection offline.
// The full sweep has no throttle-stop; 1.5s spacing is not a safe cadence.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getToken, decodeJwt, getStreamHubScenario, getTransport, parsePriorityAccessExhaustion } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";
import { isLicenceRefusal } from "./agent-tone-probe.mjs";

const INCLUDED = { scenario: "OfficeWebIncludedCopilot", licenseType: "Starter" };
const PAID = { scenario: "OfficeWebPaidCopilot", licenseType: "Premium" };

/** @type {{tone: string, note: string, scenario?: string, licenseType?: string}[]} */
const TONES = [
  { tone: "magic", note: "known good (baseline)" },
  { tone: "Gpt_5_5_Chat", note: "g365 current" },
  { tone: "Gpt_5_5_Reasoning", note: "g365 current" },
  { tone: "Gpt_5_6_Reasoning", note: "confirmed live 2026-08-06" },
  // Gpt_5_6_Chat: paired, because this is the tone §12.15 recorded as "dead"
  // on the strength of included-scenario probes alone while it was serving
  // fine on the paid one (§18 F33). Both cells should now be DeepLeo — the
  // included one is the regression detector if Microsoft re-gates it.
  { tone: "Gpt_5_6_Chat", note: "included scenario: expect DeepLeo — BotConnection here means re-gated", ...INCLUDED },
  { tone: "Gpt_5_6_Chat", note: "PAID scenario: expect DeepLeo (it served here even while gated)", ...PAID },
  { tone: "Gpt_6_Chat", note: "REJECTED outright — validator error, not the 5.6 deflection" },
  // One tone, TWO models: Sonnet 4.6 on included, Sonnet 5.5 on paid (it was
  // Sonnet 5 until 2026-10-06, docs §26). Sonnet 5 moved to `Claude_Sonnet_5`,
  // which is Sonnet 4.6 on included. All cells read LIVE with this `pong`
  // prompt — LIVE says a model answered, not which one; a self-ID prompt is
  // what tells them apart.
  { tone: "Claude_Sonnet", note: "included scenario: Claude Sonnet 4.6", ...INCLUDED },
  { tone: "Claude_Sonnet", note: "PAID scenario: Claude Sonnet 5.5 (model ID claude-sonnet-5.5) — spends its priority access", ...PAID },
  { tone: "Claude_Sonnet_5", note: "PAID scenario: Claude Sonnet 5 (model ID claude-sonnet-5)", ...PAID },
  { tone: "Anthropic_Claude", note: "speculative Claude" },
  { tone: "Claude_Reasoning", note: "accepted but actually GPT-5 — don't use" },

  // Opus, both entitlements, so the scenario effect is measured not assumed.
  // The included cell is Opus 4.8 (`claude-opus-4.8`), on a premium account
  // only, agent-less as well as with the agent (agent-tone-probe.mjs); a
  // non-premium account gets the BotConnection apology. It was Opus 4.5 until
  // October 2026, which was dead here agent-less on every account (§24, §36).
  { tone: "Claude_Opus", note: "included scenario: expect DeepLeo + Opus 4.8 on a premium account, the BotConnection apology on a non-premium one", ...INCLUDED },
  { tone: "Claude_Opus", note: "PAID scenario: expect DeepLeo + Opus 5.5 (spends priority access)", ...PAID },

  // Claude_Auto (`claude-auto`, §62), paired too: on the paid scenario it
  // self-IDs as Opus 5.5, on the included one as a GPT model. Its paid turns
  // spend Opus's priority-access budget over Chathub, as Claude_Opus's do, and
  // none over StreamHub, which is why the proxy always sends `claude-auto` over
  // StreamHub. A non-premium account gets ClaudeUnavailableForLicense.
  { tone: "Claude_Auto", note: "included scenario: expect DeepLeo + a GPT model by self-ID", ...INCLUDED },
  { tone: "Claude_Auto", note: "claude-auto — PAID scenario: expect DeepLeo + Opus 5.5 by self-ID (over Chathub spends priority access; over StreamHub doesn't)", ...PAID },

  // GPT-6, likewise paired. Entitlement-gated exactly like Opus but NOT
  // separately metered, so these two cells are cheap — they spend one ordinary
  // message each and can stay in a sweep that drops the Opus cells.
  { tone: "Gpt_6_Reasoning", note: "included scenario: expect the BotConnection apology", ...INCLUDED },
  { tone: "Gpt_6_Reasoning", note: "PAID scenario: expect DeepLeo + a real answer", ...PAID },

  // GPT-6 Sol ("GPT 6.0 Sol" in the web client, #23). NOT gated: LIVE on the
  // included scenario on premium and non-premium accounts alike — the
  // included cell is the regression detector if Microsoft gates it. The chat
  // sibling is accepted too and unmapped: here it self-IDs as the GPT-5 chat
  // model, while on the paid scenario and over StreamHub's `officeweb` it
  // self-IDs as GPT-6 reasoning, and the web client's "GPT-6" item sends it
  // (§63 F179, F180, H63a). Keep it here to notice if that changes.
  { tone: "Gpt_6_Sol_Reasoning", note: "gpt-6-sol — included scenario: expect DeepLeo on every account", ...INCLUDED },
  { tone: "Gpt_6_Sol_Chat", note: "unmapped: self-IDs as the GPT-5 chat model here, as GPT-6 reasoning on the paid scenario", ...INCLUDED },

  // GPT-6.1 Sol ("GPT-6.1 Sol" in the web client, §27). Same shape as GPT-6
  // Sol: LIVE on the included scenario on every account. The paid scenario
  // serves it on a premium account too but spends the GPT61Sol priority-access
  // budget (40/day, 75/week), so there's no paid cell here.
  { tone: "Gpt_61_Sol_Reasoning", note: "gpt-6.1-sol — included scenario: expect DeepLeo on every account", ...INCLUDED },

  // GPT-6.2 Sol and GPT-6.2 Astra (web client, 2026-11-17, §45): LIVE on the
  // included scenario, where they're routed; the paid scenario carries their
  // GPT62SolQuery / GPT62AstraQuery budgets, so no paid cell. GPT-6 Astra is
  // gated like GPT-6: the BotConnection apology on included, served on paid.
  // GPT-6.2 Astra and Fable turns report a charge to the user's Copilot credits
  // over StreamHub; GPT-6 Astra is a credits model too (MC1519122).
  { tone: "Gpt_62_Sol_Reasoning", note: "gpt-6.2-sol — included scenario: expect DeepLeo", ...INCLUDED },
  { tone: "Gpt_62_Astra_Reasoning", note: "gpt-6.2-astra — included scenario: expect DeepLeo (uses credits)", ...INCLUDED },
  { tone: "Gpt_6_Astra_Reasoning", note: "included scenario: expect the BotConnection apology", ...INCLUDED },
  { tone: "Gpt_6_Astra_Reasoning", note: "gpt-6-astra — PAID scenario: expect DeepLeo (uses credits)", ...PAID },

  // Claude_Fable: present in the real web client's tone list (§12.6 decompile)
  // alongside Claude_Sonnet. It self-identified as GPT-5 for months (§10), so it
  // stayed out of MODEL_TONES; it serves Fable 5.1 now and is mapped as
  // claude-fable (§45 F122). Self-ID no longer names the model on any route, so
  // check the family by training cutoff instead: Fable says June 2026, GPT-5.5
  // June 2024. Both scenarios serve it.
  { tone: "Claude_Fable", note: "claude-fable — included scenario: expect DeepLeo (uses credits)", ...INCLUDED },
  { tone: "Claude_Fable", note: "PAID scenario: serves too", ...PAID },

  // Tones the web picker's JSON or the web client's tone enum name, or that the
  // picker's "GPT-5.6 Sol" labels suggest (H-SOL56), and that the proxy doesn't
  // map. A `pong` reply doesn't say which model answered, so a LIVE cell here is
  // a lead, not a model; check the first-party picker data too (§27 H27a).
  { tone: "Gpt_6_Astra", note: "unmapped: the bare name; gpt-6-astra is `Gpt_6_Astra_Reasoning`", ...INCLUDED },
  { tone: "Grok_Auto", note: "unmapped: in the web client's tone enum", ...INCLUDED },
  { tone: "Grok_Reasoning", note: "unmapped: in the web client's tone enum", ...INCLUDED },
  { tone: "Muse_Spark", note: "unmapped: in the web client's tone enum", ...INCLUDED },
  { tone: "Gpt_5_2_Auto", note: "unmapped: in the web client's tone enum", ...INCLUDED },
  { tone: "Chat", note: "the web client's \"Quick response\" item (§63 F179); `Gpt_Chat` is REJECTED (§19 F34)", ...INCLUDED },
  { tone: "Reasoning", note: "the web client's \"Think deeper\" item (§63 F179); `Gpt_Reasoning` is REJECTED (§19 F34)", ...INCLUDED },
  // Guessed names for the picker's "GPT-5.6 Sol" items, which the web client's
  // selector data maps to Gpt_5_6_Chat / Gpt_5_6_Reasoning (H-SOL56, confirmed
  // 2026-11-23, §63 F179). A guess that comes back LIVE would be news.
  { tone: "Gpt_56_Sol_Chat", note: "guess for GPT-5.6 Sol Quick response: expect REJECTED", ...INCLUDED },
  { tone: "Gpt_56_Sol_Reasoning", note: "guess for GPT-5.6 Sol Think deeper: expect REJECTED", ...INCLUDED },
  { tone: "Gpt_5_6_Sol_Chat", note: "guess for GPT-5.6 Sol Quick response: expect REJECTED", ...INCLUDED },
  { tone: "Gpt_5_6_Sol_Reasoning", note: "guess for GPT-5.6 Sol Think deeper: expect REJECTED", ...INCLUDED },
  { tone: "Gpt_56_Sol", note: "guess: expect REJECTED", ...INCLUDED },
  { tone: "Gpt_5_6_Sol", note: "guess: expect REJECTED", ...INCLUDED },
  { tone: "Gpt_56_Sol_Quick", note: "guess: expect REJECTED", ...INCLUDED },

  { tone: "Definitely_Not_A_Real_Tone_XYZ", note: "CONTROL: invalid" },
];

// The cells above pin Chathub's scenarios, under which one tone reaches
// different models, or none. Over StreamHub the proxy sends every model under
// one pair (getStreamHubScenario: `officeweb` + `Premium`, hypotheses §40 F108;
// M365_SCENARIO / M365_LICENSE_TYPE change it, as for the proxy), so there each
// tone is one cell, under that pair, with the notes of its cells.
const args = process.argv.slice(2);
const only = args.find((arg) => arg.startsWith("--only="))?.slice(7);
if (args.length && (!only || !args.includes("--included") || args.some((arg) => !arg.startsWith("--only=") && arg !== "--included" && arg !== "--dry-run") || args.filter((arg) => arg.startsWith("--only=")).length !== 1)) {
  throw new Error("Use --only=TONE --included [--dry-run]");
}
const TRANSPORT = getTransport();
if (only && TRANSPORT === "streamhub") throw new Error("Selected included cell requires Chathub; unset M365_TRANSPORT");
let CELLS = TRANSPORT === "streamhub" ? oneCellPerTone(TONES, getStreamHubScenario()) : TONES;
if (only) {
  CELLS = CELLS.filter((cell) => cell.tone === only && (cell.scenario ?? INCLUDED.scenario) === INCLUDED.scenario)
    .map((cell) => ({ ...cell, ...INCLUDED }));
  if (CELLS.length !== 1) throw new Error("Expected exactly one included cell");
}
if (args.includes("--dry-run")) {
  console.log(JSON.stringify(CELLS, null, 2));
  process.exit(0);
}

function oneCellPerTone(cells, route) {
  const byTone = new Map();
  for (const { tone, note } of cells) {
    const prev = byTone.get(tone);
    byTone.set(tone, { tone, note: prev ? `${prev.note} / ${note}` : note, ...route });
  }
  return [...byTone.values()];
}

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "tone-out", TS);
mkdirSync(OUT, { recursive: true });

const token = await getToken();
const claims = decodeJwt(token);

/** Live / rejected / registered-but-dead — never infer from "no error" alone. */
function verdict(r) {
  if (r.error) return "REJECTED";
  // The account isn't licensed for the cell's scenario (`InvalidCopilotLicense`:
  // a paid or `officeweb` cell on a non-premium account) or for the tone's model
  // (`ClaudeUnavailableForLicense`, `PremiumModelUnavailableForLicense`, on either
  // transport): about the account, not the tone. Before the BotConnection check,
  // which Chathub's scenario refusal would match (hypotheses §49 F145, F146).
  // agent-tone-probe's rule, tested in probe-chat.test.mjs.
  if (isLicenceRefusal(r.result)) return "UNLICENSED";
  const text = (r.fullText || "").trim();
  if (!text) return "EMPTY";
  if (parsePriorityAccessExhaustion(text)) return "QUOTA_EXHAUSTED";
  if (r.contentOrigin === "BotConnection") return "REGISTERED_BUT_DEAD";
  if (r.contentOrigin === "DeepLeo") return "LIVE";
  return `UNKNOWN(origin=${r.contentOrigin})`;
}

const results = [];
for (const cell of CELLS) {
  const scenario = cell.scenario ?? INCLUDED.scenario;
  const licenseType = cell.licenseType ?? INCLUDED.licenseType;
  const r = await oneTurn({
    token, claims, agentId: null, transport: TRANSPORT, tone: cell.tone, scenario, licenseType, timeoutMs: 60000,
    text: `Reply with exactly the single word: pong`,
  });
  const row = {
    tone: cell.tone,
    scenario,
    licenseType,
    transport: r.transport,
    note: cell.note,
    verdict: verdict(r),
    gotContent: (r.fullText || "").trim().length > 0,
    reply: (r.fullText || "").slice(0, 80),
    contentOrigin: r.contentOrigin,
    disengaged: r.disengaged,
    error: r.error,
    // The turn's outcome (Chathub's final `result`, StreamHub's `request_end`) and,
    // over StreamHub, any `billing_info` items (hypotheses §45 F122 saw them on the
    // credit-billed models, §49 F143 on none).
    result: r.result,
    billing: r.billing,
    elapsedMs: r.elapsedMs,
  };
  results.push(row);
  console.log(`[tone] ${cell.tone.padEnd(32)} ${scenario.padEnd(25)} ${row.verdict.padEnd(20)} transport=${r.transport} origin=${String(r.contentOrigin)}${r.result && r.result.value !== "Success" ? ` result=${r.result.value}${r.result.errorCode ? `/${r.result.errorCode}` : ""}` : ""}${r.billing.length ? ` billing=${r.billing.map((b) => b.status).join(",")}` : ""} ${r.elapsedMs}ms ${r.error ? "ERR=" + r.error : ""} reply=${JSON.stringify(row.reply)}`);
  await new Promise((res) => setTimeout(res, 1500)); // gentle spacing
}

writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\n[tone] === VERDICT (transport=${[...new Set(results.map((r) => r.transport))].join("+")}) ===`);
const control = results.find((r) => r.tone.includes("Definitely_Not"));
console.log(`[tone] control (invalid tone): content=${control?.gotContent} error=${control?.error} → ${control?.gotContent ? "server SILENTLY FALLS BACK (can't distinguish fallback from real)" : "server REJECTS unknown tones (so content = a real tone)"}`);
for (const r of results) {
  if (r.tone.includes("Definitely_Not")) continue;
  console.log(`  ${r.tone} @ ${r.scenario}: ${r.verdict} (origin=${r.contentOrigin})`);
}
// Scenario-sensitive tones are the interesting ones: same tone, two outcomes.
for (const tone of new Set(results.map((r) => r.tone))) {
  const cells = results.filter((r) => r.tone === tone);
  if (cells.length > 1 && new Set(cells.map((c) => c.verdict)).size > 1) {
    console.log(`[tone] SCENARIO-SENSITIVE: ${tone} → ${cells.map((c) => `${c.scenario}=${c.verdict}`).join(", ")}`);
  }
}
const unlicensed = results.filter((r) => r.verdict === "UNLICENSED");
const scenarioRefused = [...new Set(unlicensed.filter((r) => r.result?.errorCode === "InvalidCopilotLicense").map((r) => r.scenario))];
const modelRefused = unlicensed.filter((r) => r.result?.errorCode !== "InvalidCopilotLicense");
if (scenarioRefused.length) {
  console.log(`[tone] UNLICENSED: this account can't use ${scenarioRefused.join(", ")} (InvalidCopilotLicense); those cells say nothing about the tone.` +
    `${TRANSPORT === "streamhub" ? " Over StreamHub, M365_SCENARIO=OfficeWebIncludedCopilot sends the included scenario." : ""}`);
}
if (modelRefused.length) {
  console.log(`[tone] UNLICENSED: this account's licence doesn't cover ${modelRefused.map((r) => `${r.tone} (${r.result.errorCode})`).join(", ")}.`);
}
console.log(`[tone] NOTE: a non-empty reply is not proof — only contentOrigin "DeepLeo" is (§12.15).`);
console.log(`[tone] out: ${OUT}`);
