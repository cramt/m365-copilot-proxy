import { afterEach, describe, expect, it } from "vitest";
import { isModelNotLicensed, noteModelNotLicensed, resetModelLicenceState } from "./model-licence.js";
import { priorityAccessExhaustionOf } from "./priority-access.js";
import { reasoningWallKey } from "./copilot.js";

afterEach(resetModelLicenceState);

describe("model licence memory", () => {
  it("remembers a refused model and expires it", () => {
    noteModelNotLicensed("claude-sonnet", 1000);
    expect(isModelNotLicensed("claude-sonnet", 1001)).toBe(true);
    expect(isModelNotLicensed("gpt-5.5", 1001)).toBe(false);
    expect(isModelNotLicensed("claude-sonnet", 1000 + 60 * 60_000)).toBe(false);
  });
  it("is one entry per route, so aliases of the same entitlement agree", () => {
    noteModelNotLicensed("gpt-5.5-quick", 1000);
    expect(isModelNotLicensed("gpt-5.5", 1001)).toBe(true);
    expect(isModelNotLicensed("gpt-5.5-think-deeper", 1001)).toBe(false);
    expect(isModelNotLicensed("gpt-5.6", 1001)).toBe(false);
  });
  it("ignores oversized model strings", () => {
    noteModelNotLicensed("x".repeat(257), 1);
    expect(isModelNotLicensed("x".repeat(257), 2)).toBe(false);
  });
});

describe("reasoning-turn cap", () => {
  it("keys both Think deeper models, and only them, on one wall", () => {
    expect(reasoningWallKey("gpt-5.5-think-deeper")).toBe(reasoningWallKey("gpt-5.6-think-deeper"));
    expect(reasoningWallKey("gpt-5.5-think-deeper")).not.toBeNull();
    expect(reasoningWallKey("gpt-5.5")).toBeNull();
    expect(reasoningWallKey("gpt-5.6")).toBeNull();
    expect(reasoningWallKey("claude-opus")).toBeNull();
  });
  it("classifies by errorCode, not text, and keeps the day window", () => {
    const now = new Date("2026-11-07T10:00:00Z");
    const hit = priorityAccessExhaustionOf({ value: "OutOfCredits", errorCode: "ReasoningTurnExhausted", message: "x" }, "", now);
    expect(hit?.kind).toBe("reasoning-turns");
    expect(hit?.window).toBe("day");
    expect(hit?.resetsAt.toISOString()).toBe("2026-11-08T00:00:00.000Z");
    expect(priorityAccessExhaustionOf({ value: "OutOfCredits", errorCode: "Other", message: "x" }, "", now)?.kind).toBeUndefined();
  });
});
