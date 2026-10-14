import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { budgetConfig, budgetStatus, decide, findLogs, parseEvents, replay, waitForBudget } from "./turn-budget.mjs";

const T0 = Date.parse("2026-10-05T08:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const turnLine = (ms, n = 0) => `[${iso(ms)}] [INFO] [session] Chat turn ${n}: model=claude-sonnet, isFirst=true, text="x"`;
const throttleLine = (ms) => `[${iso(ms)}] [INFO] [session] Turn result: Throttled (PerUserThrottled)`;
const cfg = { capacity: 100, refillPerMin: 1.6, reserve: 20, holdMin: 60, windowMin: 360, enabled: true, dirs: [] };
const turns = (n, fromMs, everyMs) => Array.from({ length: n }, (_, i) => ({ t: fromMs + i * everyMs, kind: "turn", line: `t${fromMs + i * everyMs}` }));

describe("turn-budget", () => {
  it("parses turn and throttle lines and nothing else", () => {
    const text = [
      turnLine(T0),
      `[${iso(T0)}] [INFO] [model] run: model=claude-sonnet, agent=none, turn=0`,
      throttleLine(T0 + 1000),
      `[${iso(T0)}] [INFO] [handler] Upstream Throttled (PerUserThrottled) — 429, no retry`,
    ].join("\n");
    expect(parseEvents(text).map((e) => e.kind)).toEqual(["turn", "throttled"]);
  });

  it("takes one turn per event and refills at the configured rate, up to capacity", () => {
    // 60 turns in one minute, then 10 quiet minutes: 100 - 60 + ~1.6*11 = ~57.6
    const st = replay(turns(60, T0, 1000), T0 + 11 * 60_000, cfg);
    expect(st.turns).toBe(60);
    expect(st.level).toBeGreaterThan(57);
    expect(st.level).toBeLessThan(58.5);
    expect(replay(turns(60, T0, 1000), T0 + 300 * 60_000, cfg).level).toBe(100);
  });

  it("counts a log line seen in two files once, and ignores events outside the window", () => {
    const evs = turns(10, T0, 1000);
    expect(replay([...evs, ...evs], T0 + 10_000, cfg).turns).toBe(10);
    expect(replay(evs, T0 + 7 * 3_600_000, cfg).turns).toBe(0);
  });

  it("empties the bucket on a throttled turn and holds for HOLD minutes after it", () => {
    const evs = [...turns(5, T0, 1000), { t: T0 + 10_000, kind: "throttled", line: "thr" }];
    const st = replay(evs, T0 + 20 * 60_000, cfg);
    expect(st.lastThrottle).toBe(T0 + 10_000);
    expect(st.level).toBeLessThan(33); // 0 + 1.6 * ~20 min
    const d = decide({ ...st, level: 100 }, 12, T0 + 20 * 60_000, cfg);
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("throttle hold");
    expect(Math.round(d.waitMs / 60_000)).toBe(40);
  });

  it("starts the replay full only after a quiet stretch, so a long paced sweep doesn't get its opening burst back", () => {
    // A paced sweep: 70 turns in its first 10 min, then exactly the refill rate
    // for 7 h. The bucket really sits at ~46 the whole time (100 - 70 + 16).
    const evs = [...turns(70, T0, 8_500), ...turns(672, T0 + 10 * 60_000, 37_500)];
    const now = T0 + 7 * 3_600_000;
    const st = replay(evs, now, { ...cfg, windowMin: 1440 });
    expect(st.settled).toBe(true);
    expect(st.since).toBe(T0);
    expect(st.level).toBeGreaterThan(40);
    expect(st.level).toBeLessThan(50);
    // A 6 h window holds no quiet hour: it starts empty instead of full (the old
    // replay started full here and said ~100) and asks for a longer window.
    const short = replay(evs, now, cfg);
    expect(short.settled).toBe(false);
    expect(short.since).toBe(now - 360 * 60_000);
    expect(short.level).toBeLessThan(st.level);
  });

  it("reads further back until it finds where the bucket was last full", () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-budget-"));
    const evs = [...turns(70, T0, 8_500), ...turns(672, T0 + 10 * 60_000, 37_500)];
    writeFileSync(join(dir, "s-debug.log"), evs.map((e, i) => turnLine(e.t, i)).join("\n") + "\n");
    const st = budgetStatus(T0 + 7 * 3_600_000, { ...cfg, maxWindowMin: 4320, dirs: [dir] });
    expect(st.settled).toBe(true);
    expect(st.windowMin).toBe(1440);
    expect(st.since).toBe(T0);
    expect(st.level).toBeLessThan(50);
  });

  it("keeps a throttle's hold even when the bucket has refilled since", () => {
    // 65 quiet minutes: the bucket is full again, but a 75-min hold isn't over.
    const hold = { ...cfg, holdMin: 75 };
    const evs = [...turns(5, T0, 1000), { t: T0 + 10_000, kind: "throttled", line: "thr" }];
    const now = T0 + 10_000 + 65 * 60_000;
    const st = replay(evs, now, hold);
    expect(st.level).toBe(100);
    expect(st.lastThrottle).toBe(T0 + 10_000);
    const d = decide(st, 12, now, hold);
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("throttle hold");
    expect(Math.round(d.waitMs / 60_000)).toBe(10);
  });

  it("lets a task start only with need + reserve turns left, and says how long the refill takes", () => {
    expect(decide({ level: 32, lastThrottle: null }, 12, T0, cfg).ok).toBe(true);
    const d = decide({ level: 16, lastThrottle: null }, 12, T0, cfg);
    expect(d.ok).toBe(false);
    expect(d.reason).toBe("refill");
    expect(d.waitMs).toBe(10 * 60_000); // 16 short at 1.6/min
  });

  it("waits on a drained account until the logs say there's room, re-reading them while it waits", async () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-budget-"));
    // 90 turns over the 90 s before T0: the bucket is at ~12, short of 12 + 20.
    writeFileSync(join(dir, "x-debug.log"), Array.from({ length: 90 }, (_, i) => turnLine(T0 - 90_000 + i * 1000, i)).join("\n") + "\n");
    let now = T0;
    const slept = [];
    const lines = [];
    const res = await waitForBudget({
      need: 12, label: "t", log: (l) => lines.push(l), cfg: { ...cfg, dirs: [dir] },
      now: () => now, sleep: async (ms) => { slept.push(ms); now += ms; },
    });
    expect(slept.every((ms) => ms <= 60_000)).toBe(true);
    expect(res.waitedMs).toBeGreaterThan(10 * 60_000);
    expect(res.waitedMs).toBeLessThan(14 * 60_000);
    expect(lines[0]).toMatch(/^\[t\] pacing: bucket ~1\d\/100 turns, need 12 \+ reserve 20 — waiting/);
    expect(lines.at(-1)).toMatch(/^\[t\] pacing: resumed after/);
  });

  it("is off unless M365_AVOID_THROTTLING is set, and then never waits", async () => {
    expect(budgetConfig({}).enabled).toBe(false);
    expect(budgetConfig({ M365_AVOID_THROTTLING: "0" }).enabled).toBe(false);
    expect(budgetConfig({ M365_AVOID_THROTTLING: "1" }).enabled).toBe(true);
    const res = await waitForBudget({ cfg: { ...cfg, enabled: false }, sleep: () => { throw new Error("slept"); } });
    expect(res.waitedMs).toBe(0);
  });

  it("reads the proxy's M365_LOG_FILE, relative to the config dir, whatever it is named", () => {
    const cfgDir = join(homedir(), ".config", "opencode-m365");
    expect(budgetConfig({ M365_LOG_FILE: "my/log.log" }).dirs).toContain(join(cfgDir, "my", "log.log"));
    expect(budgetConfig({ M365_LOG_FILE: "/abs/x.log" }).dirs).toContain("/abs/x.log");
    const dir = mkdtempSync(join(tmpdir(), "turn-budget-"));
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "proxy.log"), turnLine(T0) + "\n");
    writeFileSync(join(dir, "sub", "other.log"), turnLine(T0) + "\n");
    writeFileSync(join(dir, "sub", "a-debug.log"), turnLine(T0) + "\n");
    expect(findLogs([join(dir, "proxy.log")], 0)).toEqual([join(dir, "proxy.log")]);
    expect(findLogs([dir], 0)).toEqual([join(dir, "sub", "a-debug.log")]);
  });
});
