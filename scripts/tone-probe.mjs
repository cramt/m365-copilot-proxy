// RE probe (H8.6): which `tone` strings are real models vs silent fallback?
// g365 uses Gpt_5_5_Chat/Gpt_5_5_Reasoning; MS shipped Claude in Copilot.
// A bogus control tone reveals how the server treats an unknown tone
// (error => it validates tones; content => it silently falls back).
//
// Usage: M365_NO_INTERACTIVE=1 CHROMIUM_PATH=$(which chromium) node scripts/tone-probe.mjs
// Cost: 1 message per tone.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getToken, decodeJwt } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

const TONES = [
  "magic",                 // known good (baseline)
  "Gpt_5_5_Chat",          // g365 current
  "Gpt_5_5_Reasoning",     // g365 current
  "Gpt_5_6_Reasoning",     // confirmed live 2026-08-06
  "Gpt_5_6_Chat",          // rejected in June 2026
  "Claude_Sonnet",         // speculative Claude
  "Anthropic_Claude",      // speculative Claude
  "Claude_Reasoning",      // speculative Claude
  "Definitely_Not_A_Real_Tone_XYZ",  // CONTROL: invalid
];

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "tone-out", TS);
mkdirSync(OUT, { recursive: true });

const token = await getToken();
const claims = decodeJwt(token);

const results = [];
for (const tone of TONES) {
  // Unique nonce so each is a fresh conversation; ask for a model self-id hint too.
  const r = await oneTurn({
    token, claims, agentId: null, tone, timeoutMs: 60000,
    text: `Reply with exactly the single word: pong`,
  });
  const row = {
    tone,
    gotContent: (r.fullText || "").trim().length > 0,
    reply: (r.fullText || "").slice(0, 80),
    contentOrigin: r.contentOrigin,
    disengaged: r.disengaged,
    error: r.error,
    elapsedMs: r.elapsedMs,
  };
  results.push(row);
  console.log(`[tone] ${tone.padEnd(34)} content=${row.gotContent} origin=${String(r.contentOrigin)} ${r.elapsedMs}ms ${r.error ? "ERR=" + r.error : ""} reply=${JSON.stringify(row.reply)}`);
  await new Promise((res) => setTimeout(res, 1500)); // gentle spacing
}

writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\n[tone] === VERDICT ===`);
const control = results.find((r) => r.tone.includes("Definitely_Not"));
console.log(`[tone] control (invalid tone): content=${control?.gotContent} error=${control?.error} → ${control?.gotContent ? "server SILENTLY FALLS BACK (can't distinguish fallback from real)" : "server REJECTS unknown tones (so content = a real tone)"}`);
for (const r of results) if (r.gotContent && !r.tone.includes("Definitely_Not")) console.log(`  ${r.tone}: content ✓ origin=${r.contentOrigin}`);
console.log(`[tone] out: ${OUT}`);
