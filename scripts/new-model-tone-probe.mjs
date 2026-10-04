// Targeted, agent-less model discovery. No requests are made when imported.
// Usage: node scripts/new-model-tone-probe.mjs --tones=Gpt_6_Luna_Chat,Claude_Sonnet --phase=live
//        node scripts/new-model-tone-probe.mjs --tones=Gpt_6_Luna_Chat --phase=self-id
// Each tone is tried under both scenarios unless --scenario=included|paid is set.
// One fresh thread per cell; requests are sequential and stop on PerUserThrottled.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getToken, decodeJwt, parsePriorityAccessExhaustion } from "../packages/core/dist/index.mjs";

const SCENARIOS = {
  included: { scenario: "OfficeWebIncludedCopilot", licenseType: "Starter" },
  paid: { scenario: "OfficeWebPaidCopilot", licenseType: "Premium" },
};

export const CANDIDATES = [
  "Gpt_6_Luna", "Gpt_6_Luna_Chat", "Gpt_6_Luna_Reasoning",
  "Gpt_6_Astra", "Gpt_6_Astra_Chat", "Gpt_6_Astra_Reasoning",
  "Gpt_6_1_Sol", "Gpt_6_1_Sol_Chat", "Gpt_6_1_Sol_Reasoning",
  "Claude_Sonnet",
];

export function classify({ error, result, contentOrigin, fullText, disengaged }) {
  if (result?.value === "Throttled" || result?.errorCode === "PerUserThrottled") return "THROTTLED";
  if (result?.errorCode === "InvalidCopilotLicense") return "UNLICENSED";
  if (error === "timeout") return "UNKNOWN";
  if (error) return "REJECTED";
  if (parsePriorityAccessExhaustion(fullText ?? "")) return "UNKNOWN";
  if (contentOrigin === "BotConnection") return "REGISTERED_BUT_DEAD";
  if (disengaged || !fullText?.trim()) return "UNKNOWN";
  if (contentOrigin === "DeepLeo" && result?.value === "Success") return "LIVE";
  return "UNKNOWN";
}

function finalResult(frame) {
  if (frame.type !== 2) return null;
  const item = Array.isArray(frame.item) ? frame.item[0] : frame.item;
  return item?.result ?? frame.arguments?.[0]?.item?.result ?? null;
}

async function main(args) {
  const option = (name, fallback) =>
    args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
  const tones = option("tones", CANDIDATES.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const scenarioOption = option("scenario", "both");
  const scenarios = scenarioOption === "both" ? Object.keys(SCENARIOS) : [scenarioOption];
  const phase = option("phase", "live");
  const cooldownMs = Number(option("cooldown-ms", "300000"));
  if (!tones.length || scenarios.some((s) => !SCENARIOS[s]) ||
      !["live", "self-id"].includes(phase) || !Number.isFinite(cooldownMs) || cooldownMs < 0) {
    throw new Error("Use --tones=a,b --scenario=included|paid|both --phase=live|self-id --cooldown-ms=300000");
  }
  const { oneTurn } = await import("./_probe-chat.mjs");
  const out = join(process.cwd(), "scripts", "new-model-tone-out",
    new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(out, { recursive: true });
  const token = await getToken();
  const claims = decodeJwt(token);
  const rows = [];
  let stoppedEarly = false;
  const prompt = phase === "live"
    ? "Reply with exactly the single word: pong"
    : "Which AI model are you exactly? State your underlying model name and version and the company that made you, in one short sentence. Do not add anything else.";
  for (const tone of tones) {
    for (const scenarioName of scenarios) {
      if (rows.length) await new Promise((done) => setTimeout(done, cooldownMs));
      const frames = [];
      let result = null;
      const r = await oneTurn({
        token, claims, agentId: null, tone, ...SCENARIOS[scenarioName],
        timeoutMs: 90000, text: prompt,
        onFrame(frame) {
          frames.push(frame);
          result = finalResult(frame) ?? result;
        },
      });
      const row = {
        tone, scenario: scenarioName, licenseType: SCENARIOS[scenarioName].licenseType,
        phase, verdict: classify({ ...r, result }), result: result && {
          value: result.value, errorCode: result.errorCode ?? null,
        },
        contentOrigin: r.contentOrigin, elapsedMs: r.elapsedMs, error: r.error,
        disengaged: r.disengaged, reply: r.fullText,
        frameFile: `${String(rows.length).padStart(2, "0")}-${tone}-${scenarioName}.jsonl`,
      };
      writeFileSync(join(out, row.frameFile), frames.map((f) => JSON.stringify(f)).join("\n") + "\n");
      rows.push(row);
      writeFileSync(join(out, "results.json"), JSON.stringify({
        phase, prompt, account: claims.upn ?? claims.oid, stoppedEarly, rows,
      }, null, 2));
      console.log(`[new-model] ${tone} @ ${scenarioName}: ${row.verdict} ` +
        `origin=${row.contentOrigin} result=${row.result?.value ?? "-"} ` +
        `errorCode=${row.result?.errorCode ?? "-"} ${row.elapsedMs}ms ` +
        `reply=${JSON.stringify(row.reply?.slice(0, 140))}`);
      if (row.verdict === "THROTTLED") {
        stoppedEarly = true;
        break;
      }
    }
    if (stoppedEarly) break;
  }
  writeFileSync(join(out, "results.json"), JSON.stringify({
    phase, prompt, account: claims.upn ?? claims.oid, stoppedEarly, rows,
  }, null, 2));
  console.log(`[new-model] ${stoppedEarly ? "STOPPED: PerUserThrottled" : "complete"}; out: ${out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}