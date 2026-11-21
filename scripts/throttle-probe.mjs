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
// ⚠ Bursty by design: spends up to --max messages (and, with --recover, up to
// 20 more). The helper's run cap is set to that, and a throttle is recorded
// without stopping the run: provoking it is what this script is for.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getToken, decodeJwt, getOrCreateAgent } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

/** Recovery polls after a degraded sweep: one every RECOVERY_GAP_MS, at most this many. */
export const RECOVERY_POLLS = 20;
export const RECOVERY_GAP_MS = 30000;

export function parseArgs(args) {
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
  return {
    rpm: Number(opt("--rpm", "30")),
    max: Math.min(Number(opt("--max", "25")), 60),
    recover: args.includes("--recover"),
    useAgent: args.includes("--agent"),
  };
}

/**
 * What this script tells the helper about its own run. It provokes throttling
 * on purpose, so a throttle is data and doesn't stop the run; and the helper's
 * default cap of 20 attempts per principal is under --max's default of 25, so
 * the cap is this run's own: the sweep, plus its recovery polls.
 */
export function turnLimits({ max, recover }) {
  return { maxAttempts: max + (recover ? RECOVERY_POLLS : 0), latchThrottle: false };
}

export function classify(r) {
  if (r.error) return "error";
  if (r.disengaged) return "disengaged";
  return (r.fullText || "").trim().length ? "ok" : "empty";
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The sweep: `max` turns on a fixed schedule, then (with `recover`, after a
 * degraded sweep) recovery polls. Returns what the report is made of.
 */
export async function sweep({ oneTurn, token, claims, agentId, rpm, max, recover, sleep = defaultSleep, log = console.log }) {
  const interval = 60000 / rpm;
  const limits = turnLimits({ max, recover });
  const t0 = Date.now();
  // Fire all requests on a fixed schedule (concurrently) so we actually hit the RPM.
  const jobs = [];
  for (let i = 0; i < max; i++) {
    jobs.push((async () => {
      await sleep(Math.round(i * interval));
      const s = Date.now();
      const r = await oneTurn({ token, claims, agentId, text: "Reply with exactly the single word: pong", timeoutMs: 60000, ...limits });
      const cls = classify(r);
      const row = { i, startMs: s - t0, cls, latencyMs: Date.now() - s, transport: r.transport, throttle: r.throttle };
      log(`  #${String(i).padStart(2)} @${String(Math.round(row.startMs / 1000)).padStart(3)}s  ${cls.padEnd(11)} ${row.latencyMs}ms transport=${r.transport} throttle=${JSON.stringify(r.throttle)}`);
      return row;
    })());
  }
  const results = (await Promise.all(jobs)).sort((a, b) => a.i - b.i);

  const counts = results.reduce((m, r) => ((m[r.cls] = (m[r.cls] || 0) + 1), m), {});
  const onset = results.find((r) => r.cls !== "ok");
  const okRate = Math.round((counts.ok || 0) / results.length * 100);

  // Recovery: if it degraded, poll a single request every 30s until it recovers.
  let recoveryMin = null;
  if (recover && onset) {
    log(`[throttle] degraded — polling recovery every ${RECOVERY_GAP_MS / 1000}s (max ${RECOVERY_POLLS * RECOVERY_GAP_MS / 60000} min)...`);
    for (let k = 1; k <= RECOVERY_POLLS; k++) {
      await sleep(RECOVERY_GAP_MS);
      const r = await oneTurn({ token, claims, agentId, text: "Reply with exactly: pong", timeoutMs: 60000, ...limits });
      const cls = classify(r);
      log(`  recovery probe @${k * RECOVERY_GAP_MS / 1000}s: ${cls} transport=${r.transport}`);
      if (cls === "ok") { recoveryMin = (k * RECOVERY_GAP_MS) / 60000; break; }
    }
  }
  return { results, counts, onset, okRate, recoveryMin };
}

async function main(argv) {
  const { rpm: RPM, max: MAX, recover: RECOVER, useAgent: USE_AGENT } = parseArgs(argv);
  const INTERVAL = 60000 / RPM;

  const TS = new Date().toISOString().replace(/[:.]/g, "-");
  const OUT = join(process.cwd(), "scripts", "throttle-out", TS);
  mkdirSync(OUT, { recursive: true });

  const token = await getToken();
  const claims = decodeJwt(token);
  const agentId = USE_AGENT ? await getOrCreateAgent() : null;

  console.log(`[throttle] rpm=${RPM} max=${MAX} interval=${Math.round(INTERVAL)}ms agent=${USE_AGENT} recover=${RECOVER}`);

  const { results, counts, onset, okRate, recoveryMin } = await sweep({ oneTurn, token, claims, agentId, rpm: RPM, max: MAX, recover: RECOVER });

  writeFileSync(join(OUT, "results.json"), JSON.stringify({ rpm: RPM, max: MAX, useAgent: USE_AGENT, counts, okRate, onsetIndex: onset?.i ?? null, onsetAtSec: onset ? Math.round(onset.startMs / 1000) : null, recoveryMin, results }, null, 2));

  console.log(`\n[throttle] === RESULT (rpm=${RPM}, transport=${[...new Set(results.map((r) => r.transport))].join("+")}) ===`);
  console.log(`[throttle] ok ${counts.ok || 0}/${results.length} (${okRate}%)  | ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);
  console.log(`[throttle] degradation onset: ${onset ? `request #${onset.i} at ~${Math.round(onset.startMs / 1000)}s (${onset.cls})` : "NONE — sustained this RPM cleanly"}`);
  if (RECOVER && onset) console.log(`[throttle] recovery: ${recoveryMin != null ? `~${recoveryMin} min` : ">10 min (not recovered in window)"}`);
  console.log(`[throttle] → ${join(OUT, "results.json")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main(process.argv.slice(2));
}
