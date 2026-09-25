import { describe, expect, it, afterEach } from "vitest";
import { getAvailableModels, getScenarioForTone, getToneForModel } from "./copilot.js";

describe("GPT-5.6 model routing", () => {
  it("maps the advertised model ID to the live-validated reasoning tone", () => {
    expect(getToneForModel("gpt-5.6-think-deeper")).toBe("Gpt_5_6_Reasoning");
    expect(getAvailableModels()).toContain("gpt-5.6-think-deeper");
  });

  it("maps both chat IDs to Gpt_5_6_Chat, mirroring the GPT-5.5 naming", () => {
    // The web client calls this one "GPT 5.6 Quick response", so `-quick` is
    // the alias a user reaches for; bare `gpt-5.6` follows `gpt-5.5`.
    expect(getToneForModel("gpt-5.6")).toBe("Gpt_5_6_Chat");
    expect(getToneForModel("gpt-5.6-quick")).toBe("Gpt_5_6_Chat");
    expect(getAvailableModels()).toContain("gpt-5.6");
    expect(getAvailableModels()).toContain("gpt-5.6-quick");
  });

  it("requests NO paid scenario for the chat tone — it serves on the included one", () => {
    // It was entitlement-gated (BotConnection on included, DeepLeo on paid),
    // which §12.15 misread as a dead route. The gate has since lifted, so
    // asking for the paid scenario here would be a bypass attempt, not a fix.
    expect(getScenarioForTone("Gpt_5_6_Chat")).toEqual({
      scenario: "OfficeWebIncludedCopilot",
      licenseType: "Starter",
    });
  });
});

describe("GPT-6 routing", () => {
  it("maps the advertised model ID to the reasoning tone", () => {
    expect(getToneForModel("gpt-6-think-deeper")).toBe("Gpt_6_Reasoning");
    expect(getAvailableModels()).toContain("gpt-6-think-deeper");
  });

  it("advertises no chat variant — Gpt_6_Chat is rejected by the validator", () => {
    // A rejected tone must never be reachable: it errors the whole turn rather
    // than degrading to prose, so shipping an ID that resolves to it would be a
    // model that can only ever fail.
    const advertisedTones = getAvailableModels().map(getToneForModel);
    expect(advertisedTones).not.toContain("Gpt_6_Chat");
  });
});

describe("Opus routing", () => {
  it("maps the advertised Opus IDs to the Claude_Opus tone", () => {
    expect(getToneForModel("claude-opus")).toBe("Claude_Opus");
    expect(getToneForModel("claude-opus-5")).toBe("Claude_Opus");
    expect(getAvailableModels()).toContain("claude-opus");
  });

  it("routes an unmapped Opus string to Opus rather than downgrading to Sonnet", () => {
    // What a Claude Code client actually sends: Opus 5 with a context suffix.
    expect(getToneForModel("claude-opus-5[1m]")).toBe("Claude_Opus");
  });

  it("still routes other unmapped claude-* strings to Sonnet", () => {
    expect(getToneForModel("claude-haiku-9")).toBe("Claude_Sonnet");
  });
});

describe("getScenarioForTone", () => {
  afterEach(() => {
    delete process.env.M365_SCENARIO;
    delete process.env.M365_LICENSE_TYPE;
  });

  it("requests the paid scenario for Opus — the only thing that makes it serve", () => {
    expect(getScenarioForTone("Claude_Opus")).toEqual({
      scenario: "OfficeWebPaidCopilot",
      licenseType: "Premium",
    });
  });

  it("requests the paid scenario for GPT-6 too", () => {
    expect(getScenarioForTone("Gpt_6_Reasoning")).toEqual({
      scenario: "OfficeWebPaidCopilot",
      licenseType: "Premium",
    });
  });

  it("leaves every other tone on the included scenario", () => {
    for (const tone of ["magic", "Claude_Sonnet", "Gpt_5_5_Reasoning", "Gpt_5_6_Reasoning", "Gpt_5_6_Chat"]) {
      expect(getScenarioForTone(tone)).toEqual({
        scenario: "OfficeWebIncludedCopilot",
        licenseType: "Starter",
      });
    }
  });

  it("lets env overrides win, independently", () => {
    process.env.M365_SCENARIO = "SomeOtherScenario";
    expect(getScenarioForTone("Claude_Opus").scenario).toBe("SomeOtherScenario");
    expect(getScenarioForTone("Claude_Opus").licenseType).toBe("Premium");

    delete process.env.M365_SCENARIO;
    process.env.M365_LICENSE_TYPE = "Enterprise";
    expect(getScenarioForTone("magic")).toEqual({
      scenario: "OfficeWebIncludedCopilot",
      licenseType: "Enterprise",
    });
  });
});
