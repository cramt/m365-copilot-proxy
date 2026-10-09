import { afterEach, describe, it, expect } from "vitest";
import {
  deriveFencedSpec,
  renderFencedCall,
  parseFencedToolCalls,
  findFirstToolFence,
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

// Opus ends some fenced calls with its native function-call closer (docs §24 F56).
// These are the replies it actually sent on the count-lines task, verbatim.
describe("native call closer leaking into a fence (Opus)", () => {
  const SCRIPT = "#!/bin/bash\nwc -l < data.txt | tr -d ' ' > count.txt";
  function argsOf(text: string) {
    const { calls, leftover } = parseFencedToolCalls(text, specs);
    return { calls, leftover, args: calls[0] ? parseJsonObject(calls[0].function.arguments) : {} };
  }

  it("keeps </invoke> out of the file when the fence is closed too", () => {
    const { args } = argsOf(`\`\`\`write_file\npath: count.sh\n\n${SCRIPT}\n</invoke>\n\`\`\``);
    expect(args).toEqual({ path: "count.sh", content: SCRIPT });
  });

  it("…and with a stray zero-width line before the closing fence", () => {
    const { args } = argsOf(`\`\`\`write_file\npath: count.sh\n\n${SCRIPT}\n</invoke>\n\u200c\n\`\`\``);
    expect(args).toEqual({ path: "count.sh", content: SCRIPT });
  });

  it("accepts a fence that </invoke> ends instead of ```, stray symbol and all", () => {
    const { calls, args, leftover } = argsOf(`\`\`\`write_file\npath: count.sh\n\n${SCRIPT}\n</invoke>\n∂`);
    expect(calls).toHaveLength(1);
    expect(args).toEqual({ path: "count.sh", content: SCRIPT });
    expect(leftover.trim()).toBe("");
  });

  it("accepts a fence that the tool's own closing tag ends", () => {
    const { args } = argsOf(`\`\`\`write_file\npath: count.sh\n\n${SCRIPT}\n</write_file>`);
    expect(args).toEqual({ path: "count.sh", content: SCRIPT });
  });

  it("drops native <parameter> lines after the closer, unclosed fence (opus45-r5c relay)", () => {
    const script = "#!/usr/bin/env bash\nwc -l < data.txt | tr -d ' ' > count.txt";
    const { calls, args } = argsOf(`\`\`\`write_file\npath: count.sh\n\n${script}\n</invoke>\n<parameter name="path">count.sh</parameter>`);
    expect(calls).toHaveLength(1);
    expect(args).toEqual({ path: "count.sh", content: script });
  });

  it("…and inside a closed fence", () => {
    const { args } = argsOf(`\`\`\`write_file\npath: count.sh\n\n${SCRIPT}\n</invoke>\n<parameter name="path">count.sh</parameter>\n</function_calls>\n\`\`\``);
    expect(args).toEqual({ path: "count.sh", content: SCRIPT });
  });

  it("drops </parameter> lines BEFORE the closer too — they'd run as shell (opus45-r5c retag)", () => {
    const command = "cat > count.sh <<'EOF'\n#!/bin/bash\nwc -l < data.txt | tr -d ' \\t' > count.txt\nEOF\nchmod +x count.sh\n./count.sh\ncat -A count.txt";
    const { calls, args } = argsOf(`\`\`\`bash\n${command}\n</parameter>\n</invoke>\n</function_calls>`);
    expect(calls).toHaveLength(1);
    expect(args).toEqual({ command });
  });

  it("drops a bare trailing </parameter> — it was written into count.sh 3 times (round 1, r3)", () => {
    const { args } = argsOf(`\`\`\`write_file\npath: count.sh\n\n${SCRIPT}\n</parameter>\n\`\`\``);
    expect(args).toEqual({ path: "count.sh", content: SCRIPT });
    const bash = argsOf("```bash\nchmod +x count.sh\ncat count.sh\n</parameter>\n```").args;
    expect(bash).toEqual({ command: "chmod +x count.sh\ncat count.sh" });
  });

  it("keeps native-looking markup that real content follows", () => {
    const { args } = argsOf("```write_file\npath: x.xml\n\n<a>\n</parameter>\n<b/>\n```");
    expect(args.content).toBe("<a>\n</parameter>\n<b/>");
  });

  it("keeps a closer that real content follows", () => {
    const content = "<x>\n</invoke>\necho done";
    const { args } = argsOf(`\`\`\`write_file\npath: x.sh\n\n${content}\n\`\`\``);
    expect(args.content).toBe(content);
    expect(argsOf(`\`\`\`write_file\npath: x.sh\n\n${content}`).calls).toHaveLength(0);
  });

  it("keeps prose before an unclosed call as leftover", () => {
    const { calls, leftover } = argsOf("Writing the script now.\n```bash\nls\n</invoke>");
    expect(calls).toHaveLength(1);
    expect(leftover.trim()).toBe("Writing the script now.");
  });

  it("does not accept an unclosed fence with no end marker — it may be truncated", () => {
    expect(argsOf(`\`\`\`write_file\npath: count.sh\n\n${SCRIPT}`).calls).toHaveLength(0);
  });

  it("only strips a closer on the LAST line, never one inside the content", () => {
    const content = "<a>\n</invoke>\n</a>";
    const { args } = argsOf(`\`\`\`write_file\npath: x.xml\n\n${content}\n\`\`\``);
    expect(args.content).toBe(content);
  });

  it("does not take another tool's closing tag as a closer", () => {
    const content = "<p>\n</read_file>";
    const { args } = argsOf(`\`\`\`write_file\npath: x.html\n\n${content}\n\`\`\``);
    expect(args.content).toBe(content);
  });

  it("finds the unclosed call for findFirstToolFence too", () => {
    const text = `\`\`\`bash\nls\n</invoke>`;
    expect(findFirstToolFence(text, specs)).toEqual({ start: 0, end: text.length });
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
    expect(defaultFramingForTone("Claude_Opus", { agentLess: true })).toBe("relay_batch");
    expect(defaultFramingForTone("Claude_Sonnet_Reasoning", { agentLess: true })).toBe("relay");
    expect(defaultFramingForModel("gpt-5.5-think-deeper", { agentLess: true })).toBe("relay");
  });

  it("gives both Opus models relay_batch — no jailbreak trips, and fewest turns (§24 F56, F60)", () => {
    // minimal 12/30 and baseline 8/30 tasks Disengaged, the user-voice relays 0.
    // relay_batch: 2.30 turns per bench task vs relay's 3.65 — and Opus 5.5's
    // budget counts turns (F55). `minimal`'s shorter prompt saved nothing.
    expect(defaultFramingForTone("Claude_Opus")).toBe("relay_batch");
    for (const id of ["claude-opus", "claude-opus-5.5", "claude-opus-4.5", "claude-opus-4-5-20251101", "claude-opus-5[1m]"]) {
      expect(defaultFramingForModel(id)).toBe("relay_batch");
    }
  });

  it("asks for batching in relay_batch, and keeps relay's sandbox note and user voice", () => {
    const out = formatFencedToolDefinitions([bash, readFile], "relay_batch");
    expect(out).toContain("put as much as you can into one block");
    expect(out).not.toContain("one command at a time");
    expect(out).toMatch(/sandbox/);
    expect(transcriptStyleForVariant("relay_batch").framingTag).toBeNull();
  });

  it("asks for batching only when there's a shell to batch in — otherwise it is relay (§25 H25b)", () => {
    // Shell-less, "a script can look at the files…" read as a request only its
    // own sandbox could meet: Sonnet 4.6 3/7 vs relay 6/6.
    expect(formatFencedToolDefinitions([readFile], "relay_batch")).toBe(formatFencedToolDefinitions([readFile], "relay"));
    expect(formatFencedToolDefinitions([bash, readFile], "relay_batch")).not.toBe(formatFencedToolDefinitions([bash, readFile], "relay"));
  });

  it("leaves unrelated tones on the bench-tuned baseline", () => {
    for (const tone of ["magic", "Gpt_5_5_Reasoning", undefined]) {
      expect(defaultFramingForTone(tone)).toBeUndefined();
    }
  });

  it("gives the Claude_Sonnet tone the <system>-free relay_batch (Sonnet 4.6, §25 F62)", () => {
    // Both Sonnets read the <system>-tagged baseline as an injected prompt (§21);
    // batching cut Sonnet 4.6's turns 14% on the bench and 21% in real pi.
    expect(defaultFramingForTone("Claude_Sonnet")).toBe("relay_batch");
  });

  it("gives the Claude_Sonnet_5 tone relay — Sonnet 5's own default (§25 F63)", () => {
    expect(defaultFramingForTone("Claude_Sonnet_5")).toBe("relay");
  });

  it("gives GPT-6 relay_batch — it runs agent-less, next to M365's code interpreter (#41)", () => {
    // Not because it is paid-gated (Opus 5.5 is gated too): GPT-6
    // never served with the tool agent, and agent-less under baseline it worked
    // in the code interpreter instead of acting — 0/30 vs relay 30/30 (docs §22 F47).
    // relay_batch keeps relay's user voice and cuts its turns by a third (§25 F61).
    expect(defaultFramingForTone("Gpt_6_Reasoning")).toBe("relay_batch");
    expect(defaultFramingForModel("gpt-6-think-deeper")).toBe("relay_batch");
  });

  it("gives GPT-6 Sol relay_batch on both of its paths, agent and agent-less (#23, docs §28)", () => {
    // One default for both: agent-less (non-premium) it has its own sandbox and
    // only the user-voice relay kept it out (60/60 vs ≤6/10); with the agent
    // (premium) relay 30/30 vs 3–9/10 for the rest (docs §23). relay_batch keeps
    // that voice, cuts turns by a third, and on the retest didn't send it to the
    // sandbox any more often than relay (§28; F61's 4 vs 2 was noise).
    expect(defaultFramingForTone("Gpt_6_Sol_Reasoning")).toBe("relay_batch");
    expect(defaultFramingForModel("gpt-6-sol")).toBe("relay_batch");
  });

  it("gives GPT-6.1 Sol relay_batch on both of its paths (docs §27, §29)", () => {
    // Only the user-voice framings keep it out of its sandbox agent-less, as with
    // GPT-6 Sol, and relay_batch never sent it there (0 of 80 tasks and pi runs)
    // and saved turns on both paths, bench and real pi alike.
    expect(defaultFramingForTone("Gpt_61_Sol_Reasoning")).toBe("relay_batch");
    expect(defaultFramingForModel("gpt-6.1-sol")).toBe("relay_batch");
  });

  it("keeps the minimal variant materially shorter than baseline (not a default any more, still selectable)", () => {
    const lean = formatFencedToolDefinitions([bash, readFile], "minimal");
    const baseline = formatFencedToolDefinitions([bash, readFile], "baseline");
    expect(lean.length).toBeLessThan(baseline.length / 2);
    // …while keeping the two load-bearing levers: shell-routing + anti-confab.
    expect(lean).toContain("```bash");
    expect(lean).toContain("run nothing yet");
  });
});

describe("defaultFramingForModel", () => {
  // `Claude_Sonnet` is Sonnet 4.6 on the included scenario and Sonnet 5.5 on
  // the paid one, so the tone alone can't choose Sonnet 5.5's framing.
  it("keeps Sonnet 5 on relay, including unmapped Sonnet 5 strings", () => {
    // Batching saved 15% of Sonnet 5's bench turns but only 6% in real pi (§25 F63).
    for (const id of ["claude-sonnet-5", "claude-sonnet-5[1m]"]) {
      expect(defaultFramingForModel(id)).toBe("relay");
    }
  });

  it("gives Sonnet 5.5 relay, not its tone's relay_batch — it has Sonnet 5's sandbox (§26)", () => {
    for (const id of ["claude-sonnet-5.5", "claude-sonnet-5-5-20261001"]) {
      expect(defaultFramingForModel(id)).toBe("relay");
    }
  });

  it("gives Sonnet 4.6 relay_batch — and every unmapped claude-* string that lands on its tone", () => {
    for (const id of ["claude-sonnet", "claude-sonnet-4.6", "claude-sonnet-4.5", "claude", "claude-haiku-9"]) {
      expect(defaultFramingForModel(id)).toBe("relay_batch");
    }
  });

  it("falls through to the tone default for everything else", () => {
    expect(defaultFramingForModel("claude-opus")).toBe("relay_batch");
    expect(defaultFramingForModel("claude-sonnet-think-deeper")).toBe("relay");
    expect(defaultFramingForModel("m365-copilot")).toBeUndefined();
    expect(defaultFramingForModel("gpt-5.5-think-deeper")).toBeUndefined();
  });
});

describe("Sonnet reasoning framing", () => {
  it("uses user-voice relay without a forged system wrapper", () => {
    const framing = defaultFramingForModel("claude-sonnet-think-deeper");
    if (!framing) throw new Error("Expected framing to be defined");
    expect(framing).toBe("relay");
    expect(defaultFramingForTone("Claude_Sonnet_Reasoning")).toBe("relay");
    expect(transcriptStyleForVariant(framing)).toEqual({
      framingTag: null,
      systemTag: "harness_system_prompt",
    });
    const prompt = formatFencedToolDefinitions(ALL, framing, { tone: "Claude_Sonnet_Reasoning" });
    expect(prompt).toContain("one command at a time");
    expect(prompt).toContain("```bash");
    expect(prompt).not.toContain("<system>");
  });

  it("allows an explicit baseline override", () => {
    const previous = process.env.M365_FRAMING_VARIANT;
    try {
      process.env.M365_FRAMING_VARIANT = "baseline";
      expect(currentFramingVariant(defaultFramingForModel("claude-sonnet-think-deeper"))).toBe(
        "baseline",
      );
    } finally {
      if (previous === undefined) delete process.env.M365_FRAMING_VARIANT;
      else process.env.M365_FRAMING_VARIANT = previous;
    }
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

describe("array and object params written as a YAML block (#50)", () => {
  // pi's `edit` tool: the tools block shows it as `edits: <edits>`.
  const piEdit: ToolDef = {
    type: "function",
    function: {
      name: "edit",
      description: "Edit a single file using exact text replacement.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          edits: { type: "array", items: { type: "object", properties: { oldText: { type: "string" }, newText: { type: "string" } } } },
        },
        required: ["path", "edits"],
      },
    },
  };
  const opts: ToolDef = {
    type: "function",
    function: { name: "configure", parameters: { type: "object", properties: { target: { type: "string" }, options: { type: "object" } } } },
  };
  const piSpecs = buildSpecMap([piEdit, opts, bash]);
  const argsOf = (text: string) => {
    const { calls } = parseFencedToolCalls(text, piSpecs);
    expect(calls).toHaveLength(1);
    return parseJsonObject(calls[0].function.arguments);
  };

  it("reads Sonnet 4.6's block list, verbatim from real pi (44 of its 47 edits were lost)", () => {
    const args = argsOf('```edit\npath: /tmp/pi-task-mi5OyW/mathutil.py\nedits:\n  - oldText: "    return sum(nums) / len(nums) + 1"\n    newText: "    return sum(nums) / len(nums)"\n```');
    expect(args).toEqual({
      path: "/tmp/pi-task-mi5OyW/mathutil.py",
      edits: [{ oldText: "    return sum(nums) / len(nums) + 1", newText: "    return sum(nums) / len(nums)" }],
    });
  });

  it("still reads the inline JSON Opus writes", () => {
    const args = argsOf('```edit\npath: calc.py\nedits: [{"oldText": "    return a - b", "newText": "    return a + b"}]\n```');
    expect(args.edits).toEqual([{ oldText: "    return a - b", newText: "    return a + b" }]);
  });

  it("reads single-quoted text with quotes and colons inside, and several items", () => {
    const args = argsOf(`\`\`\`edit\npath: calc.py\nedits:\n  - oldText: '"quotient": a - b,'\n    newText: '"quotient": a / b,'\n  - oldText: 'it''s'\n    newText: "say \\"hi\\"\\tthere"\n\`\`\``);
    expect(args.edits).toEqual([
      { oldText: '"quotient": a - b,', newText: '"quotient": a / b,' },
      { oldText: "it's", newText: 'say "hi"\tthere' },
    ]);
  });

  it("reads multi-line text as | and |- block scalars", () => {
    const args = argsOf("```edit\npath: calc.py\nedits:\n  - oldText: |\n      def add(a, b):\n          return a - b\n    newText: |-\n      def add(a, b):\n\n          return a + b\n```");
    expect(args.edits).toEqual([
      { oldText: "def add(a, b):\n    return a - b\n", newText: "def add(a, b):\n\n    return a + b" },
    ]);
  });

  it("reads a list whose dashes sit at the key's own column", () => {
    const args = argsOf("```edit\npath: a.py\nedits:\n- oldText: x = 1\n  newText: x = 2\n```");
    expect(args.edits).toEqual([{ oldText: "x = 1", newText: "x = 2" }]);
  });

  it("keeps mapping values as text — no YAML booleans or numbers", () => {
    const args = argsOf("```edit\npath: a.txt\nedits:\n  - oldText: 3000\n    newText: true\n```");
    expect(args.edits).toEqual([{ oldText: "3000", newText: "true" }]);
  });

  it("reads an object-typed param as a mapping, and carries on with the header after it", () => {
    const args = argsOf("```configure\noptions:\n  mode: fast\n  retries: 3\ntarget: prod\n```");
    expect(args).toEqual({ options: { mode: "fast", retries: "3" }, target: "prod" });
  });

  it("falls back to the old reading when the block isn't YAML it can read", () => {
    const args = argsOf("```edit\npath: a.py\nedits:\n  - oldText: x\n        newText: misaligned\n```");
    expect(args.edits).toEqual([]);
  });

  it("leaves a string param's indented lines alone, as before", () => {
    const args = argsOf("```bash\n  echo indented\n```");
    expect(args.command).toBe("  echo indented");
  });
});
