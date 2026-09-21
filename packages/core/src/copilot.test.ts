import { describe, expect, it, afterEach } from "vitest";
import { getAvailableModels, getScenarioForTone, getToneForModel } from "./copilot.js";

describe("GPT-5.6 model routing", () => {
  it("maps the advertised model ID to the live-validated reasoning tone", () => {
    expect(getToneForModel("gpt-5.6-think-deeper")).toBe("Gpt_5_6_Reasoning");
    expect(getAvailableModels()).toContain("gpt-5.6-think-deeper");
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

  it("leaves every other tone on the included scenario", () => {
    for (const tone of ["magic", "Claude_Sonnet", "Gpt_5_5_Reasoning", "Gpt_5_6_Reasoning"]) {
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
