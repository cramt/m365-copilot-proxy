// Sweep every mapped tone plus guessed names for models the web picker shows
// but the proxy doesn't map (e.g. "GPT 5.6 Sol", Quick + Think deeper).
// One fresh thread per cell, strictly sequential, with a gap between cells
// (thread-rate throttle, F13). Classifies each cell three-state (§12.15):
//   LIVE (DeepLeo) / REJECTED (validator error) / DEAD (BotConnection apology).
//
// Usage (repo root): node scripts/model-sweep-probe.mjs [--gap=8000] [--only=Gpt_56_Sol_Chat,...]

import { getToken, decodeJwt } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";
import { pathToFileURL } from "node:url";

const INCLUDED = { scenario: "OfficeWebIncludedCopilot", licenseType: "Starter" };
const PAID = { scenario: "OfficeWebPaidCopilot", licenseType: "Premium" };

const CELLS = [
  // mapped tones
  ["magic", INCLUDED],
  ["Gpt_5_5_Chat", INCLUDED],
  ["Gpt_5_5_Reasoning", INCLUDED],
  ["Gpt_5_6_Chat", INCLUDED],
  ["Gpt_5_6_Reasoning", INCLUDED],
  ["Gpt_6_Reasoning", PAID],
  ["Gpt_6_Sol_Reasoning", INCLUDED],
  ["Gpt_61_Sol_Reasoning", INCLUDED],
  ["Gpt_5_4_Chat", INCLUDED],
  ["Gpt_5_4_Reasoning", INCLUDED],
  ["Gpt_5_3_Chat", INCLUDED],
  ["Gpt_5_3_Reasoning", INCLUDED],
  ["Gpt_5_2_Chat", INCLUDED],
  ["Gpt_5_2_Reasoning", INCLUDED],
  ["Claude_Sonnet", INCLUDED],
  ["Claude_Sonnet_Reasoning", INCLUDED],
  // Found in the web client bundle's tone enum / picker menu (2026-11-03), unmapped
  ["Gpt_6_Astra", INCLUDED],
  ["Grok_Auto", INCLUDED],
  ["Grok_Reasoning", INCLUDED],
  ["Muse_Spark", INCLUDED],
  ["Chat", INCLUDED],
  ["Reasoning", INCLUDED],
  ["Gpt_5_2_Auto", INCLUDED],
  // Rejected guesses for "GPT 5.6 Sol". The picker's "GPT-5.6 Sol" items are
  // Gpt_5_6_Chat / Gpt_5_6_Reasoning (menu JSON in Edge's HTTP cache).
  ["Gpt_56_Sol_Chat", INCLUDED],
  ["Gpt_56_Sol_Reasoning", INCLUDED],
  ["Gpt_5_6_Sol_Chat", INCLUDED],
  ["Gpt_5_6_Sol_Reasoning", INCLUDED],
  ["Gpt_56_Sol", INCLUDED],
  ["Gpt_5_6_Sol", INCLUDED],
  ["Gpt_56_Sol_Quick", INCLUDED],
  ["Gpt_6_Sol_Chat", INCLUDED],
];

const PROMPT =
  "In one short line: which model are you exactly (name and version), and are you a chat or a reasoning model? No other text.";

export function classify(r) {
  if (r.error && /Failed to invoke|type:3|rejected/i.test(String(r.error))) return "REJECTED";
  if (r.error) return "ERROR";
  if (r.disengaged) return "DISENGAGED";
  if (r.contentOrigin === "DeepLeo") return "LIVE";
  if (r.contentOrigin === "BotConnection") return "DEAD";
  return `?(${r.contentOrigin ?? "none"})`;
}

export async function runSweep(args = process.argv.slice(2), log = console.log) {
  if (args.some((a) => !/^--(?:only|gap)=\S+$/.test(a))) {
    throw new Error("Expected only --only=Tone,... and --gap=milliseconds arguments");
  }
  const arg = (key, fallback) => args.find((a) => a.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback;
  const gap = Number(arg("gap", "8000"));
  if (!Number.isFinite(gap) || gap < 0 || gap > 2_147_483_647) {
    throw new Error("--gap must be a finite delay between 0 and 2147483647 ms");
  }
  const only = arg("only", undefined)?.split(",");
  if (only?.some((tone) => !CELLS.some(([known]) => tone === known))) {
    throw new Error("--only must contain known probe tones (comma-separated, case-sensitive)");
  }
  const cells = only ? CELLS.filter(([tone]) => only.includes(tone)) : CELLS;
  // Validate before auth: a misspelled selection must not open a browser or use quota.
  const token = await getToken();
  const claims = decodeJwt(token);

  for (let i = 0; i < cells.length; i++) {
    const [tone, ent] = cells[i];
    let r;
    let finalResult;
    try {
      r = await oneTurn({
        token, claims, text: PROMPT, tone, ...ent, timeoutMs: 90000,
        onFrame(frame) {
          if (frame.type !== 2) return;
          // Match _probe-chat's canonical final-item shapes; its summary drops result.
          const item = Array.isArray(frame.item) ? frame.item[0] : frame.item;
          const it = item ?? (Array.isArray(frame.arguments) ? frame.arguments[0]?.item : null);
          finalResult = it?.result;
        },
      });
    } catch (e) {
      r = { error: e?.message ?? String(e) };
    }
    const state = classify(r);
    const text = (r.fullText ?? "").replace(/\s+/g, " ").slice(0, 140);
    const err = r.error ? ` err=${String(r.error).slice(0, 100)}` : "";
    log(`${state.padEnd(10)} ${tone.padEnd(24)} ${ent.scenario.replace("OfficeWeb", "").padEnd(16)} ${String(r.elapsedMs ?? "").padStart(6)}ms  ${text}${err}`);
    // The ordinary `throttle` usage object isn't itself a refusal.
    if (finalResult?.value === "Throttled" || finalResult?.errorCode === "PerUserThrottled" ||
        /PerUserThrottled|"value":"Throttled"/.test(JSON.stringify({ e: r.error, t: r.fullText }))) {
      log("THROTTLED — stopping sweep");
      break;
    }
    if (i < cells.length - 1) await new Promise((res) => setTimeout(res, gap));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runSweep();
}
