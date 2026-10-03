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
  defaultFramingForModel,
  transcriptStyleForVariant,
  FRAMING_VARIANT_NAMES,
  sandboxDescription,
} from "./fenced.js";
import type { ToolDef } from "./tools.js";

const bash: ToolDef = {
  type: "function",
  function: {
    name: "bash",
    description: "Run a shell command.",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
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

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(json: string): Record<string, unknown> {
  const value: unknown = JSON.parse(json);
  if (!isJsonObject(value)) {
    throw new TypeError("Expected tool arguments to be a JSON object");
  }
  return value;
}

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
    const out = renderFencedCall(deriveFencedSpec(writeFile), {
      path: "a.py",
      content: "print(1)",
    });
    expect(out).toBe("```write_file\npath: a.py\n\nprint(1)\n```");
  });

  it("renders an edit as SEARCH/REPLACE", () => {
    const out = renderFencedCall(deriveFencedSpec(editFile), { path: "a.py", old: "x", new: "y" });
    expect(out).toBe(
      "```edit_file\npath: a.py\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n```",
    );
  });
});

describe("parseFencedToolCalls", () => {
  function argsOf(text: string, n = 0) {
    const { calls } = parseFencedToolCalls(text, specs);
    const call = calls[n];
    if (!call) throw new Error(`Expected tool call at index ${n}`);
    return { calls, args: parseJsonObject(call.function.arguments) };
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
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  };

  it("detects a shell tool under various names", () => {
    expect(findShellTool([bash])?.function.name).toBe("bash");
    expect(findShellTool([runCommand])?.function.name).toBe("run_command");
    expect(findShellTool([readFile, writeFile])).toBeUndefined();
  });

  it("routes shell fences to VS Code's multi-parameter run_in_terminal tool", () => {
    const terminal: ToolDef = {
      type: "function",
      function: {
        name: "run_in_terminal",
        parameters: {
          properties: {
            command: { type: "string" },
            explanation: { type: "string" },
            isBackground: { type: "boolean" },
          },
        },
      },
    };
    expect(findShellTool([readFile, terminal])).toBe(terminal);
    const calls = parseFencedToolCalls("```bash\nls -la\n```", buildSpecMap([terminal])).calls;
    expect(calls[0].function.name).toBe("run_in_terminal");
    expect(parseJsonObject(calls[0].function.arguments)).toEqual({ command: "ls -la" });
  });

  it("routes a ```bash block to a differently-named shell tool", () => {
    const specs = buildSpecMap([runCommand, readFile]);
    const { calls } = parseFencedToolCalls("```bash\nsed -i 's/a/b/' f.py\n```", specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("run_command");
    expect(parseJsonObject(calls[0].function.arguments)).toEqual({
      command: "sed -i 's/a/b/' f.py",
    });
  });

  it("routes ```sh and ```shell aliases too", () => {
    const specs = buildSpecMap([runCommand]);
    expect(parseFencedToolCalls("```sh\nls\n```", specs).calls[0]?.function.name).toBe(
      "run_command",
    );
    expect(parseFencedToolCalls("```shell\nls\n```", specs).calls[0]?.function.name).toBe(
      "run_command",
    );
  });

  it("routes leaked container.* runtime aliases to the harness shell tool", () => {
    const specs = buildSpecMap([runCommand]);
    const { calls } = parseFencedToolCalls("```container.exec\nls -la\n```", specs);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe("run_command");
    expect(parseJsonObject(calls[0].function.arguments)).toEqual({ command: "ls -la" });
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
    expect(formatFencedToolDefinitions([readFile, writeFile])).not.toContain(
      "WRITING A SHELL SCRIPT",
    );
  });

  // #7: these were silently demoted to prose, so a model correctly told to use
  // PowerShell produced turns that executed nothing.
  it("routes Windows shell fences to the harness shell tool", () => {
    const specs = buildSpecMap([runCommand]);
    for (const lang of ["powershell", "pwsh", "ps1", "cmd", "bat", "batch"]) {
      const { calls } = parseFencedToolCalls(`\`\`\`${lang}\nGet-ChildItem\n\`\`\``, specs);
      expect(calls, `${lang} should route`).toHaveLength(1);
      expect(calls[0].function.name).toBe("run_command");
      expect(parseJsonObject(calls[0].function.arguments)).toEqual({ command: "Get-ChildItem" });
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
        parameters: {
          type: "object",
          properties: { command: { type: "string" } },
          required: ["command"],
        },
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
  it("uses provisional relay for agent-less GPT while preserving agent-backed defaults", () => {
    for (const tone of ["magic", "Gpt_5_5_Chat", "Gpt_5_5_Reasoning"]) {
      expect(defaultFramingForTone(tone, { agentLess: true })).toBe("relay");
      expect(defaultFramingForTone(tone, { agentLess: false })).toBeUndefined();
    }
    expect(defaultFramingForTone("Claude_Opus", { agentLess: true })).toBe("minimal");
    expect(defaultFramingForTone("Claude_Sonnet_Reasoning", { agentLess: true })).toBeUndefined();
    expect(defaultFramingForModel("gpt-5.5-think-deeper", { agentLess: true })).toBe("relay");
  });

  it("gives Opus the lean framing (it doesn't need the anti-narration cage, and its budget is small)", () => {
    expect(defaultFramingForTone("Claude_Opus")).toBe("minimal");
  });

  it("leaves every other tone on the bench-tuned baseline", () => {
    for (const tone of ["magic", "Claude_Sonnet_Reasoning", "Gpt_5_5_Reasoning", undefined]) {
      expect(defaultFramingForTone(tone)).toBeUndefined();
    }
  });

  it("gives the Claude_Sonnet tone (4.6 and 5) the <system>-free relay framing", () => {
    // Both Sonnets read the <system>-tagged baseline as an injected prompt (§21).
    expect(defaultFramingForTone("Claude_Sonnet")).toBe("relay");
  });

  it("gives GPT-6 relay — it runs agent-less, next to M365's code interpreter (#41)", () => {
    // Not because it is paid-gated (Opus is gated too and gets `minimal`): GPT-6
    // never served with the tool agent, and agent-less under baseline it worked
    // in the code interpreter instead of acting — 0/30 vs relay 30/30 (docs §22 F47).
    expect(defaultFramingForTone("Gpt_6_Reasoning")).toBe("relay");
    expect(defaultFramingForModel("gpt-6-think-deeper")).toBe("relay");
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

describe("defaultFramingForModel", () => {
  // `Claude_Sonnet` is Sonnet 4.6 on the included scenario and Sonnet 5 on the
  // paid one, so the tone alone can't choose Sonnet 5's framing.
  it("gives Sonnet 5 the relay framing, including unmapped Sonnet 5 strings", () => {
    for (const id of ["claude-sonnet-5", "claude-sonnet-5[1m]"]) {
      expect(defaultFramingForModel(id)).toBe("relay");
    }
  });

  it("gives Sonnet 4.6 relay too — and every unmapped claude-* string that lands on its tone", () => {
    for (const id of [
      "claude-sonnet",
      "claude-sonnet-4.6",
      "claude-sonnet-4.5",
      "claude",
      "claude-haiku-9",
    ]) {
      expect(defaultFramingForModel(id)).toBe("relay");
    }
  });

  it("falls through to the tone default for everything else", () => {
    expect(defaultFramingForModel("claude-opus")).toBe("minimal");
    expect(defaultFramingForModel("claude-sonnet-think-deeper")).toBeUndefined(); // unmeasured: stays baseline
    expect(defaultFramingForModel("m365-copilot")).toBeUndefined();
    expect(defaultFramingForModel("gpt-5.5-think-deeper")).toBeUndefined();
  });
});

describe("transcriptStyleForVariant", () => {
  it("keeps the historical <system> tags for every pre-existing variant", () => {
    for (const v of [
      "baseline",
      "minimal",
      "softened",
      "recency",
      "fewshot",
      "session_facts",
      "nonexistent",
    ]) {
      expect(transcriptStyleForVariant(v)).toEqual({ framingTag: "system", systemTag: "system" });
    }
  });

  it("drops the framing wrapper for user-voice variants and relabels harness prompts", () => {
    for (const v of ["relay", "honest", "terse_user", "dual_env", "dual_env_protocol"]) {
      expect(transcriptStyleForVariant(v)).toEqual({
        framingTag: null,
        systemTag: "harness_system_prompt",
      });
    }
  });

  it("isolates the system wrapper in dual_env_sys", () => {
    expect(transcriptStyleForVariant("dual_env_sys")).toEqual({
      framingTag: "system",
      systemTag: "system",
    });
    expect(formatFencedToolDefinitions(ALL, "dual_env_sys", { tone: "Gpt_5_5_Reasoning" })).toBe(
      formatFencedToolDefinitions(ALL, "dual_env", { tone: "Gpt_5_5_Reasoning" }),
    );
  });
});

describe("tone-aware sandbox framing", () => {
  it("registers every dual-environment candidate", () => {
    expect(FRAMING_VARIANT_NAMES).toEqual(
      expect.arrayContaining(["dual_env", "dual_env_sys", "dual_env_protocol"]),
    );
  });

  it.each(["relay", "honest", "dual_env", "dual_env_sys", "dual_env_protocol"])(
    "describes GPT's sandbox in %s",
    (variant: string | undefined) => {
      const prompt = formatFencedToolDefinitions(ALL, variant, { tone: "Gpt_5_5_Reasoning" });
      expect(prompt).toContain("Python code interpreter");
      expect(prompt).toContain("/mnt/data");
      expect(prompt).toContain("web search");
      expect(prompt).not.toContain("bash_tool");
      expect(prompt).not.toContain("/home/claude");
    },
  );

  it.each(["relay", "honest", "dual_env", "dual_env_sys", "dual_env_protocol"])(
    "describes Claude's sandbox in %s",
    (variant: string | undefined) => {
      const prompt = formatFencedToolDefinitions(ALL, variant, { tone: "Claude_Sonnet_Reasoning" });
      expect(prompt).toContain("bash_tool");
      expect(prompt).toContain("/home/claude");
      expect(prompt).not.toContain("Python code interpreter");
    },
  );

  it.each(["dual_env", "dual_env_sys", "dual_env_protocol"])(
    "allows scratch work but keeps project work local in %s",
    (variant: string | undefined) => {
      const prompt = formatFencedToolDefinitions(ALL, variant, { tone: "Gpt_5_5_Reasoning" });
      expect(prompt).toMatch(/scratch/i);
      expect(prompt).toContain("B");
      expect(prompt).toContain("<tool_response");
      expect(prompt).toContain("```bash");
    },
  );

  it("defaults sandbox-only callers to the existing Claude description", () => {
    expect(sandboxDescription()).toContain("/home/claude");
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
    const r = parseFencedToolCalls(`\`\`\`read_file\n${inner}\n\`\`\``, specs);
    return parseJsonObject(r.calls[0].function.arguments);
  };

  it("coerces well-formed values to their declared types", () => {
    expect(
      parse('path: /tmp/a.txt\noffset: 10\nratio: 0.5\nrecursive: true\nglobs: ["*.ts"]'),
    ).toEqual({
      path: "/tmp/a.txt",
      offset: 10,
      ratio: 0.5,
      recursive: true,
      globs: ["*.ts"],
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
