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
// being misfiled as a dead tone (which is what the old F23 "Opus 0/3" was).
//
// Usage: M365_NO_INTERACTIVE=1 CHROMIUM_PATH=$(which chromium) node scripts/tone-probe.mjs
// Cost: 1 message per cell. Opus cells spend the scarce priority-access budget
// (see docs §15) — drop them from the list when sweeping something else.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getToken, decodeJwt, parsePriorityAccessExhaustion } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

const INCLUDED = { scenario: "OfficeWebIncludedCopilot", licenseType: "Starter" };
const PAID = { scenario: "OfficeWebPaidCopilot", licenseType: "Premium" };

/** @type {{tone: string, note: string, scenario?: string, licenseType?: string}[]} */
const TONES = [
  { tone: "magic", note: "known good (baseline)" },
  { tone: "Gpt_5_5_Chat", note: "g365 current" },
  { tone: "Gpt_5_5_Reasoning", note: "g365 current" },
  { tone: "Gpt_5_6_Reasoning", note: "confirmed live 2026-08-06" },
  { tone: "Gpt_5_6_Chat", note: "registered but dead — BotConnection deflection, not DeepLeo (§12.15)" },
  { tone: "Gpt_6_Chat", note: "REJECTED outright — validator error, not the 5.6 deflection" },
  { tone: "Claude_Sonnet", note: "real Claude Sonnet 4.5" },
  { tone: "Anthropic_Claude", note: "speculative Claude" },
  { tone: "Claude_Reasoning", note: "accepted but actually GPT-5 — don't use" },

  // Opus, both entitlements, so the scenario effect is measured not assumed.
  { tone: "Claude_Opus", note: "included scenario: expect the BotConnection apology", ...INCLUDED },
  { tone: "Claude_Opus", note: "PAID scenario: expect DeepLeo + a real answer", ...PAID },

  // GPT-6, likewise paired. Entitlement-gated exactly like Opus but NOT
  // separately metered, so these two cells are cheap — they spend one ordinary
  // message each and can stay in a sweep that drops the Opus cells.
  { tone: "Gpt_6_Reasoning", note: "included scenario: expect the BotConnection apology", ...INCLUDED },
  { tone: "Gpt_6_Reasoning", note: "PAID scenario: expect DeepLeo + a real answer", ...PAID },

  // Claude_Fable: present in the real web client's tone list (§12.6 decompile)
  // alongside Claude_Sonnet, so it is a registered route rather than a guess.
  // It is accepted here and answers — but it self-identifies as GPT-5, not as
  // Fable, which is the same "answers, therefore it works" trap §12.15 warns
  // about one level up: the tone resolves to *a* model, just not the named one.
  // Best current reading is that the real Fable route is gated on the Frontier
  // program and an unentitled account is quietly served the house model. That
  // is why Fable is deliberately NOT in MODEL_TONES — advertising it would ship
  // a model ID that lies about what answers. Probed on both entitlements to see
  // whether the paid scenario is the gate (as it is for Opus) or whether the
  // gate is program membership, which no scenario string can fake.
  { tone: "Claude_Fable", note: "self-IDs as GPT-5, not Fable — likely Frontier-gated", ...INCLUDED },
  { tone: "Claude_Fable", note: "PAID scenario: does the entitlement move it?", ...PAID },

  { tone: "Definitely_Not_A_Real_Tone_XYZ", note: "CONTROL: invalid" },
];

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "tone-out", TS);
mkdirSync(OUT, { recursive: true });

const token = await getToken();
const claims = decodeJwt(token);

/** Live / rejected / registered-but-dead — never infer from "no error" alone. */
function verdict(r) {
  if (r.error) return "REJECTED";
  const text = (r.fullText || "").trim();
  if (!text) return "EMPTY";
  if (parsePriorityAccessExhaustion(text)) return "QUOTA_EXHAUSTED";
  if (r.contentOrigin === "BotConnection") return "REGISTERED_BUT_DEAD";
  if (r.contentOrigin === "DeepLeo") return "LIVE";
  return `UNKNOWN(origin=${r.contentOrigin})`;
}

const results = [];
for (const cell of TONES) {
  const scenario = cell.scenario ?? INCLUDED.scenario;
  const licenseType = cell.licenseType ?? INCLUDED.licenseType;
  const r = await oneTurn({
    token, claims, agentId: null, tone: cell.tone, scenario, licenseType, timeoutMs: 60000,
    text: `Reply with exactly the single word: pong`,
  });
  const row = {
    tone: cell.tone,
    scenario,
    licenseType,
    note: cell.note,
    verdict: verdict(r),
    gotContent: (r.fullText || "").trim().length > 0,
    reply: (r.fullText || "").slice(0, 80),
    contentOrigin: r.contentOrigin,
    disengaged: r.disengaged,
    error: r.error,
    elapsedMs: r.elapsedMs,
  };
  results.push(row);
  console.log(`[tone] ${cell.tone.padEnd(32)} ${scenario.padEnd(25)} ${row.verdict.padEnd(20)} origin=${String(r.contentOrigin)} ${r.elapsedMs}ms ${r.error ? "ERR=" + r.error : ""} reply=${JSON.stringify(row.reply)}`);
  await new Promise((res) => setTimeout(res, 1500)); // gentle spacing
}

writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\n[tone] === VERDICT ===`);
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
console.log(`[tone] NOTE: a non-empty reply is not proof — only contentOrigin "DeepLeo" is (§12.15).`);
console.log(`[tone] out: ${OUT}`);
