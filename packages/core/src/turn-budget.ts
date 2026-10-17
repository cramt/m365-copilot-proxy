import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createLogger, fileLoggingEnabled, LOG_PATH } from "./log.js";

const log = createLogger("turn-budget");

// Throttle avoidance, OFF unless M365_AVOID_THROTTLING=1: wait before an
// upstream turn until the account can afford it, so neither a bench sweep nor a
// long pi session trips M365's `PerUserThrottled` (hypotheses §24 F58, §37).
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
// M365_DEBUG=1. The replay reads every recently modified debug log under
// ~/.config/opencode-m365 (archives included), plus M365_LOG_FILE, so every
// process on the account that logs agrees on the bucket: the bench, its proxies,
// a pi session's proxy. A proxy that doesn't log counts its own turns in memory.
// The replay starts full only where the bucket was provably full: after a quiet
// stretch of capacity/refill minutes (~1 h). It reads back 6 h, then 24 h, then
// 72 h until it finds one, and starts EMPTY if it doesn't. (Starting full 6 h
// back is wrong for anything busy for longer than that: once its opening burst
// left the window the replay handed those ~70 turns back, the bench stopped
// waiting, and the premium account throttled 6 h 11 min into a sweep run with
// M365_AVOID_THROTTLING —
// hypotheses §30.) Turns it can't see don't count: a proxy run without
// M365_DEBUG on another process, the web client, another host on the same
// account. The reserve absorbs some of that.
//
// After a throttled turn it also waits for HOLD minutes: the throttle lifts
// with idle time, not with the bucket — on 2026-10-05 the premium account was
// still throttled 60 min after its only throttled turn, with nothing sent in
// between and the bucket long since refilled, while two non-premium accounts
// were served again 57 and 60 min after theirs (F58). 75 covers every case seen.
//
// Two users: the bench waits before each task for the turns a whole task may
// take (scripts/bench/turn-budget.mjs), and the proxy waits before each
// upstream turn for one (awaitTurnBudget). Both keep the same reserve, so a
// task the bench let start never waits inside the proxy.
//
// Env: M365_AVOID_THROTTLING=1 (turn the waiting on), M365_BUDGET_CAPACITY (100
//   turns), M365_BUDGET_REFILL (1.6 turns/min), M365_BUDGET_RESERVE (20 turns kept
//   back), M365_BUDGET_HOLD_MIN (75), M365_BUDGET_MAX_WAIT_MIN (15: the longest
//   the proxy holds a streamed request; longer waits get a 429),
//   M365_BUDGET_LOGS (more log files or dirs, `:`-separated; phase-sweep adds its
//   archive), M365_LOG_FILE (as the logger reads it: relative to
//   ~/.config/opencode-m365).

export interface BudgetConfig {
  capacity: number;
  refillPerMin: number;
  reserve: number;
  holdMin: number;
  /** How far back the logs are read first; budgetStatus reads 4x further, up to maxWindowMin, until the window holds a quiet stretch. */
  windowMin: number;
  maxWindowMin?: number;
  /** The longest the proxy holds a streamed request waiting (awaitTurnBudget). */
  maxWaitMin: number;
  enabled: boolean;
  dirs: string[];
}

export interface BudgetEvent {
  t: number;
  kind: "turn" | "throttled";
  /** Identifies the event across files: the same log line seen twice counts once. */
  line: string;
}

export interface BudgetState {
  level: number;
  turns: number;
  lastThrottle: number | null;
  settled: boolean;
  since: number;
}

export interface BudgetDecision {
  ok: boolean;
  waitMs: number;
  want: number;
  reason: "refill" | "throttle hold";
}

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

const CONFIG_DIR = join(homedir(), ".config", "opencode-m365");
/** The furthest back the replay reads (72 h). */
const MAX_WINDOW_MIN = 4320;

export function budgetConfig(env: Record<string, string | undefined> = process.env): BudgetConfig {
  return {
    capacity: num(env.M365_BUDGET_CAPACITY, 100),
    refillPerMin: num(env.M365_BUDGET_REFILL, 1.6),
    reserve: num(env.M365_BUDGET_RESERVE, 20),
    holdMin: num(env.M365_BUDGET_HOLD_MIN, 75),
    windowMin: 360,
    maxWindowMin: MAX_WINDOW_MIN,
    maxWaitMin: num(env.M365_BUDGET_MAX_WAIT_MIN, 15),
    enabled: !!env.M365_AVOID_THROTTLING && env.M365_AVOID_THROTTLING !== "0",
    dirs: [
      CONFIG_DIR,
      ...(env.M365_LOG_FILE ? [resolve(CONFIG_DIR, env.M365_LOG_FILE)] : []),
      ...(env.M365_BUDGET_LOGS ?? "").split(":").filter(Boolean),
    ],
  };
}

const EVENT = /^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] \[\w+\] \[session\] (Chat turn|Turn result: Throttled)/gm;
const LOG_FILE = /debug.*\.log$/;
const SKIP_DIR = /^(browser-profile|node_modules)$|frames/;

/** Turn and throttle events in log text. */
export function parseEvents(text: string): BudgetEvent[] {
  const out: BudgetEvent[] = [];
  for (const m of text.matchAll(EVENT)) {
    out.push({ t: Date.parse(m[1]!), kind: m[2] === "Chat turn" ? "turn" : "throttled", line: m[0] });
  }
  return out;
}

/** Debug logs under `dirs` modified since `sinceMs`. A file named in `dirs` counts whatever its name. */
export function findLogs(dirs: string[], sinceMs: number, depth = 3): string[] {
  const out: string[] = [];
  const isRecent = (p: string) => { try { return statSync(p).mtimeMs >= sinceMs; } catch { return false; } };
  const walk = (p: string, d: number) => {
    if (d > depth) return;
    let entries;
    try { entries = readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (SKIP_DIR.test(e.name)) continue;
      const q = join(p, e.name);
      let isDir = e.isDirectory();
      if (e.isSymbolicLink()) { try { isDir = statSync(q).isDirectory(); } catch { continue; } }
      if (isDir) walk(q, d + 1);
      else if (LOG_FILE.test(e.name) && isRecent(q)) out.push(q);
    }
  };
  for (const d of dirs) {
    const p = resolve(d);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isFile()) { if (st.mtimeMs >= sinceMs) out.push(p); }
    else if (st.isDirectory()) walk(p, 0);
  }
  return [...new Set(out)];
}

// The proxy replays the logs before every turn, and a debug log only grows, so
// each file is read once and then only from where the last read stopped.
interface CachedLog { ino: number; size: number; mtimeMs: number; offset: number; keptFrom: number; events: BudgetEvent[] }
const logCache = new Map<string, CachedLog>();

/**
 * The events in one log file at or after `keepFrom`, reading only what was
 * appended since the last call. A line still being written waits for the next
 * read; a file that shrank or was replaced is read again from the start.
 */
export function readLogEvents(path: string, keepFrom = 0): BudgetEvent[] {
  let st;
  try { st = statSync(path); } catch { logCache.delete(path); return []; }
  let c = logCache.get(path);
  if (c && c.ino === st.ino && c.size === st.size && c.mtimeMs === st.mtimeMs && c.keptFrom <= keepFrom) {
    return c.events.filter((e) => e.t >= keepFrom);
  }
  if (!c || c.ino !== st.ino || st.size < c.offset || keepFrom < c.keptFrom) {
    c = { ino: st.ino, size: 0, mtimeMs: 0, offset: 0, keptFrom: keepFrom, events: [] };
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(st.size - c.offset);
    const n = readSync(fd, buf, 0, buf.length, c.offset);
    const end = buf.subarray(0, n).lastIndexOf(0x0a) + 1;
    const fresh = parseEvents(buf.toString("utf8", 0, end));
    c = {
      ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, offset: c.offset + end, keptFrom: keepFrom,
      events: [...c.events, ...fresh].filter((e) => e.t >= keepFrom),
    };
  } catch {
    return c.events.filter((e) => e.t >= keepFrom);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  logCache.set(path, c);
  return c.events;
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
export function replay(events: BudgetEvent[], nowMs: number, cfg: Pick<BudgetConfig, "windowMin" | "capacity" | "refillPerMin">): BudgetState {
  const start = nowMs - cfg.windowMin * 60_000;
  const fullAfterMs = (cfg.capacity / cfg.refillPerMin) * 60_000;
  const seen = new Set<string>();
  const evs = events
    .filter((e) => e.t >= start && e.t <= nowMs && !seen.has(e.line) && seen.add(e.line))
    .sort((a, b) => a.t - b.t);
  // A throttle before the quiet stretch still holds: the hold outlasts the refill.
  const lastThrottle = evs.reduce<number | null>((t, e) => (e.kind === "throttled" ? e.t : t), null);
  let first = -1;
  for (let i = evs.length; i >= 0; i--) {
    const gapStart = i > 0 ? evs[i - 1]!.t : start;
    const gapEnd = i < evs.length ? evs[i]!.t : nowMs;
    if (gapEnd - gapStart >= fullAfterMs) { first = i; break; }
  }
  const settled = first >= 0;
  let level = settled ? cfg.capacity : 0;
  const since = settled ? (first < evs.length ? evs[first]!.t : nowMs) : start;
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
 * Whether something needing `need` turns may start now, and if not, how long
 * until it may (assuming nothing else spends turns meanwhile).
 */
export function decide(state: Pick<BudgetState, "level" | "lastThrottle">, need: number, nowMs: number, cfg: Pick<BudgetConfig, "reserve" | "holdMin" | "refillPerMin">): BudgetDecision {
  const want = need + cfg.reserve;
  const holdUntil = state.lastThrottle == null ? 0 : state.lastThrottle + cfg.holdMin * 60_000;
  const refillMs = state.level >= want ? 0 : ((want - state.level) / cfg.refillPerMin) * 60_000;
  const waitMs = Math.max(holdUntil - nowMs, refillMs, 0);
  const reason = holdUntil > nowMs && holdUntil - nowMs >= refillMs ? "throttle hold" : "refill";
  return { ok: waitMs === 0, waitMs, want, reason };
}

/**
 * The bucket at `nowMs`, read back as far as it takes to find where it was last
 * full (see replay). `extra` are events no log holds (the proxy's own, see below).
 */
export function budgetStatus(nowMs = Date.now(), cfg: BudgetConfig = budgetConfig(), extra: BudgetEvent[] = []): BudgetState & { logs: number; windowMin: number } {
  const maxWindowMin = Math.max(cfg.windowMin, cfg.maxWindowMin ?? cfg.windowMin);
  const keepFrom = nowMs - maxWindowMin * 60_000;
  for (let windowMin = cfg.windowMin; ; windowMin = Math.min(windowMin * 4, maxWindowMin)) {
    const logs = findLogs(cfg.dirs, nowMs - windowMin * 60_000);
    const events = logs.flatMap((f) => readLogEvents(f, keepFrom));
    const st = replay([...events, ...extra], nowMs, { ...cfg, windowMin });
    if (st.settled || windowMin >= maxWindowMin) return { ...st, logs: logs.length, windowMin };
  }
}

// --- The proxy's wait before each turn (awaitTurnBudget) ---

/** awaitTurnBudget refused to wait that long: a throttle hold, or a refill past the request's limit. */
export class TurnBudgetHold extends Error {
  constructor(
    readonly reason: BudgetDecision["reason"],
    readonly waitMs: number,
    readonly lastThrottle: number | null,
  ) {
    super(reason === "throttle hold"
      ? `M365 throttled this account at ${new Date(lastThrottle!).toISOString()}; holding new turns for ~${Math.ceil(waitMs / 60_000)} more min so the throttle can lift`
      : `the account's turn budget needs ~${Math.ceil(waitMs / 60_000)} min to refill before the next turn`);
    this.name = "TurnBudgetHold";
  }
}

// This process's turns, recorded where session.ts logs them. Counted only when
// this process doesn't write a debug log (otherwise the log already holds them).
const ownEvents: BudgetEvent[] = [];
// Turns let through but not yet started: the token, an image upload or the agent
// lookup can come in between. Counted until session.ts records the turn, so a
// request deciding meanwhile sees it.
const grants: number[] = [];
const GRANT_TTL_MS = 5 * 60_000;
let ownSeq = 0;
// Requests waiting to decide, in arrival order. The first is deciding (and may
// be sleeping on the bucket); the rest wait for it. `go` moves one to the front.
interface InLine { go: () => void }
const line: InLine[] = [];

function pruneOwn(nowMs: number): void {
  const keepFrom = nowMs - MAX_WINDOW_MIN * 60_000;
  while (ownEvents.length && ownEvents[0]!.t < keepFrom) ownEvents.shift();
  while (grants.length && grants[0]! < nowMs - GRANT_TTL_MS) grants.shift();
}

/** An upstream turn starting. CopilotSession.chat calls it where it logs `Chat turn`. */
export function recordTurn(nowMs = Date.now()): void {
  grants.shift();
  ownEvents.push({ t: nowMs, kind: "turn", line: `own:${ownSeq++}` });
  pruneOwn(nowMs);
}

/** A throttled turn. session.ts calls it where it logs `Turn result: Throttled`. */
export function recordThrottle(nowMs = Date.now()): void {
  ownEvents.push({ t: nowMs, kind: "throttled", line: `own:${ownSeq++}` });
}

/**
 * The bucket as the proxy sees it: the logs, this process's grants, and its own
 * turns unless `logged` says its debug log already holds them.
 */
export function proxyBudgetStatus(nowMs = Date.now(), cfg: BudgetConfig = budgetConfig(), logged = fileLoggingEnabled()): ReturnType<typeof budgetStatus> {
  pruneOwn(nowMs);
  const extra: BudgetEvent[] = [
    ...(logged ? [] : ownEvents),
    ...grants.map((t, i) => ({ t, kind: "turn" as const, line: `grant:${t}:${i}` })),
  ];
  const dirs = logged && !cfg.dirs.includes(LOG_PATH) ? [...cfg.dirs, LOG_PATH] : cfg.dirs;
  return budgetStatus(nowMs, { ...cfg, dirs }, extra);
}

/** Only for tests: forget this process's turns and grants. */
export function resetTurnBudget(): void {
  ownEvents.length = 0;
  grants.length = 0;
  logCache.clear();
  line.length = 0;
}

const abortableSleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  if (signal?.aborted) return rej(signal.reason);
  const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); res(); }, ms);
  const onAbort = () => { clearTimeout(t); rej(signal!.reason); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

const fmtWait = (ms: number) => (ms >= 90_000 ? `${(ms / 60_000).toFixed(1)} min` : `${Math.round(ms / 1000)} s`);

export interface AwaitTurnBudgetOptions {
  /** Aborts the wait (the client went away). */
  signal?: AbortSignal;
  /** Wait at most this long in total, and never past cfg.maxWaitMin; longer waits throw TurnBudgetHold. */
  maxWaitMs?: number;
  cfg?: BudgetConfig;
  /** Whether this process's turns reach its debug log (default: M365_DEBUG / M365_TRACE). */
  logged?: boolean;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Before an upstream turn: wait until the account can afford one more turn plus
 * the reserve (see the header). A no-op unless M365_AVOID_THROTTLING is set.
 * Throws TurnBudgetHold instead of waiting longer than `maxWaitMs` — in a
 * throttle hold, typically — so the caller can answer 429 without sending a turn
 * that would only keep the throttle alive. Requests decide one at a time, so two
 * can't both take the last turn above the reserve. The wait counts from the
 * call, time behind other requests included, and the signal and the limit end it
 * there too: a request queued behind a long wait leaves the line at its own
 * limit, and one whose client went away doesn't keep its place (#77).
 */
export async function awaitTurnBudget(opts: AwaitTurnBudgetOptions = {}): Promise<{ waitedMs: number }> {
  const cfg = opts.cfg ?? budgetConfig();
  if (!cfg.enabled) return { waitedMs: 0 };
  const now = opts.now ?? Date.now;
  const maxWaitMs = Math.min(cfg.maxWaitMin * 60_000, opts.maxWaitMs ?? Infinity);
  const t0 = now();
  const me: InLine = { go: () => {} };
  const front = new Promise<void>((res) => { me.go = res; });
  line.push(me);
  try {
    if (line[0] !== me && !(await untilFront(front, maxWaitMs, opts.signal))) {
      const at = now();
      const ahead = line.indexOf(me);
      const st = proxyBudgetStatus(at, cfg, opts.logged);
      // What the requests ahead and this one need; at least the front's next re-read.
      const d = decide(st, 1 + ahead, at, cfg);
      log.info(`Turn budget: ${fmtWait(at - t0)} in line behind ${ahead} other request(s), bucket ~${st.level.toFixed(0)}/${cfg.capacity} — more than this request may wait (${fmtWait(maxWaitMs)}), answering 429`);
      throw new TurnBudgetHold(d.reason, Math.max(d.waitMs, 15_000), st.lastThrottle);
    }
    return await waitForTurn(cfg, opts, t0, maxWaitMs);
  } finally {
    const i = line.indexOf(me);
    if (i >= 0) line.splice(i, 1);
    if (i === 0) line[0]?.go();
  }
}

/**
 * Resolves true once this request is at the front of the line, false if `ms`
 * pass first; rejects when `signal` aborts. A real timer: the requests ahead own
 * the clock (their sleeps), and this one must leave whatever they do.
 */
function untilFront(front: Promise<void>, ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise<boolean>((res, rej) => {
    if (signal?.aborted) return rej(signal.reason);
    const done = (settle: () => void) => { clearTimeout(t); signal?.removeEventListener("abort", onAbort); settle(); };
    const onAbort = () => done(() => rej(signal!.reason));
    const t = setTimeout(() => done(() => res(false)), Math.min(ms, 2 ** 31 - 1));
    signal?.addEventListener("abort", onAbort, { once: true });
    void front.then(() => done(() => res(true)));
  });
}

async function waitForTurn(cfg: BudgetConfig, opts: AwaitTurnBudgetOptions, t0: number, maxWaitMs: number): Promise<{ waitedMs: number }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  let announced = false;
  for (;;) {
    opts.signal?.throwIfAborted();
    const at = now();
    const st = proxyBudgetStatus(at, cfg, opts.logged);
    const d = decide(st, 1, at, cfg);
    if (d.ok) {
      grants.push(at);
      if (announced || at - t0 >= 1000) log.info(`Turn budget: sending after a ${fmtWait(at - t0)} wait (bucket ~${st.level.toFixed(0)}/${cfg.capacity})`);
      return { waitedMs: at - t0 };
    }
    if (at - t0 + d.waitMs > maxWaitMs) {
      log.info(`Turn budget: bucket ~${st.level.toFixed(0)}/${cfg.capacity}, ${d.reason} needs ~${fmtWait(d.waitMs)} — more than this request may wait (${fmtWait(maxWaitMs)}), answering 429`);
      throw new TurnBudgetHold(d.reason, d.waitMs, st.lastThrottle);
    }
    if (!announced) {
      log.info(`Turn budget: bucket ~${st.level.toFixed(0)}/${cfg.capacity} turns, need 1 + reserve ${cfg.reserve}` +
        `${d.reason === "throttle hold" ? `, throttled at ${new Date(st.lastThrottle!).toISOString()}` : ""} — waiting ~${fmtWait(d.waitMs)} (${d.reason})`);
      announced = true;
    }
    // Re-read the logs at least every 15 s: something else may be spending turns.
    await sleep(Math.min(Math.max(d.waitMs, 1000), 15_000), opts.signal);
  }
}
