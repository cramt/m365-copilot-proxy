// E-T1: characterise account-level throttling / degradation (api doc §7, H8.20).
// Fires N trivial "pong" turns at a fixed requests-per-minute rate (each a fresh
// conversation, no agent) and records where Disengaged/empty onset begins, then
// optionally measures the recovery window.
//
// Output: a picture of "how fast can we go before it degrades, and how long until
// it recovers" → a safe client-side pacing config.
//
// Usage:
//   M365_NO_INTERACTIVE=1 CHROMIUM_PATH=$(which chromium) \
//     node scripts/throttle-probe.mjs --rpm 30 --max 25 [--recover] [--agent]
//   Sweep --rpm 10 / 30 / 60 / 120 (separate runs, on a RESTED account).
//
// ⚠ Bursty by design: spends up to --max messages. Start small.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getToken, decodeJwt, getOrCreateAgent } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const RPM = Number(opt("--rpm", "30"));
const MAX = Math.min(Number(opt("--max", "25")), 60);
const RECOVER = args.includes("--recover");
const USE_AGENT = args.includes("--agent");
const INTERVAL = 60000 / RPM;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "throttle-out", TS);
mkdirSync(OUT, { recursive: true });

const token = await getToken();
const claims = decodeJwt(token);
const agentId = USE_AGENT ? await getOrCreateAgent() : null;

console.log(
  `[throttle] rpm=${RPM} max=${MAX} interval=${Math.round(INTERVAL)}ms agent=${USE_AGENT} recover=${RECOVER}`,
);

function classify(r) {
  if (r.error) return "error";
  if (r.disengaged) return "disengaged";
  return (r.fullText || "").trim().length ? "ok" : "empty";
}

const t0 = Date.now();
// Fire all requests on a fixed schedule (concurrently) so we actually hit the RPM.
const jobs = [];
for (let i = 0; i < MAX; i++) {
  jobs.push(
    (async () => {
      await sleep(Math.round(i * INTERVAL));
      const s = Date.now();
      const r = await oneTurn({
        token,
        claims,
        agentId,
        text: "Reply with exactly the single word: pong",
        timeoutMs: 60000,
      });
      const cls = classify(r);
      const row = { i, startMs: s - t0, cls, latencyMs: Date.now() - s, throttle: r.throttle };
      console.log(
        `  #${String(i).padStart(2)} @${String(Math.round(row.startMs / 1000)).padStart(3)}s  ${cls.padEnd(11)} ${row.latencyMs}ms throttle=${JSON.stringify(r.throttle)}`,
      );
      return row;
    })(),
  );
}
const results = (await Promise.all(jobs)).sort((a, b) => a.i - b.i);

const counts = results.reduce((m, r) => ((m[r.cls] = (m[r.cls] || 0) + 1), m), {});
const onset = results.find((r) => r.cls !== "ok");
const okRate = Math.round(((counts.ok || 0) / results.length) * 100);

// Recovery: if it degraded, poll a single request every 30s until it recovers.
let recoveryMin = null;
if (RECOVER && onset) {
  console.log(`[throttle] degraded — polling recovery every 30s (max 10 min)...`);
  for (let k = 1; k <= 20; k++) {
    await sleep(30000);
    const r = await oneTurn({
      token,
      claims,
      agentId,
      text: "Reply with exactly: pong",
      timeoutMs: 60000,
    });
    const cls = classify(r);
    console.log(`  recovery probe @${k * 30}s: ${cls}`);
    if (cls === "ok") {
      recoveryMin = (k * 30) / 60;
      break;
    }
  }
}

writeFileSync(
  join(OUT, "results.json"),
  JSON.stringify(
    {
      rpm: RPM,
      max: MAX,
      useAgent: USE_AGENT,
      counts,
      okRate,
      onsetIndex: onset?.i ?? null,
      onsetAtSec: onset ? Math.round(onset.startMs / 1000) : null,
      recoveryMin,
      results,
    },
    null,
    2,
  ),
);

console.log(`\n[throttle] === RESULT (rpm=${RPM}) ===`);
console.log(
  `[throttle] ok ${counts.ok || 0}/${results.length} (${okRate}%)  | ${Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ")}`,
);
console.log(
  `[throttle] degradation onset: ${onset ? `request #${onset.i} at ~${Math.round(onset.startMs / 1000)}s (${onset.cls})` : "NONE — sustained this RPM cleanly"}`,
);
if (RECOVER && onset)
  console.log(
    `[throttle] recovery: ${recoveryMin != null ? `~${recoveryMin} min` : ">10 min (not recovered in window)"}`,
  );
console.log(`[throttle] → ${join(OUT, "results.json")}`);
