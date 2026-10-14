import { describe, it, expect, afterEach } from "vitest";
import {
  activePriorityAccessExhaustion,
  couldBePriorityAccessPrefix,
  notePriorityAccessExhausted,
  meteredAllowance,
  parseMetering,
  parsePriorityAccessExhaustion,
  priorityAccessExhaustionOf,
  resetPriorityAccessState,
  secondsUntilReset,
} from "./priority-access.js";

// Wednesday 2026-09-16T22:30:00Z — mid-week, late in the UTC day, so a naive
// local-time implementation would compute the wrong reset.
const WED = new Date("2026-09-16T22:30:00Z");

const DAILY =
  "You've used your available priority access to the Opus model for today. You can choose another available model or wait until tomorrow to use the Opus model again.";
const WEEKLY =
  "You've used your available priority access to the Opus model for the week. You can choose another available model or wait until Monday to use the Opus model again.";

describe("parsePriorityAccessExhaustion", () => {
  it("detects the daily cap and names the model", () => {
    const r = parsePriorityAccessExhaustion(DAILY, WED)!;
    expect(r.window).toBe("day");
    expect(r.model).toBe("Opus");
  });

  it("detects the weekly cap", () => {
    expect(parsePriorityAccessExhaustion(WEEKLY, WED)!.window).toBe("week");
  });

  it("resets the daily budget at the next midnight UTC", () => {
    const r = parsePriorityAccessExhaustion(DAILY, WED)!;
    expect(r.resetsAt.toISOString()).toBe("2026-09-17T00:00:00.000Z");
  });

  it("resets the weekly budget at the next Monday midnight UTC", () => {
    const r = parsePriorityAccessExhaustion(WEEKLY, WED)!;
    expect(r.resetsAt.toISOString()).toBe("2026-09-21T00:00:00.000Z");
    expect(r.resetsAt.getUTCDay()).toBe(1);
  });

  it("rolls a Monday-hit weekly cap to the NEXT Monday, not today", () => {
    const mon = new Date("2026-09-21T09:00:00Z"); // a Monday
    const r = parsePriorityAccessExhaustion(WEEKLY, mon)!;
    expect(r.resetsAt.toISOString()).toBe("2026-09-28T00:00:00.000Z");
  });

  it("handles a Sunday weekly cap (next day is Monday)", () => {
    const sun = new Date("2026-09-20T23:00:00Z");
    expect(parsePriorityAccessExhaustion(WEEKLY, sun)!.resetsAt.toISOString())
      .toBe("2026-09-21T00:00:00.000Z");
  });

  it("does not fire on ordinary content, including prose about rate limits", () => {
    expect(parsePriorityAccessExhaustion("The hostname is web-prod-01.")).toBeNull();
    expect(parsePriorityAccessExhaustion("This API is rate limited; wait until tomorrow and retry.")).toBeNull();
    expect(parsePriorityAccessExhaustion("Priority access to premium models is a licensing concept.")).toBeNull();
    expect(parsePriorityAccessExhaustion("")).toBeNull();
    expect(parsePriorityAccessExhaustion(null)).toBeNull();
  });

  it("tolerates wording drift (no model named, 'used up all of your')", () => {
    const r = parsePriorityAccessExhaustion(
      "You have used up all of your priority access for this week.",
      WED,
    )!;
    expect(r.window).toBe("week");
    expect(r.model).toBeUndefined();
  });

  it("finds the refusal even when it trails other text", () => {
    expect(parsePriorityAccessExhaustion(`Sorry — ${DAILY}`, WED)!.window).toBe("day");
  });
});

describe("secondsUntilReset", () => {
  it("counts down to the reset and never returns zero", () => {
    const r = parsePriorityAccessExhaustion(DAILY, WED)!;
    expect(secondsUntilReset(r, WED)).toBe(90 * 60); // 22:30Z → 00:00Z
    expect(secondsUntilReset(r, new Date("2026-09-17T00:00:00Z"))).toBe(1);
  });
});

describe("couldBePriorityAccessPrefix (stream-head gate)", () => {
  it("holds while the head is still a viable prefix of the refusal", () => {
    for (const head of ["", "You", "You'", "You've used", "You've used your available"]) {
      expect(couldBePriorityAccessPrefix(head), head).toBe(true);
    }
  });

  it("holds through M365's curly apostrophe", () => {
    expect(couldBePriorityAccessPrefix("You\u2019ve used your available")).toBe(true);
  });

  it("releases as soon as the head diverges", () => {
    for (const head of ["pong", "You should run npm install", "You've got mail", "The hostname is"]) {
      expect(couldBePriorityAccessPrefix(head), head).toBe(false);
    }
  });

  it("stays held once the full refusal opener has matched", () => {
    expect(couldBePriorityAccessPrefix(DAILY)).toBe(true);
    expect(couldBePriorityAccessPrefix(WEEKLY)).toBe(true);
  });
});

// The final item's throttling block of a paid-scenario Opus turn, verbatim
// (2026-10-05 00:01Z, the first Opus 5.5 turn after the weekly reset; §24 F55).
const METERING = {
  DeepResearch: { remainingAllowance: 100 },
  ClaudeOpusQuery: { remainingAllowance: 100 },
  ClaudeOpusQuery75: { remainingAllowance: 74 },
  ClaudeOpusQueryDev: { remainingAllowance: 5 },
  ClaudeOpusQueryC1: { remainingAllowance: 0 },
  ClaudeOpusQueryDaily: { remainingAllowance: 39 },
  ClaudeOpusQueryHourlyDev: { remainingAllowance: 2 },
  ClaudeOpusQueryWeeklyWord: { remainingAllowance: 75 },
  ClaudeOpusQueryDailyWord: { remainingAllowance: 40 },
};

describe("parseMetering / meteredAllowance", () => {
  it("flattens the metering map and picks out the Opus daily and weekly allowances", () => {
    const m = parseMetering(METERING)!;
    expect(m.ClaudeOpusQuery75).toBe(74);
    expect(m.DeepResearch).toBe(100);
    expect(meteredAllowance(m, "opus")).toEqual({ daily: 39, weekly: 74 });
  });

  it("picks out Sonnet 5.5's allowances, apart from Opus's (§26)", () => {
    // Read off a Sonnet 5.5 turn on 2026-10-06, after its first turn of the week.
    const m = parseMetering({
      ...METERING,
      ClaudeSonnet55QueryDaily: { remainingAllowance: 79 },
      ClaudeSonnet55QueryWeekly: { remainingAllowance: 149 },
    })!;
    expect(meteredAllowance(m, "sonnet-5.5")).toEqual({ daily: 79, weekly: 149 });
    expect(meteredAllowance(m, "opus")).toEqual({ daily: 39, weekly: 74 });
    expect(meteredAllowance(parseMetering(METERING), "sonnet-5.5")).toBeNull();
  });

  it("returns null when there is nothing to read (included scenario: no metering)", () => {
    expect(parseMetering(undefined)).toBeNull();
    expect(parseMetering({})).toBeNull();
    expect(parseMetering({ X: { remainingAllowance: "3" } })).toBeNull();
    expect(meteredAllowance(null, "opus")).toBeNull();
    expect(meteredAllowance({ DeepResearch: 100 }, "opus")).toBeNull();
  });
});

describe("priorityAccessExhaustionOf (result + text)", () => {
  it("reads the OutOfCredits result's message", () => {
    const r = priorityAccessExhaustionOf({ value: "OutOfCredits", message: WEEKLY }, "", WED)!;
    expect(r.window).toBe("week");
    expect(r.resetsAt.toISOString()).toBe("2026-09-21T00:00:00.000Z");
  });

  it("trusts OutOfCredits even if the refusal is ever reworded", () => {
    const r = priorityAccessExhaustionOf({ value: "OutOfCredits", message: "Opus is unavailable until tomorrow." }, "", WED)!;
    expect(r.window).toBe("day");
    expect(r.resetsAt.toISOString()).toBe("2026-09-17T00:00:00.000Z");
    expect(priorityAccessExhaustionOf({ value: "OutOfCredits", message: "back on Monday" }, "", WED)!.window).toBe("week");
  });

  it("still catches the text alone, and ignores ordinary turns", () => {
    expect(priorityAccessExhaustionOf({ value: "Success" }, DAILY, WED)!.window).toBe("day");
    expect(priorityAccessExhaustionOf({ value: "Success" }, "Done.", WED)).toBeNull();
    expect(priorityAccessExhaustionOf(null, null, WED)).toBeNull();
  });
});

describe("remembering an exhaustion until its reset", () => {
  afterEach(() => resetPriorityAccessState());

  it("is active until the reset, then forgotten", () => {
    const e = parsePriorityAccessExhaustion(DAILY, WED)!;
    notePriorityAccessExhausted("opus", e, WED);
    expect(activePriorityAccessExhaustion("opus", new Date("2026-09-16T23:59:00Z"))).toBe(e);
    expect(activePriorityAccessExhaustion("opus", new Date("2026-09-17T00:00:01Z"))).toBeNull();
  });

  it("keeps the later reset when the weekly wall follows the daily one", () => {
    const day = parsePriorityAccessExhaustion(DAILY, WED)!;
    const week = parsePriorityAccessExhaustion(WEEKLY, WED)!;
    notePriorityAccessExhausted("opus", week, WED);
    notePriorityAccessExhausted("opus", day, WED);
    expect(activePriorityAccessExhaustion("opus", new Date("2026-09-18T00:00:00Z"))?.window).toBe("week");
  });

  it("keeps each budget's wall to itself — Opus running out says nothing about Sonnet 5.5", () => {
    const e = parsePriorityAccessExhaustion(DAILY, WED)!;
    notePriorityAccessExhausted("opus", e, WED);
    expect(activePriorityAccessExhaustion("sonnet-5.5", WED)).toBeNull();
    expect(activePriorityAccessExhaustion("gpt-6-sol", WED)).toBeNull();
    notePriorityAccessExhausted("gpt-6-sol", e, WED);
    expect(activePriorityAccessExhaustion("gpt-6-sol", WED)).toBe(e);
  });
});
