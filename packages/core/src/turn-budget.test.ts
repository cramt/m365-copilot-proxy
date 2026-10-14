import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  awaitTurnBudget,
  budgetConfig,
  paceStatus,
  readLogEvents,
  recordThrottle,
  recordTurn,
  resetTurnBudget,
  TurnBudgetHold,
  type BudgetConfig,
} from "./turn-budget.js";

// The model itself (replay, decide, the window search) is tested in
// scripts/bench/turn-budget.test.mjs, against the built package. This covers
// what the proxy adds: reading logs as they grow, and waiting before a turn.

const T0 = Date.parse("2026-10-12T08:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const turnLine = (ms: number, n = 0) => `[${iso(ms)}] [INFO] [session] Chat turn ${n}: model=claude-sonnet, isFirst=false, text="x"\n`;
const throttleLine = (ms: number) => `[${iso(ms)}] [INFO] [session] Turn result: Throttled (PerUserThrottled)\n`;

function logDir(lines: string[] = []): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "turn-budget-"));
  const file = join(dir, "debug.log");
  writeFileSync(file, lines.join(""));
  return { dir, file };
}

const cfgFor = (dir: string, over: Partial<BudgetConfig> = {}): BudgetConfig => ({
  capacity: 100, refillPerMin: 1.6, reserve: 20, holdMin: 75, windowMin: 360, maxWindowMin: 4320,
  maxWaitMin: 15, enabled: true, dirs: [dir], ...over,
});

/** A fake clock whose sleeps advance it. */
function clock(start = T0) {
  const c = { t: start, slept: [] as number[] };
  return {
    c,
    // As a proxy without M365_DEBUG: its own turns are counted from memory, and
    // its real debug log isn't read.
    logged: false,
    now: () => c.t,
    sleep: async (ms: number, signal?: AbortSignal) => { signal?.throwIfAborted(); c.slept.push(ms); c.t += ms; },
  };
}

afterEach(() => resetTurnBudget());

describe("readLogEvents", () => {
  it("reads only what was appended since the last read", () => {
    const { file } = logDir([turnLine(T0), turnLine(T0 + 1000, 1)]);
    expect(readLogEvents(file)).toHaveLength(2);
    appendFileSync(file, turnLine(T0 + 2000, 2) + throttleLine(T0 + 3000));
    const evs = readLogEvents(file);
    expect(evs.map((e) => e.kind)).toEqual(["turn", "turn", "turn", "throttled"]);
    expect(evs.at(-1)!.t).toBe(T0 + 3000);
  });

  it("holds back a line still being written until its newline arrives", () => {
    const { file } = logDir([turnLine(T0)]);
    const partial = turnLine(T0 + 1000, 1);
    appendFileSync(file, partial.slice(0, 20)); // the timestamp isn't even complete
    expect(readLogEvents(file)).toHaveLength(1);
    appendFileSync(file, partial.slice(20));
    expect(readLogEvents(file).map((e) => e.t)).toEqual([T0, T0 + 1000]);
  });

  it("reads a file that shrank from the start again", () => {
    const { file } = logDir([turnLine(T0), turnLine(T0 + 1000, 1), turnLine(T0 + 2000, 2)]);
    expect(readLogEvents(file)).toHaveLength(3);
    writeFileSync(file, turnLine(T0 + 5000));
    expect(readLogEvents(file).map((e) => e.t)).toEqual([T0 + 5000]);
  });

  it("drops events older than keepFrom, and reads again when asked for older ones", () => {
    const { file } = logDir([turnLine(T0), turnLine(T0 + 60_000, 1)]);
    expect(readLogEvents(file, T0 + 30_000).map((e) => e.t)).toEqual([T0 + 60_000]);
    expect(readLogEvents(file, T0).map((e) => e.t)).toEqual([T0, T0 + 60_000]);
  });

  it("returns nothing for a file that's gone", () => {
    const { dir, file } = logDir([turnLine(T0)]);
    expect(readLogEvents(file)).toHaveLength(1);
    rmSync(dir, { recursive: true });
    expect(readLogEvents(file)).toEqual([]);
  });
});

describe("awaitTurnBudget", () => {
  it("reads its limit from M365_BUDGET_MAX_WAIT_MIN", () => {
    expect(budgetConfig({}).maxWaitMin).toBe(15);
    expect(budgetConfig({ M365_BUDGET_MAX_WAIT_MIN: "90" }).maxWaitMin).toBe(90);
  });

  it("is a no-op unless enabled", async () => {
    const { dir } = logDir();
    const res = await awaitTurnBudget({ cfg: cfgFor(dir, { enabled: false }), logged: false, sleep: () => { throw new Error("slept"); } });
    expect(res.waitedMs).toBe(0);
  });

  it("lets a turn through at once with room above the reserve", async () => {
    const { dir } = logDir();
    const k = clock();
    expect((await awaitTurnBudget({ cfg: cfgFor(dir), logged: k.logged, now: k.now, sleep: k.sleep })).waitedMs).toBe(0);
    expect(k.c.slept).toEqual([]);
  });

  it("waits on a drained bucket until it holds one turn plus the reserve, re-reading every 15 s", async () => {
    // 85 turns in the 85 s before T0: the bucket is at ~17, short of 1 + 20.
    const { dir } = logDir(Array.from({ length: 85 }, (_, i) => turnLine(T0 - 85_000 + i * 1000, i)));
    const k = clock();
    const res = await awaitTurnBudget({ cfg: cfgFor(dir), logged: k.logged, now: k.now, sleep: k.sleep });
    expect(k.c.slept.every((ms) => ms <= 15_000)).toBe(true);
    // ~4 turns short at 1.6/min: about two and a half minutes.
    expect(res.waitedMs).toBeGreaterThan(2 * 60_000);
    expect(res.waitedMs).toBeLessThan(3 * 60_000);
  });

  it("counts a turn it let through before it starts, so the next request waits for it", async () => {
    // At exactly 21 turns: room for one, not two.
    const { dir } = logDir(Array.from({ length: 79 }, (_, i) => turnLine(T0 - 79 + i, i)));
    const k = clock();
    const cfg = cfgFor(dir);
    await awaitTurnBudget({ cfg, logged: k.logged, now: k.now, sleep: k.sleep });
    expect(k.c.slept).toEqual([]);
    await awaitTurnBudget({ cfg, logged: k.logged, now: k.now, sleep: k.sleep });
    expect(k.c.slept.length).toBeGreaterThan(0); // waited for the first one's turn
    // The grant is consumed when the turn starts, not counted twice.
    const before = paceStatus(k.now(), cfg, false).turns;
    recordTurn(k.now());
    expect(paceStatus(k.now(), cfg, false).turns).toBe(before);
  });

  it("decides one request at a time", async () => {
    const { dir } = logDir(Array.from({ length: 79 }, (_, i) => turnLine(T0 - 79 + i, i)));
    const k = clock();
    const cfg = cfgFor(dir);
    const [a, b] = await Promise.all([
      awaitTurnBudget({ cfg, logged: k.logged, now: k.now, sleep: k.sleep }),
      awaitTurnBudget({ cfg, logged: k.logged, now: k.now, sleep: k.sleep }),
    ]);
    expect(a.waitedMs).toBe(0);
    expect(b.waitedMs).toBeGreaterThan(0);
  });

  it("counts its own turns when it writes no log, and leaves them to the log when it does", async () => {
    // Years back, so the real debug log `logged` adds holds nothing in the window.
    const at = Date.parse("2020-01-01T00:00:00.000Z");
    const { dir } = logDir();
    const cfg = cfgFor(dir);
    for (let i = 0; i < 85; i++) recordTurn(at - 85 + i);
    const st = paceStatus(at, cfg, false);
    expect(st.turns).toBe(85);
    expect(st.level).toBeLessThan(21);
    expect(paceStatus(at, cfg, true).turns).toBe(0);
  });

  it("answers a throttle hold with TurnBudgetHold instead of waiting it out", async () => {
    const { dir } = logDir([turnLine(T0 - 10 * 60_000), throttleLine(T0 - 10 * 60_000)]);
    const k = clock();
    const err = await awaitTurnBudget({ cfg: cfgFor(dir), logged: k.logged, now: k.now, sleep: k.sleep }).catch((e) => e);
    expect(err).toBeInstanceOf(TurnBudgetHold);
    expect(err.reason).toBe("throttle hold");
    expect(Math.round(err.waitMs / 60_000)).toBe(65);
    expect(err.lastThrottle).toBe(T0 - 10 * 60_000);
    expect(k.c.slept).toEqual([]); // never slept on a wait it would refuse anyway
  });

  it("sees a throttle this process recorded", async () => {
    const { dir } = logDir();
    recordTurn(T0 - 1000);
    recordThrottle(T0 - 1000);
    const k = clock();
    const err = await awaitTurnBudget({ cfg: cfgFor(dir), logged: k.logged, now: k.now, sleep: k.sleep }).catch((e) => e);
    expect(err).toBeInstanceOf(TurnBudgetHold);
    expect(err.reason).toBe("throttle hold");
  });

  it("waits out the end of a hold that fits in the request's limit", async () => {
    const { dir } = logDir([throttleLine(T0 - 70 * 60_000)]);
    const k = clock();
    const res = await awaitTurnBudget({ cfg: cfgFor(dir), logged: k.logged, now: k.now, sleep: k.sleep });
    expect(Math.round(res.waitedMs / 60_000)).toBe(5);
  });

  it("refuses a refill longer than the request may wait, and the limit is the smaller of the two", async () => {
    // An empty bucket: 21 turns at 1.6/min is ~13 min, inside 15 but not inside 2.
    const { dir } = logDir(Array.from({ length: 100 }, (_, i) => turnLine(T0 - 100 + i, i)));
    const k = clock();
    const err = await awaitTurnBudget({ cfg: cfgFor(dir), maxWaitMs: 2 * 60_000, logged: k.logged, now: k.now, sleep: k.sleep }).catch((e) => e);
    expect(err).toBeInstanceOf(TurnBudgetHold);
    expect(err.reason).toBe("refill");
    const err2 = await awaitTurnBudget({ cfg: cfgFor(dir, { maxWaitMin: 1 }), maxWaitMs: 60 * 60_000, logged: k.logged, now: k.now, sleep: k.sleep }).catch((e) => e);
    expect(err2).toBeInstanceOf(TurnBudgetHold);
    const res = await awaitTurnBudget({ cfg: cfgFor(dir), logged: k.logged, now: k.now, sleep: k.sleep });
    expect(res.waitedMs).toBeGreaterThan(12 * 60_000);
  });

  it("stops waiting when the client goes away, and lets the next request decide", async () => {
    const { dir } = logDir(Array.from({ length: 90 }, (_, i) => turnLine(T0 - 90 + i, i)));
    const k = clock();
    const ac = new AbortController();
    const cfg = cfgFor(dir);
    const waiting = awaitTurnBudget({ cfg, logged: false, now: k.now, signal: ac.signal, sleep: (ms, signal) => new Promise((_, rej) => signal?.addEventListener("abort", () => rej(signal.reason))) });
    ac.abort(new Error("client gone"));
    await expect(waiting).rejects.toThrow("client gone");
    const res = await awaitTurnBudget({ cfg, logged: k.logged, now: k.now, sleep: k.sleep });
    expect(res.waitedMs).toBeGreaterThan(0);
  });
});
