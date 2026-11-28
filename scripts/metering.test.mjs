// metering.mjs's offline parts: reading the metering map, the two lines above the table, the budget
// table, the list of the other keys and what stderr says about a failed turn. No M365 turns.
import { describe, expect, it } from "vitest";
import { METERED_BUDGETS } from "../packages/core/dist/index.mjs";
import {
  allowanceOf, budgetRows, failureOf, formatBudgetTable, formatHeader, formatOtherKeys, otherKeys, readMetering,
} from "./metering.mjs";

// The budgets as METERED_BUDGETS lists them on 2026-11-27, so that a budget added there later doesn't
// change these tests.
const BUDGETS = {
  opus: { label: "Opus", usageKey: "opus", daily: "ClaudeOpusQueryDaily", weekly: "ClaudeOpusQuery75" },
  "sonnet-5.5": { label: "Sonnet 5.5", usageKey: "sonnet55", daily: "ClaudeSonnet55QueryDaily", weekly: "ClaudeSonnet55QueryWeekly" },
};

/** A raw `throttling.metering` map with the given allowances left. */
const raw = (allowances) =>
  Object.fromEntries(Object.entries(allowances).map(([key, n]) => [key, { remainingAllowance: n }]));

describe("readMetering", () => {
  it("maps each key to its remainingAllowance, in the order M365 sent them", () => {
    const metering = readMetering(raw({ DeepResearch: 100, ClaudeOpusQuery75: 61, ImageAnalysis: 0 }));
    expect([...metering]).toEqual([["DeepResearch", 100], ["ClaudeOpusQuery75", 61], ["ImageAnalysis", 0]]);
  });

  it("keeps an entry of another shape as JSON instead of dropping it", () => {
    const metering = readMetering({
      WithReset: { remainingAllowance: 3, resetAt: "2026-11-28T00:00:00Z" },
      Text: { remainingAllowance: "3" },
      Empty: {},
      Null: null,
      Bare: 7,
    });
    expect(Object.fromEntries(metering)).toEqual({
      WithReset: '{"remainingAllowance":3,"resetAt":"2026-11-28T00:00:00Z"}',
      Text: '{"remainingAllowance":"3"}',
      Empty: "{}",
      Null: "null",
      Bare: "7",
    });
    expect(allowanceOf({ remainingAllowance: 0 })).toBe(0);
  });

  it("is null when the turn carried no map or an empty one", () => {
    for (const none of [undefined, null, {}, [], "metering", 5]) expect(readMetering(none)).toBeNull();
  });
});

describe("budgetRows and otherKeys", () => {
  const metering = readMetering(raw({
    ImageGeneration: 100,
    ClaudeOpusQuery75: 61,
    ClaudeSonnet55QueryWeekly: 147,
    ClaudeOpusQueryDaily: 40,
    TotalTurnUsageDaily: 49,
    ClaudeOpusQuery: 100,
  }));

  it("gives one row per budget, with undefined for a key the map doesn't have", () => {
    expect(budgetRows(metering, BUDGETS)).toEqual([
      { label: "Opus", dailyKey: "ClaudeOpusQueryDaily", weeklyKey: "ClaudeOpusQuery75", daily: 40, weekly: 61 },
      { label: "Sonnet 5.5", dailyKey: "ClaudeSonnet55QueryDaily", weeklyKey: "ClaudeSonnet55QueryWeekly", daily: undefined, weekly: 147 },
    ]);
  });

  it("reads METERED_BUDGETS by default", () => {
    expect(budgetRows(metering).map((row) => row.label)).toEqual(Object.values(METERED_BUDGETS).map((b) => b.label));
  });

  it("lists every key that no budget reads, sorted by key", () => {
    expect(otherKeys(metering, BUDGETS)).toEqual([
      ["ClaudeOpusQuery", 100],
      ["ImageGeneration", 100],
      ["TotalTurnUsageDaily", 49],
    ]);
  });
});

describe("formatBudgetTable", () => {
  it("prints the budgets with the allowances right-aligned, two spaces between columns", () => {
    const metering = readMetering(raw({
      ClaudeOpusQueryDaily: 40, ClaudeOpusQuery75: 61, ClaudeSonnet55QueryDaily: 80, ClaudeSonnet55QueryWeekly: 147,
    }));
    expect(formatBudgetTable(budgetRows(metering, BUDGETS)).split("\n")).toEqual([
      "Budget      Daily  Weekly  Keys (daily / weekly)",
      "Opus           40      61  ClaudeOpusQueryDaily / ClaudeOpusQuery75",
      "Sonnet 5.5     80     147  ClaudeSonnet55QueryDaily / ClaudeSonnet55QueryWeekly",
    ]);
  });

  it("prints - for a key the map doesn't have, and widens a column for a wider value", () => {
    const metering = readMetering({ ClaudeOpusQueryDaily: { remainingAllowance: 12345678 } });
    expect(formatBudgetTable(budgetRows(metering, BUDGETS)).split("\n")).toEqual([
      "Budget         Daily  Weekly  Keys (daily / weekly)",
      "Opus        12345678       -  ClaudeOpusQueryDaily / ClaudeOpusQuery75",
      "Sonnet 5.5         -       -  ClaudeSonnet55QueryDaily / ClaudeSonnet55QueryWeekly",
    ]);
  });
});

describe("formatHeader", () => {
  const reading = { account: "user@contoso.com", readAt: "2026-11-28T04:11:21.641Z", tone: "Magic", scenario: "OfficeWebPaidCopilot" };

  it("names the account and the time of the reading, then the tone, the scenario and the service version", () => {
    expect(formatHeader({ ...reading, serviceVersion: "1.0.03611.67938" }).split("\n")).toEqual([
      "Chathub metering for user@contoso.com, read 2026-11-28T04:11:21.641Z",
      "from a Magic turn on OfficeWebPaidCopilot (service 1.0.03611.67938)",
    ]);
  });

  it("leaves the service version out when the turn's result names none", () => {
    expect(formatHeader({ ...reading, serviceVersion: null }).split("\n")).toEqual([
      "Chathub metering for user@contoso.com, read 2026-11-28T04:11:21.641Z",
      "from a Magic turn on OfficeWebPaidCopilot",
    ]);
  });
});

describe("formatOtherKeys", () => {
  it("lists each key, indented two spaces, then its value right-aligned four spaces after the widest key", () => {
    const entries = [["ClaudeOpusQuery", 100], ["ClaudeOpusQueryC1", 0], ["FileReference", 999], ["TotalTurnUsageDaily", 49]];
    expect(formatOtherKeys(entries).split("\n")).toEqual([
      "Other keys (no budget in METERED_BUDGETS)",
      "  ClaudeOpusQuery        100",
      "  ClaudeOpusQueryC1        0",
      "  FileReference          999",
      "  TotalTurnUsageDaily     49",
    ]);
  });

  it("widens the value column for a value printed as JSON", () => {
    expect(formatOtherKeys([["A", 5], ["Odd", "{}"]]).split("\n")).toEqual([
      "Other keys (no budget in METERED_BUDGETS)",
      "  A       5",
      "  Odd    {}",
    ]);
  });

  it("says so when there are none", () => {
    expect(formatOtherKeys([]).split("\n")).toEqual(["Other keys (no budget in METERED_BUDGETS)", "  (none)"]);
  });
});

describe("failureOf", () => {
  it("is null for a turn that ended Success, whatever it answered", () => {
    expect(failureOf({ result: { value: "Success" }, fullText: "pong", error: null })).toBeNull();
    expect(failureOf({ result: { value: "Success", serviceVersion: "1.0.03611.67938" }, fullText: "", error: null })).toBeNull();
  });

  it("gives the result's value, error code and message for any other result", () => {
    const result = {
      value: "OutOfCredits",
      errorCode: "TotalTurnDailyQuotaExhausted",
      message: "You've used your daily chat limit.\nPlease try again tomorrow.",
      creditScenario: "TotalTurn",
    };
    expect(failureOf({ result, error: null })).toBe(
      "OutOfCredits, TotalTurnDailyQuotaExhausted: You've used your daily chat limit. Please try again tomorrow.",
    );
    expect(failureOf({ result: { value: "Throttled" }, error: null })).toBe("Throttled");
  });

  it("gives the connection's error, with or without a result", () => {
    expect(failureOf({ result: null, error: "timeout" })).toBe("no result, timeout");
    expect(failureOf({ result: { value: "Success" }, error: "socket hang up" })).toBe("Success, socket hang up");
  });
});
