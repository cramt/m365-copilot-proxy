import { describe, it, expect } from "vitest";
import { buildImagePrompt, classifyImageFailure } from "./image.js";

describe("buildImagePrompt", () => {
  it("leaves the prompt untouched when no options are set", () => {
    expect(buildImagePrompt("a red bicycle")).toBe("a red bicycle");
    expect(buildImagePrompt("a red bicycle", { style: "natural" })).toBe("a red bicycle");
  });

  it("appends an orientation directive", () => {
    expect(buildImagePrompt("a cat", { orientation: "portrait" })).toContain("portrait");
    expect(buildImagePrompt("a cat", { orientation: "portrait" }).startsWith("a cat")).toBe(true);
  });

  it("appends a style directive", () => {
    expect(buildImagePrompt("a lighthouse", { style: "icon" })).toContain("app icon");
    expect(buildImagePrompt("a saga", { style: "story" })).toContain("story");
  });

  it("combines style and orientation", () => {
    const out = buildImagePrompt("a fox", { style: "designer", orientation: "square" });
    expect(out).toContain("graphic-design");
    expect(out).toContain("square");
  });

  it("keeps the original prompt as the lead so the subject dominates", () => {
    const out = buildImagePrompt("a specific subject", { orientation: "landscape" });
    expect(out.indexOf("a specific subject")).toBe(0);
  });
});

describe("classifyImageFailure", () => {
  it("flags the daily image cap as quota_exceeded (verbatim from a live exhaustion)", () => {
    // The exact text M365 returned once the account's daily image budget ran out.
    expect(classifyImageFailure(
      "Sorry, I can’t generate any more images today. Try again tomorrow, or ask me to find similar images on the web instead.",
    )).toBe("quota_exceeded");
  });

  it("treats empty text as no_image, not a failure", () => {
    expect(classifyImageFailure("")).toBe("no_image");
    expect(classifyImageFailure("   ")).toBe("no_image");
  });

  it("does not mistake a normal image description for a failure", () => {
    expect(classifyImageFailure("Here is a serene image of a lighthouse at dawn.")).toBe("no_image");
    expect(classifyImageFailure("I created an image of a red bicycle for you.")).toBe("no_image");
  });

  it("classifies transient capacity trouble", () => {
    expect(classifyImageFailure("I'm having trouble creating images right now. Please try again in a bit.")).toBe("capacity");
  });

  it("classifies a content refusal", () => {
    expect(classifyImageFailure("Sorry, I can't create that image because it goes against our content policy.")).toBe("content_filtered");
  });
});
