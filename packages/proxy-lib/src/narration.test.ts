import { describe, expect, it } from "vitest";
import { toolTurnNarration } from "./narration.js";

describe("toolTurnNarration", () => {
  it("takes the text before the first tool block", () => {
    expect(toolTurnNarration("I'll list the files first.\n\n```bash\nls\n```")).toBe("I'll list the files first.");
  });

  it("else takes the comment lines that open the block, not a shebang or later comments", () => {
    expect(toolTurnNarration("```powershell\n# Read-only first pass: map each form\n# to its pages.\nGet-ChildItem\n# later\n```"))
      .toBe("Read-only first pass: map each form to its pages.");
    expect(toolTurnNarration("```bash\n#!/bin/sh\nls\n```")).toBeNull();
  });

  it("has none for a bare command, or text only after the block, which was written before the call ran", () => {
    expect(toolTurnNarration("```bash\nls\n```\n\nThe files are a.txt and b.txt.")).toBeNull();
    expect(toolTurnNarration("No tool call here.")).toBeNull();
  });

  it("cuts a long one at a word", () => {
    const narration = toolTurnNarration(`${"word ".repeat(400)}\n\`\`\`bash\nls\n\`\`\``)!;
    expect(narration.length).toBeLessThanOrEqual(801);
    expect(narration.endsWith("word…")).toBe(true);
  });
});
