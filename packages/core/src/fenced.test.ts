import { afterEach, describe, it, expect } from "vitest";
import {
  deriveFencedSpec,
  renderFencedCall,
  parseFencedToolCalls,
  buildSpecMap,
  formatFencedToolDefinitions,
  findShellTool,
  hostPlatformNote,
  currentFramingVariant,
  defaultFramingForTone,
} from "./fenced.js";
import type { ToolDef } from "./tools.js";

const bash: ToolDef = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
};
const readFile: ToolDef = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};
const writeFile: ToolDef = {
  type: "function",
  function: {
    name: "write_file",
    description: "Write a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
};
const editFile: ToolDef = {
  type: "function",
  function: {
    name: "edit_file",
    description: "Replace text.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } },
      required: ["path", "old", "new"],
    },
  },
};

const ALL = [bash, readFile, writeFile, editFile];
const specs = buildSpecMap(ALL);

describe("deriveFencedSpec", () => {
  it("maps a single-param tool's param to the body", () => {
    const s = deriveFencedSpec(readFile);
    expect(s.bodyParam).toBe("path");
    expect(s.headerParams).toEqual([]);
  });

  it("recognizes a named body param and keeps the rest as headers", () => {
    const s = deriveFencedSpec(writeFile);
    expect(s.bodyParam).toBe("content");
    expect(s.headerParams).toEqual(["path"]);
  });

  it("detects an old/new pair as a SEARCH/REPLACE edit", () => {
    const s = deriveFencedSpec(editFile);
    expect(s.editPair).toEqual({ search: "old", replace: "new" });
    expect(s.bodyParam).toBeUndefined();
    expect(s.headerParams).toEqual(["path"]);
  });
});

describe("renderFencedCall", () => {
  it("renders a body-only call with no header", () => {
    const out = renderFencedCall(deriveFencedSpec(bash), { command: "ls -la" });
    expect(out).toBe("```bash\nls -la\n```");
  });

  it("renders header + body separated by a blank line", () => {
    const out = renderFencedCall(deriveFencedSpec(writeFile), { path: "a.py", content: "print(1)" });
    expect(out).toBe("```write_file\npath: a.py\n\nprint(1)\n```");
  });

  it("renders an edit as SEARCH/REPLACE", () => {
    const out = renderFencedCall(deriveFencedSpec(editFile), { path: "a.py", old: "x", new: "y" });
    expect(out).toBe("```edit_file\npath: a.py\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n```");
  });
});

describe("parseFencedToolCalls", () => {
  function argsOf(text: string, n = 0) {
    const { calls } = parseFencedToolCalls(text, specs);
    return { calls, args: calls[n] ? JSON.parse(calls[n].function.arguments) : null };
  }

  it("parses a body-only bash call", () => {
    const { calls, args } = argsOf("```bash\nls -la\n```");
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("bash");
    expect(args).toEqual({ command: "ls -la" });
  });

  it("round-trips a write_file with a multi-line body", () => {
    const content = "def f():\n    return 1\n\nprint(f())";
    const rendered = renderFencedCall(deriveFencedSpec(writeFile), { path: "f.py", content });
    const { args } = argsOf(rendered);
    expect(args).toEqual({ path: "f.py", content });
  });

  it("round-trips an edit_file SEARCH/REPLACE", () => {
    const rendered = renderFencedCall(deriveFencedSpec(editFile), {
      path: "app.py",
      old: "debug = False",
      new: "debug = True",
    });
    const { args } = argsOf(rendered);
    expect(args).toEqual({ path: "app.py", old: "debug = False", new: "debug = True" });
  });

  it("parses a header body even without the blank separator", () => {
    const { args } = argsOf("```write_file\npath: f.py\nprint(1)\n```");
    expect(args).toEqual({ path: "f.py", content: "print(1)" });
  });

  it("ignores an illustration fence whose lang is not a tool", () => {
    const { calls, leftover } = parseFencedToolCalls("```python\nprint('hi')\n```", specs);
    expect(calls).toHaveLength(0);
    expect(leftover).toContain("print('hi')");
  });

  it("strips matched fences from leftover but keeps real prose", () => {
    const { calls, leftover } = parseFencedToolCalls("Here you go:\n```bash\nls\n```", specs);
    expect(calls).toHaveLength(1);
    expect(leftover).toContain("Here you go");
    expect(leftover).not.toContain("ls\n```");
  });

  it("parses multiple fenced calls", () => {
    const { calls } = parseFencedToolCalls("```read_file\na\n```\n```read_file\nb\n```", specs);
    expect(calls).toHaveLength(2);
  });

  it("drops an edit fence missing SEARCH/REPLACE markers", () => {
    const { calls } = parseFencedToolCalls("```edit_file\npath: a.py\njust some text\n```", specs);
    expect(calls).toHaveLength(0);
  });

  it("handles a body that contains colon-prefixed lines (not misread as headers)", () => {
    const content = "note: this is body text\nmore: lines";
    const rendered = renderFencedCall(deriveFencedSpec(writeFile), { path: "n.txt", content });
    const { args } = argsOf(rendered);
    expect(args.content).toBe(content);
  });
});

describe("shell routing (Tier 1)", () => {
  const runCommand: ToolDef = {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  };

  it("detects a shell tool under various names", () => {
    expect(findShellTool([bash])?.function.name).toBe("bash");
    expect(findShellTool([runCommand])?.function.name).toBe("run_command");
    expect(findShellTool([readFile, writeFile])).toBeUndefined();
  });

  it("routes a ```bash block to a differently-named shell tool", () => {
    const specs = buildSpecMap([runCommand, readFile]);
    const { calls } = parseFencedToolCalls("```bash\nsed -i 's/a/b/' f.py\n```", specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("run_command");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: "sed -i 's/a/b/' f.py" });
  });

  it("routes ```sh and ```shell aliases too", () => {
    const specs = buildSpecMap([runCommand]);
    expect(parseFencedToolCalls("```sh\nls\n```", specs).calls[0]?.function.name).toBe("run_command");
    expect(parseFencedToolCalls("```shell\nls\n```", specs).calls[0]?.function.name).toBe("run_command");
  });

  it("routes leaked container.* runtime aliases to the harness shell tool", () => {
    const specs = buildSpecMap([runCommand]);
    const { calls } = parseFencedToolCalls("```container.exec\nls -la\n```", specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("run_command");
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: "ls -la" });
  });

  it("leaves a dotted/hyphenated info-string that is not a tool in prose", () => {
    // Widening the fence regex to allow . and - must not turn language tags into calls.
    const specs = buildSpecMap([runCommand]);
    expect(parseFencedToolCalls("```objective-c\nint x;\n```", specs).calls).toHaveLength(0);
    expect(parseFencedToolCalls("```asp.net\n<%= x %>\n```", specs).calls).toHaveLength(0);
  });

  it("does not hijack ```bash when a real tool is literally named bash", () => {
    // bash tool present → ```bash maps to it directly (not via alias), name stays bash
    const specs = buildSpecMap([bash, readFile]);
    expect(parseFencedToolCalls("```bash\nls\n```", specs).calls[0]?.function.name).toBe("bash");
  });

  it("injects shell-first framing only when a shell tool is present", () => {
    expect(formatFencedToolDefinitions([bash, readFile])).toContain("WRITING A SHELL SCRIPT");
    expect(formatFencedToolDefinitions([readFile, writeFile])).not.toContain("WRITING A SHELL SCRIPT");
  });

  // #7: these were silently demoted to prose, so a model correctly told to use
  // PowerShell produced turns that executed nothing.
  it("routes Windows shell fences to the harness shell tool", () => {
    const specs = buildSpecMap([runCommand]);
    for (const lang of ["powershell", "pwsh", "ps1", "cmd", "bat", "batch"]) {
      const { calls } = parseFencedToolCalls("```" + lang + "\nGet-ChildItem\n```", specs);
      expect(calls, `${lang} should route`).toHaveLength(1);
      expect(calls[0].function.name).toBe("run_command");
      expect(JSON.parse(calls[0].function.arguments)).toEqual({ command: "Get-ChildItem" });
    }
  });
});

describe("hostPlatformNote", () => {
  it("is empty off Windows, so POSIX framing stays byte-for-byte", () => {
    expect(hostPlatformNote(bash, "linux")).toBe("");
    expect(hostPlatformNote(bash, "darwin")).toBe("");
    expect(formatFencedToolDefinitions([bash, readFile])).not.toContain("HOST PLATFORM");
  });

  it("is empty on Windows when the harness gave no shell tool", () => {
    expect(hostPlatformNote(undefined, "win32")).toBe("");
  });

  it("names the platform and overrides every POSIX idiom the framing teaches", () => {
    const note = hostPlatformNote(bash, "win32");
    expect(note).toContain("HOST PLATFORM: Windows");
    expect(note).toContain("```powershell");
    // The specific idioms baseline framing teaches by name must be countermanded.
    for (const posix of ["EOF", "sed -i", "ls", "grep"]) {
      expect(note, `${posix} should be countermanded`).toContain(posix);
    }
    expect(note).toContain("Set-Content");
    expect(note).toContain("Get-ChildItem");
    expect(note).toContain("Select-String");
    // #12: the sandbox the model drifts to when POSIX commands fail.
    expect(note).toContain("/mnt/data");
  });

  it("names the harness's own shell tool rather than assuming `bash`", () => {
    const shell: ToolDef = {
      type: "function",
      function: {
        name: "run_terminal_cmd",
        description: "Run a command.",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    };
    expect(hostPlatformNote(shell, "win32")).toContain("`run_terminal_cmd`");
  });
});

describe("formatFencedToolDefinitions", () => {
  it("lists each tool as a fenced template inside <tools>", () => {
    const out = formatFencedToolDefinitions(ALL);
    expect(out).toContain("<tools>");
    expect(out).toContain("```bash");
    expect(out).toContain("```write_file");
    expect(out).toContain("<<<<<<< SEARCH");
    // Stresses the action-not-illustration contract
    expect(out).toContain("ACTION");
    expect(out).toContain("PRIMARY JOB");
  });
});

describe("defaultFramingForTone", () => {
  it("gives Opus the lean framing (it doesn't need the anti-narration cage, and its budget is small)", () => {
    expect(defaultFramingForTone("Claude_Opus")).toBe("minimal");
  });

  it("leaves every other tone on the bench-tuned baseline", () => {
    for (const tone of ["magic", "Claude_Sonnet", "Gpt_5_5_Reasoning", undefined]) {
      expect(defaultFramingForTone(tone)).toBeUndefined();
    }
  });

  it("keeps the paid-gated GPT-6 tone on baseline — the gate is not a budget", () => {
    // Opus gets `minimal` because its priority-access budget is the scarce
    // thing, not because it is entitlement-gated. Gpt_6_Reasoning is gated the
    // same way and metered like everything else, and it drives M365's GPT path,
    // which is what baseline's anti-narration cage exists for.
    expect(defaultFramingForTone("Gpt_6_Reasoning")).toBeUndefined();
  });

  it("is materially shorter than baseline for the same toolset", () => {
    const lean = formatFencedToolDefinitions([bash, readFile], "minimal");
    const baseline = formatFencedToolDefinitions([bash, readFile], "baseline");
    expect(lean.length).toBeLessThan(baseline.length / 2);
    // …while keeping the two load-bearing levers: shell-routing + anti-confab.
    expect(lean).toContain("```bash");
    expect(lean).toContain("run nothing yet");
  });
});

describe("currentFramingVariant", () => {
  afterEach(() => {
    delete process.env.M365_FRAMING_VARIANT;
  });

  it("falls back to baseline with no tone default", () => {
    expect(currentFramingVariant()).toBe("baseline");
  });

  it("uses the tone default when the env is unset", () => {
    expect(currentFramingVariant("minimal")).toBe("minimal");
  });

  it("lets an explicit env override beat the tone default", () => {
    process.env.M365_FRAMING_VARIANT = "fewshot";
    expect(currentFramingVariant("minimal")).toBe("fewshot");
  });
});

describe("header value coercion (strict-harness schema conformance)", () => {
  // Zed validates tool arguments against the declared schema and rejects a
  // string where the schema said integer/boolean/array.
  const typed: ToolDef = {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer" },
          ratio: { type: "number" },
          recursive: { type: "boolean" },
          globs: { type: "array" },
        },
        required: ["path"],
      },
    },
  };
  const specs = buildSpecMap([typed]);
  const parse = (inner: string) => {
    const r = parseFencedToolCalls("```read_file\n" + inner + "\n```", specs);
    return JSON.parse(r.calls[0].function.arguments);
  };

  it("coerces well-formed values to their declared types", () => {
    expect(parse('path: /tmp/a.txt\noffset: 10\nratio: 0.5\nrecursive: true\nglobs: ["*.ts"]')).toEqual({
      path: "/tmp/a.txt", offset: 10, ratio: 0.5, recursive: true, globs: ["*.ts"],
    });
  });

  it("accepts the casings and synonyms a model actually writes for booleans", () => {
    expect(parse("path: /a\nrecursive: True").recursive).toBe(true);
    expect(parse("path: /a\nrecursive: Yes").recursive).toBe(true);
    expect(parse("path: /a\nrecursive: FALSE").recursive).toBe(false);
    expect(parse("path: /a\nrecursive: no").recursive).toBe(false);
  });

  // The load-bearing cases: tool calling is prompt-emulated, so the model puts
  // prose in typed slots routinely. A value that can't be coerced must stay a
  // string the harness rejects loudly — never become a plausible wrong value.
  it("leaves an unparseable number as a string rather than emitting null", () => {
    // parseInt("the whole file") is NaN, and JSON.stringify(NaN) is `null` —
    // a value the harness would accept and act on.
    expect(parse("path: /a\noffset: the whole file").offset).toBe("the whole file");
    expect(parse("path: /a\noffset: n/a").offset).toBe("n/a");
    expect(parse("path: /a\noffset: 12abc").offset).toBe("12abc"); // parseInt would say 12
  });

  it("leaves a non-integer as a string where the schema demands an integer", () => {
    expect(parse("path: /a\noffset: 1.5").offset).toBe("1.5");
    expect(parse("path: /a\nratio: 1.5").ratio).toBe(1.5); // but `number` accepts it
  });

  it("leaves an unrecognised boolean as a string rather than guessing false", () => {
    expect(parse("path: /a\nrecursive: maybe").recursive).toBe("maybe");
    expect(parse("path: /a\nrecursive: if needed").recursive).toBe("if needed");
  });

  it("never ships a non-array for an array-typed param", () => {
    expect(parse("path: /a\nglobs: 5").globs).toEqual(["5"]); // JSON.parse would give 5
    expect(parse('path: /a\nglobs: {"a":1}').globs).toEqual(['{"a":1}']);
    expect(parse("path: /a\nglobs: *.ts").globs).toEqual(["*.ts"]);
    expect(parse("path: /a\nglobs: ").globs).toEqual([]);
  });

  it("leaves untyped and string params untouched", () => {
    expect(parse("path: 123").path).toBe("123");
  });
});
