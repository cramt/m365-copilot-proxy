import { describe, expect, it } from "vitest";
import { deriveFencedSpec, renderFencedCall, formatFencedToolDefinitions } from "./fenced.js";
import { parseToolCalls, type ToolDef } from "./tools.js";

function definition(required?: string[]): ToolDef {
  return { type: "function", function: { name: "edit_or_create", parameters: {
    type: "object", ...(required === undefined ? {} : { required }), properties: {
      action: { type: "string" }, path: { type: "string" },
      old_string: { type: "string" }, new_string: { type: "string" },
    },
  } } };
}
const fenced = (inner: string) => `\`\`\`edit_or_create\n${inner}\n\`\`\``;

describe("optional edit pair admission", () => {
  for (const args of [
    { action: "create", path: "demo.txt" },
    { action: "inspect", path: "demo.txt", old_string: "before" },
    { action: "inspect", path: "demo.txt", new_string: "after" },
  ]) {
    it(`round trips actual optional arguments without manufacturing fields: ${JSON.stringify(args)}`, () => {
      const tool = definition(["action", "path"]);
      const rendered = renderFencedCall(deriveFencedSpec(tool), args);
      const parsed = parseToolCalls(rendered, [tool]);
      expect(parsed.hasToolCalls).toBe(true);
      expect(JSON.parse(parsed.toolCalls[0].function.arguments)).toEqual(args);
    });
  }
  for (const length of [5, 6, 7, 8]) {
    for (const whitespace of ["", " ", "  ", "\t", "\n \t"]) {
      const start = `${"<".repeat(length)}${whitespace}SEARCH`;
      const separator = "=".repeat(length);
      const end = `${">".repeat(length)}${whitespace}REPLACE`;
      const label = `length=${length}, whitespace=${JSON.stringify(whitespace)}`;
      it(`parses complete accepted marker grammar: ${label}`, () => {
        const tool = definition(["action", "path"]);
        const result = parseToolCalls(fenced(`action: patch\npath: demo.txt\n${start}\nold\n${separator}\nnew\n${end}`), [tool]);
        const args = { action: "patch", path: "demo.txt", old_string: "old", new_string: "new" };
        expect(result.hasToolCalls).toBe(true);
        expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual(args);
        const replay = parseToolCalls(renderFencedCall(deriveFencedSpec(tool), args), [tool]);
        expect(JSON.parse(replay.toolCalls[0].function.arguments)).toEqual(args);
      });
      for (const partial of [start, `${start}\nold`, `${start}\nold\n${separator}\nnew`, `${separator}\nnew\n${end}`, end]) {
        it(`rejects incomplete accepted marker grammar: ${label}, ${JSON.stringify(partial)}`, () => {
          const result = parseToolCalls(fenced(`action: patch\npath: demo.txt\n${partial}`), [definition(["action", "path"])]);
          expect(result.hasToolCalls).toBe(false);
          expect(result.toolCalls).toHaveLength(0);
        });
      }
    }
  }
  for (const marker of ["<<<<<SEARCH", "======", ">>>>>>>>\tREPLACE"]) {
    it(`reserves unanchored accepted tokens in header values: ${marker}`, () => {
      const result = parseToolCalls(fenced(`action: create\npath: prefix ${marker} suffix`), [definition(["action", "path"])]);
      expect(result.hasToolCalls).toBe(false);
      expect(result.toolCalls).toHaveLength(0);
    });
  }
  it("preserves legacy mixed marker lengths, unanchored labels, trailing whitespace and CRLF", () => {
    const inner = "action: patch\npath: demo.txt\nprefix <<<<<\tSEARCH \t\r\nold\r\n====== \t\r\nnew\r\n>>>>>>>>  REPLACE suffix";
    const result = parseToolCalls(fenced(inner), [definition(["action", "path"])]);
    expect(result.hasToolCalls).toBe(true);
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({
      action: "patch", path: "demo.txt", old_string: "old", new_string: "new",
    });
  });
  it("reserves a bare separator line rather than executing ambiguous multiline data", () => {
    const tool = definition(["action", "path"]);
    const result = parseToolCalls(fenced("action: create\npath: Heading\n=======\nDescription"), [tool]);
    expect(result.hasToolCalls).toBe(false);
  });
  it("keeps ordinary multiline headers without reserved markers intact", () => {
    const tool = definition(["action", "path"]);
    const args = { action: "create", path: "Heading\nDescription" };
    const result = parseToolCalls(renderFencedCall(deriveFencedSpec(tool), args), [tool]);
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual(args);
  });
  it("documents optional marker omission in the actual tool template", () => {
    expect(formatFencedToolDefinitions([definition(["action", "path"])]))
      .toContain("The SEARCH/REPLACE block is optional");
  });
  for (const required of [undefined, ["old_string"], ["new_string"], ["old_string", "new_string"]]) {
    it(`retains required-pair behavior with required=${JSON.stringify(required)}`, () => {
      const tool = definition(required);
      expect(deriveFencedSpec(tool).editPair?.optional).not.toBe(true);
      expect(parseToolCalls(fenced("action: create\npath: demo.txt"), [tool]).hasToolCalls).toBe(false);
    });
  }
  for (const partial of [
    "<<<<<<< SEARCH\nold",
    "=======\nnew\n>>>>>>> REPLACE",
    "<<<<<<< SEARCH\nold\n=======\nnew",
  ]) {
    it(`does not reinterpret a truncated edit as a headers-only call: ${partial.split("\n")[0]}`, () => {
      const reply = fenced(`action: patch\npath: demo.txt\n${partial}`);
      const result = parseToolCalls(reply, [definition(["action", "path"])]);
      expect(result.hasToolCalls).toBe(false);
      expect(result.toolCalls).toHaveLength(0);
    });
  }
  it("preserves supplied optional pair headers without inventing missing values", () => {
    const result = parseToolCalls(fenced("action: patch\npath: demo.txt\nold_string: before\nnew_string: after"), [definition(["action", "path"])]);
    expect(result.hasToolCalls).toBe(true);
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ action: "patch", path: "demo.txt", old_string: "before", new_string: "after" });
  });
});
