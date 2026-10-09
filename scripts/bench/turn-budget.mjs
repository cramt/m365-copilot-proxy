// Bench pacing, OFF unless M365_AVOID_THROTTLING=1: wait before a task until the
// account can afford it, so a sweep doesn't trip M365's `PerUserThrottled`
// (hypotheses §24 F58). Without it the bench runs as fast as before and
// still stops at the first throttled task.
//
// The model (F58): the account holds a bucket of ~100 turns that refills at
// ~1.6 turns a minute; every upstream turn takes one (fresh conversation or
// not, Disengaged included) and the throttle starts when it runs dry. Fitted on
// four premium-account onsets, then predicted three more on all three accounts
// to within a few turns without refitting — always a little optimistic (the
// throttle came with 6 turns still "left" at worst), hence the reserve.
//
// The proxy writes one `[session] Chat turn` line per upstream turn, and a
// `Turn result: Throttled` line per throttled turn, to its debug log when
// M365_DEBUG=1 — phase-sweep always sets it, and has each arm's proxy write its
// log straight into the sweep archive. This replays every recently modified debug
// log under ~/.config/opencode-m365 (archives included), plus the M365_LOG_FILE
// this process sees, through the bucket. The replay starts full only where the
// bucket was provably full: after a quiet stretch of capacity/refill minutes
// (~1 h). It reads back 6 h, then 24 h, then 72 h until it finds one, and starts
// EMPTY if it doesn't. (Starting full 6 h back, as it used to, is wrong for a
// sweep busy for longer than that: once its opening burst left the window the
// replay handed those ~70 turns back, the pacing stopped, and the premium
// account throttled 6 h 11 min into a paced sweep — hypotheses §30.) Turns it can't see don't count: a proxy
// run without M365_DEBUG, the web client, another host on the same account. The
// reserve absorbs some of that; a sudden throttle still stops the bench as before.
//
// After a throttled turn it also waits for HOLD minutes of quiet: the throttle
// lifts with idle time, not with the bucket — on 2026-10-05 the premium account
// was still throttled 60 min after its only throttled turn, with nothing sent in
// between and the bucket long since refilled, while two non-premium accounts
// were served again 57 and 60 min after theirs (F58). 75 covers every case seen.
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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const num = (v, d) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

export function budgetConfig(env = process.env) {
  const cfgDir = join(homedir(), ".config", "opencode-m365");
  return {
    capacity: num(env.M365_BUDGET_CAPACITY, 100),
    refillPerMin: num(env.M365_BUDGET_REFILL, 1.6),
    reserve: num(env.M365_BUDGET_RESERVE, 20),
    holdMin: num(env.M365_BUDGET_HOLD_MIN, 75),
    // How far back the logs are read first; budgetStatus reads 4x further, up
    // to maxWindowMin, until the window holds a quiet stretch (see replay).
    windowMin: 360,
    maxWindowMin: 4320,
    enabled: !!env.M365_AVOID_THROTTLING && env.M365_AVOID_THROTTLING !== "0",
    dirs: [
      cfgDir,
      ...(env.M365_LOG_FILE ? [resolve(cfgDir, env.M365_LOG_FILE)] : []),
      ...(env.M365_BUDGET_LOGS ?? "").split(":").filter(Boolean),
    ],
  };
}

const EVENT = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] \[\w+\] \[session\] (Chat turn|Turn result: Throttled)/gm;
const LOG_FILE = /debug.*\.log$/;
const SKIP_DIR = /^(browser-profile|node_modules)$|frames/;

/** Turn and throttle events in log text: [{ t, kind: "turn" | "throttled", line }]. */
export function parseEvents(text) {
  const out = [];
  for (const m of text.matchAll(EVENT)) {
    out.push({ t: Date.parse(m[1]), kind: m[2] === "Chat turn" ? "turn" : "throttled", line: m[0] });
  }
  return out;
}

/** Debug logs under `dirs` modified since `sinceMs`. A file named in `dirs` counts whatever its name. */
export function findLogs(dirs, sinceMs, depth = 3) {
  const out = [];
  const walk = (p, d) => {
    let st;
    try { st = statSync(p); } catch { return; }
    if (st.isFile()) { if ((d === 0 || LOG_FILE.test(basename(p))) && st.mtimeMs >= sinceMs) out.push(p); return; }
    if (!st.isDirectory() || d > depth) return;
    let names = [];
    try { names = readdirSync(p); } catch { return; }
    for (const n of names) if (!SKIP_DIR.test(n)) walk(join(p, n), d + 1);
  };
  for (const d of dirs) walk(resolve(d), 0);
  return [...new Set(out)];
}

/**
 * Replay events through the bucket and report it at `nowMs`. Pure.
 * Only events since `nowMs - windowMin` count; the logs hold every one of those.
 * A bucket left alone for capacity/refill minutes is full whatever came before,
 * so the replay starts full at the end of the LAST quiet stretch that long
 * (`settled`). A window busy throughout says nothing about where the bucket
 * stood when it opened, so the replay then starts there EMPTY, and
 * `settled: false` asks for a longer window. The same log line seen in two
 * files counts once.
 */
export function replay(events, nowMs, cfg) {
  const start = nowMs - cfg.windowMin * 60_000;
  const fullAfterMs = (cfg.capacity / cfg.refillPerMin) * 60_000;
  const seen = new Set();
  const evs = events
    .filter((e) => e.t >= start && e.t <= nowMs && !seen.has(e.line) && seen.add(e.line))
    .sort((a, b) => a.t - b.t);
  // A throttle before the quiet stretch still holds: the hold outlasts the refill.
  const lastThrottle = evs.reduce((t, e) => (e.kind === "throttled" ? e.t : t), null);
  let first = -1;
  for (let i = evs.length; i >= 0; i--) {
    const gapStart = i > 0 ? evs[i - 1].t : start;
    const gapEnd = i < evs.length ? evs[i].t : nowMs;
    if (gapEnd - gapStart >= fullAfterMs) { first = i; break; }
  }
  const settled = first >= 0;
  let level = settled ? cfg.capacity : 0;
  const since = settled ? (first < evs.length ? evs[first].t : nowMs) : start;
  let last = since, turns = 0;
  for (const e of evs.slice(settled ? first : 0)) {
    level = Math.min(cfg.capacity, level + ((e.t - last) / 60_000) * cfg.refillPerMin);
    last = e.t;
    if (e.kind === "turn") { level -= 1; turns++; }
    else level = Math.min(level, 0);
  }
  level = Math.min(cfg.capacity, level + ((nowMs - last) / 60_000) * cfg.refillPerMin);
  return { level, turns, lastThrottle, settled, since };
}

/**
 * Whether a task needing `need` turns may start now, and if not, how long until
 * it may (assuming nothing else spends turns meanwhile).
 */
export function decide(state, need, nowMs, cfg) {
  const want = need + cfg.reserve;
  const holdUntil = state.lastThrottle == null ? 0 : state.lastThrottle + cfg.holdMin * 60_000;
  const refillMs = state.level >= want ? 0 : ((want - state.level) / cfg.refillPerMin) * 60_000;
  const waitMs = Math.max(holdUntil - nowMs, refillMs, 0);
  const reason = holdUntil > nowMs && holdUntil - nowMs >= refillMs ? "throttle hold" : "refill";
  return { ok: waitMs === 0, waitMs, want, reason };
}

/** The bucket at `nowMs`, read back as far as it takes to find where it was last full (see replay). */
export function budgetStatus(nowMs = Date.now(), cfg = budgetConfig()) {
  const maxWindowMin = Math.max(cfg.windowMin, cfg.maxWindowMin ?? cfg.windowMin);
  for (let windowMin = cfg.windowMin; ; windowMin = Math.min(windowMin * 4, maxWindowMin)) {
    const logs = findLogs(cfg.dirs, nowMs - windowMin * 60_000);
    const events = logs.flatMap((f) => { try { return parseEvents(readFileSync(f, "utf8")); } catch { return []; } });
    const st = replay(events, nowMs, { ...cfg, windowMin });
    if (st.settled || windowMin >= maxWindowMin) return { ...st, logs: logs.length, windowMin };
  }
}

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
      if (announced) log(`[${label}] pacing: resumed after ${fmtMin(now() - t0)} (bucket ~${st.level.toFixed(0)})`);
      return { waitedMs: now() - t0 };
    }
    if (!announced) {
      log(`[${label}] pacing: bucket ~${st.level.toFixed(0)}/${cfg.capacity} turns, need ${need} + reserve ${cfg.reserve}` +
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
      `${cfg.enabled ? "" : " [pacing is off: set M365_AVOID_THROTTLING=1 to have the bench wait]"}`);
  } else if (cmd === "wait") {
    await waitForBudget({ need: Number(opt("--need", "12")), label: opt("--label", "bench"), cfg });
  } else {
    console.error("usage: turn-budget.mjs status [--at ISO] [--need N] | wait [--need N] [--label L]");
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main(process.argv.slice(2));
