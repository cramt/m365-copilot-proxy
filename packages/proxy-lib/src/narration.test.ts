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

  const tools = [{ type: "function" as const, function: { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }];

  it("drops M365's citation links, and falls back to the comments when that was all", () => {
    expect(toolTurnNarration("Your forms differ, so let's find the records. [1](https://contoso-my.sharepoint.com/personal/u/Documents/a.pdf)\n\n```bash\nls\n```", tools))
      .toBe("Your forms differ, so let's find the records.");
    expect(toolTurnNarration("[1](https://contoso-my.sharepoint.com/a.pdf)\n```bash\n# List the records\nls\n```", tools)).toBe("List the records");
  });

  it("takes the lead-in to the tool block, not to an example block ahead of it", () => {
    expect(toolTurnNarration("It prints a table like this:\n```text\nName Size\n```\nChecking the folder now.\n```bash\nls\n```", tools))
      .toBe("Checking the folder now.");
    expect(toolTurnNarration("```python\n# an example only\nprint(1)\n```\n```bash\n# List the files\nls\n```", tools)).toBe("List the files");
  });

  it("reads the prose from the reply that answered the user when a re-ask produced the call", () => {
    const again = "Resending it as asked.\n\n```bash\n# List everything\nls -la\n```";
    expect(toolTurnNarration(again, tools, "I'll list the files first.\n\n```bash\nls -la\n```")).toBe("I'll list the files first.");
    expect(toolTurnNarration(again, tools, "```bash\nls -la\n```")).toBe("List everything");
  });

  it("drops text that tells the user to run the block themselves — the harness runs it (§64 F183)", () => {
    const block = "\n\n```bash\nls\n```";
    for (const said of [
      "`npm test` never started because the runner couldn't open the project folder; run this in your own PowerShell window to check access.",
      "The runner couldn't open its starting folder, so nothing ran; open **Windows PowerShell** from the Start menu and paste this read-only check there.",
      "Run this to list the files in the current directory and show which is largest.",
      "The runner couldn't open the project folder, so open PowerShell in a project checkout you can access.",
      "I'll need you to open PowerShell in an accessible copy of the project and run this block.",
    ]) expect(toolTurnNarration(said + block, tools)).toBeNull();
    expect(toolTurnNarration("Open PowerShell in the project folder first.\n```bash\n# Check access to the project\nls\n```", tools)).toBe("Check access to the project");
    for (const said of [
      "I'll fix the parser, then run the tests.",
      "I'll check whether your own PowerShell session can open the project before diagnosing `npm test`.",
      "Your two configs differ; this opens the local record so you can check whose entry it is.",
    ]) expect(toolTurnNarration(said + block, tools)).toBe(said);
  });
});
