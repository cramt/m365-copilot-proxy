import { describe, expect, it, afterEach } from "vitest";
import {
  getAvailableModels,
  getScenarioForModel,
  getScenarioForTone,
  getToneForModel,
  isSonnet5Model,
} from "./copilot.js";

const INCLUDED = { scenario: "OfficeWebIncludedCopilot", licenseType: "Starter" };
const PAID = { scenario: "OfficeWebPaidCopilot", licenseType: "Premium" };

describe("Sonnet routing — one tone, two models", () => {
  // `Claude_Sonnet` is Sonnet 4.6 on the included scenario and Sonnet 5 on the
  // paid one (tone-probe 2026-09-28), so the model ID has to pick the scenario.
  afterEach(() => {
    delete process.env.M365_SCENARIO;
  });

  it("sends claude-sonnet-5 to the shared tone under the paid scenario", () => {
    expect(getToneForModel("claude-sonnet-5")).toBe("Claude_Sonnet");
    expect(getScenarioForModel("claude-sonnet-5")).toEqual(PAID);
    expect(getAvailableModels()).toContain("claude-sonnet-5");
  });

  it("keeps every other Sonnet ID on the included scenario (Sonnet 4.6)", () => {
    for (const id of ["claude", "claude-sonnet", "claude-sonnet-4.5", "claude-sonnet-4.6"]) {
      expect(getToneForModel(id)).toBe("Claude_Sonnet");
      expect(getScenarioForModel(id)).toEqual(INCLUDED);
    }
  });

  it("does NOT move the tone itself onto the paid scenario", () => {
    // That would silently turn `claude-sonnet` into Sonnet 5 as well.
    expect(getScenarioForTone("Claude_Sonnet")).toEqual(INCLUDED);
  });

  it("routes unmapped Sonnet 5 strings a client may send to Sonnet 5, not 4.6", () => {
    for (const id of ["claude-sonnet-5[1m]", "claude-sonnet-5-20260115", "Claude-Sonnet-5"]) {
      expect(isSonnet5Model(id)).toBe(true);
      expect(getScenarioForModel(id)).toEqual(PAID);
    }
  });

  it("does not mistake older Sonnet names for Sonnet 5", () => {
    for (const id of ["claude-sonnet-4-5-20250929", "claude-3-5-sonnet", "claude-sonnet-4.5", "claude-sonnet-50"]) {
      expect(isSonnet5Model(id)).toBe(false);
      expect(getScenarioForModel(id)).toEqual(INCLUDED);
    }
  });

  it("never treats a non-Sonnet tone as Sonnet 5, whatever the string says", () => {
    expect(isSonnet5Model("claude-opus-5")).toBe(false);
    expect(isSonnet5Model("gpt-sonnet-5")).toBe(false); // resolves to magic, not Claude_Sonnet
  });

  it("still derives the paid scenario from the tone for Opus and GPT-6", () => {
    expect(getScenarioForModel("claude-opus")).toEqual(PAID);
    expect(getScenarioForModel("claude-opus-5[1m]")).toEqual(PAID);
    expect(getScenarioForModel("gpt-6-think-deeper")).toEqual(PAID);
    expect(getScenarioForModel("gpt-5.5-think-deeper")).toEqual(INCLUDED);
  });

  it("lets the env override win for model routing too", () => {
    process.env.M365_SCENARIO = "SomeOtherScenario";
    expect(getScenarioForModel("claude-sonnet").scenario).toBe("SomeOtherScenario");
    expect(getScenarioForModel("claude-sonnet-5").scenario).toBe("SomeOtherScenario");
  });
});

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

// Tones the live validator REJECTS — every one errored `Failed to invoke 'Chat'`
// in all 3 runs of the 2026-09-28 tone-probe sweep (docs/hypotheses.md §19).
const REJECTED_TONES = [
  "Gpt_Quick", "Gpt_Chat", "Gpt_Reasoning",
  "Gpt_5_2_Quick", "Gpt_5_3_Quick", "Gpt_5_4_Quick",
  "Gpt_6_Chat",
];

describe("retired Quick tones", () => {
  it("never resolves an advertised model to a tone the validator rejects", () => {
    // A rejected tone errors the whole turn, so an ID that resolves to one is a
    // model that can only ever fail.
    const advertisedTones = getAvailableModels().map(getToneForModel);
    for (const tone of REJECTED_TONES) expect(advertisedTones).not.toContain(tone);
  });

  it("maps nothing to a *_Quick tone — the *_Chat tones replaced them", () => {
    for (const id of getAvailableModels()) expect(getToneForModel(id)).not.toMatch(/_Quick$/);
  });

  it("re-points each versioned Quick ID at the same generation's Chat tone", () => {
    expect(getToneForModel("gpt-5.4-quick")).toBe("Gpt_5_4_Chat");
    expect(getToneForModel("gpt-5.3")).toBe("Gpt_5_3_Chat");
    expect(getToneForModel("gpt-5.3-quick")).toBe("Gpt_5_3_Chat");
    expect(getToneForModel("gpt-5.2")).toBe("Gpt_5_2_Chat");
    expect(getToneForModel("gpt-5.2-quick")).toBe("Gpt_5_2_Chat");
    // Bare gpt-5.4 was never a Quick tone and stays on reasoning.
    expect(getToneForModel("gpt-5.4")).toBe("Gpt_5_4_Reasoning");
  });

  it("pins the generic aliases to GPT-5.5, since no unversioned tone survives", () => {
    expect(getToneForModel("quick")).toBe("Gpt_5_5_Chat");
    expect(getToneForModel("think-deeper")).toBe("Gpt_5_5_Reasoning");
  });

  it("keeps advertising every legacy ID, so existing client configs keep working", () => {
    for (const id of ["quick", "think-deeper", "gpt-5.4-quick", "gpt-5.3", "gpt-5.3-quick", "gpt-5.2", "gpt-5.2-quick"]) {
      expect(getAvailableModels()).toContain(id);
    }
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
