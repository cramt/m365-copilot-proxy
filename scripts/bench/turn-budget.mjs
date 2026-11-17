// Throttle avoidance for the bench, OFF unless M365_AVOID_THROTTLING=1: wait
// before a task until the account can afford it, so a sweep doesn't trip M365's
// `PerUserThrottled` (hypotheses §24 F58). Without it the bench runs as fast as
// before and still stops at the first throttled task.
//
// The bucket model lives in the core package (packages/core/src/turn-budget.ts,
// which explains it), shared with the proxy: with the same variable set the
// proxy also waits before each upstream turn, which is what keeps a long pi
// session clear of the throttle (hypotheses §37). This file waits for a whole
// task's turns before it starts — the proxy then never has to wait inside it,
// both keeping the same reserve. Build first (`pnpm build`): it imports
// packages/core/dist.
//
// The replay reads the proxy's debug logs, so the proxy needs M365_DEBUG=1 —
// phase-sweep always sets it, and has each arm's proxy write its log straight
// into the sweep archive.
//
//   node scripts/bench/turn-budget.mjs status [--at ISO]     (works either way)
//   node scripts/bench/turn-budget.mjs wait [--need 12] [--label pi-rel]
//   import { waitForBudget } from "./turn-budget.mjs"   (run.mjs does)
//
// Env: M365_AVOID_THROTTLING=1 (turn the waiting on), M365_BUDGET_CAPACITY (100
//   turns), M365_BUDGET_REFILL (1.6 turns/min), M365_BUDGET_RESERVE (20 turns kept
//   back), M365_BUDGET_HOLD_MIN (75), M365_BUDGET_LOGS (more log files or dirs,
//   `:`-separated; phase-sweep adds its archive), M365_LOG_FILE (as the proxy
//   reads it: relative to ~/.config/opencode-m365).
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { budgetConfig, budgetStatus, decide } from "../../packages/core/dist/index.mjs";

export { budgetConfig, budgetStatus, decide, findLogs, parseEvents, replay } from "../../packages/core/dist/index.mjs";

const fmtMin = (ms) => `${(ms / 60_000).toFixed(1)} min`;

/** Block until the account can afford `need` more turns (see the header). A no-op unless M365_AVOID_THROTTLING is set. */
export async function waitForBudget({ need = 12, label = "bench", log = console.log, cfg = budgetConfig(), now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!cfg.enabled) return { waitedMs: 0 };
  const t0 = now();
  let announced = false;
  for (;;) {
    const st = budgetStatus(now(), cfg);
    const d = decide(st, need, now(), cfg);
    if (d.ok) {
      if (announced) log(`[${label}] turn budget: resumed after ${fmtMin(now() - t0)} (bucket ~${st.level.toFixed(0)})`);
      return { waitedMs: now() - t0 };
    }
    if (!announced) {
      log(`[${label}] turn budget: bucket ~${st.level.toFixed(0)}/${cfg.capacity} turns, need ${need} + reserve ${cfg.reserve}` +
        `${d.reason === "throttle hold" ? `, throttled at ${new Date(st.lastThrottle).toISOString()}` : ""} — waiting ~${fmtMin(d.waitMs)} (${d.reason})`);
      announced = true;
    }
    // Re-read the logs at least once a minute: something else may be spending turns.
    await sleep(Math.min(Math.max(d.waitMs, 1000), 60_000));
  }
}

async function main(argv) {
  const cmd = argv[0] ?? "status";
  const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  const cfg = budgetConfig();
  if (cmd === "status") {
    const at = opt("--at") ? Date.parse(opt("--at")) : Date.now();
    const st = budgetStatus(at, cfg);
    const d = decide(st, Number(opt("--need", "12")), at, cfg);
    console.log(`bucket ~${st.level.toFixed(1)}/${cfg.capacity} turns at ${new Date(at).toISOString()} (refill ${cfg.refillPerMin}/min, reserve ${cfg.reserve}; ${st.turns} turns since ${st.settled ? "it was last full at" : "the start of the logs read, assumed empty, at"} ${new Date(st.since).toISOString()}, from ${st.logs} logs` +
      `${st.lastThrottle ? `; last throttled turn ${new Date(st.lastThrottle).toISOString()}` : ""}) — ${d.ok ? "a task may start" : `wait ~${fmtMin(d.waitMs)} (${d.reason})`}` +
      `${cfg.enabled ? "" : " [M365_AVOID_THROTTLING is off: set it to 1 to have the bench and the proxy wait]"}`);
  } else if (cmd === "wait") {
    await waitForBudget({ need: Number(opt("--need", "12")), label: opt("--label", "bench"), cfg });
  } else {
    console.error("usage: turn-budget.mjs status [--at ISO] [--need N] | wait [--need N] [--label L]");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
