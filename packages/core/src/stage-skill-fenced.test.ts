import { describe, it, expect } from "vitest";
import { parseToolCalls } from "./tools.js";
import type { ToolDef } from "./tools.js";

const stageSkill = (name = "stage_skill"): ToolDef => ({
  type: "function",
  function: {
    name,
    parameters: {
      type: "object",
      required: ["action", "name", "reason", "evidence"],
      properties: {
        action: { type: "string", enum: ["create", "update", "patch", "remove_file", "delete"] },
        name: { type: "string" }, level: { type: "string", enum: ["global", "project"] },
        body: { type: "string" }, old_string: { type: "string" }, new_string: { type: "string" },
        reason: { type: "string" }, evidence: { type: "string" },
        files: { type: "object", additionalProperties: { type: "string" } },
        path: { type: "string" }, absorbed_into: { type: "string" },
      },
    },
  },
});
const fence = (tool: string, inner: string) => "```" + tool + "\n" + inner + "\n```";

describe("optional edit pair (stage_skill)", () => {
  it("parses a headers-only create call, including a long tool name", () => {
    for (const name of ["stage_skill", "mcp__plugin_autoharness_stage_skill__stage_skill"]) {
      const r = parseToolCalls(fence(name, "action: create\nname: demo-skill\nlevel: project\nbody: Do X.\nreason: test\nevidence: test"), [stageSkill(name)]);
      expect(r.hasToolCalls).toBe(true);
      expect(r.toolCalls[0].function.name).toBe(name);
      expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ action: "create", name: "demo-skill", level: "project", body: "Do X.", reason: "test", evidence: "test" });
    }
  });
  it("keeps a multi-line body whole and still reads later headers", () => {
    const r = parseToolCalls(fence("stage_skill", "action: create\nname: s\nbody: # Title\n\nstep one\nstep two\nreason: r\nevidence: e"), [stageSkill()]);
    expect(JSON.parse(r.toolCalls[0].function.arguments)).toEqual({ action: "create", name: "s", body: "# Title\n\nstep one\nstep two", reason: "r", evidence: "e" });
  });
  it("still reads the SEARCH/REPLACE form for a patch", () => {
    const r = parseToolCalls(fence("stage_skill", "action: patch\nname: s\nreason: r\nevidence: e\n\n<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE"), [stageSkill()]);
    expect(JSON.parse(r.toolCalls[0].function.arguments)).toMatchObject({ action: "patch", old_string: "old", new_string: "new" });
  });
  it("does not turn a bash fence into a call when there is no shell tool", () => {
    const r = parseToolCalls("```bash\nls\n```", [stageSkill()]);
    expect(r.hasToolCalls).toBe(false);
    expect(r.textContent).toContain("ls");
  });
  it("leaves a stage_skill fence with an unknown enum value as text-or-checked by the caller, never inventing arguments", () => {
    const r = parseToolCalls(fence("stage_skill", "action: create\nname: s"), [stageSkill()]);
    if (r.hasToolCalls) expect(Object.keys(JSON.parse(r.toolCalls[0].function.arguments)).sort()).toEqual(["action", "name"]);
  });
});
