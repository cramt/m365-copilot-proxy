import { describe, expect, it } from "vitest";
import { getAvailableModels, getToneForModel } from "./copilot.js";

describe("GPT-5.6 model routing", () => {
  it("maps the advertised model ID to the live-validated reasoning tone", () => {
    expect(getToneForModel("gpt-5.6-think-deeper")).toBe("Gpt_5_6_Reasoning");
    expect(getAvailableModels()).toContain("gpt-5.6-think-deeper");
  });
});
