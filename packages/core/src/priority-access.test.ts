import { describe, it, expect } from "vitest";
import {
  couldBePriorityAccessPrefix,
  parsePriorityAccessExhaustion,
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
