import { describe, it, expect } from "vitest";
import { parseToolCalls, formatToolDefinitions, looksLikeConfabulation, looksLikeHallucinatedCompletion, looksLikeRemoteArtifactCompletion, isProseDocument } from "./tools.js";
import type { ToolDef } from "./tools.js";

describe("parseToolCalls", () => {
  it("should parse a clean tool call with no extra text", () => {
    const input = '{"tool": "read_file", "arguments": {"path": "/etc/hostname"}}';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("read_file");
    expect(result.textContent).toBeNull();
  });

  it("should detect mixed output (text + tool call)", () => {
    const input = 'I\'ll read that file for you now.\n{"tool": "read_file", "arguments": {"path": "/etc/hostname"}}';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("read_file");
    // textContent should be non-null — the handler must strip this
    expect(result.textContent).not.toBeNull();
    expect(result.textContent!.length).toBeGreaterThan(0);
  });

  it("should detect mixed output with trailing text", () => {
    const input = '{"tool": "bash", "arguments": {"command": "ls"}}\nLet me know if you need anything else.';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.textContent).not.toBeNull();
  });

  it("should return null textContent for clean tool calls", () => {
    const input = '{"tool": "bash", "arguments": {"command": "cat package.json"}}';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.textContent).toBeNull();
  });

  it("should parse multiple tool calls", () => {
    const input = '{"tool": "read_file", "arguments": {"path": "/a"}}\n{"tool": "read_file", "arguments": {"path": "/b"}}';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(2);
  });

  it("should parse legacy fenced format", () => {
    const input = '```tool_call\n{"tool": "bash", "arguments": {"command": "ls"}}\n```';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("bash");
  });

  it("should cleanly parse a ```json fenced tool call (M365's natural markdown)", () => {
    const input = '```json\n{"tool": "read_file", "arguments": {"path": "/etc/hostname"}}\n```';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe("read_file");
    // The ```json fence markers must not survive as stray prose
    expect(result.textContent).toBeNull();
  });

  it("should strip a bare ``` fence around a tool call", () => {
    const input = '```\n{"tool": "bash", "arguments": {"command": "ls"}}\n```';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.textContent).toBeNull();
  });

  it("should keep real prose around a fenced tool call", () => {
    const input = 'Here you go:\n```json\n{"tool": "bash", "arguments": {"command": "ls"}}\n```';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.textContent).toContain("Here you go");
  });

  it("should return plain text when no tool calls present", () => {
    const input = "The answer is 42.";
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(false);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.textContent).toBe(input);
  });

  it("strips invented {confidence} objects so junk-only leftover isn't mixed output", () => {
    const input = '{"tool": "bash", "arguments": {"command": "ls"}}{"confidence": 0.57}';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.textContent).toBeNull();
  });

  it("drops a premature {final} success claim emitted alongside a tool call", () => {
    const input = '{"tool": "bash", "arguments": {"command": "nix build"}}{"final": "✅ SUCCESS\\nThe build passed."}';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.textContent).toBeNull();
  });

  it("unwraps a lone {final} answer into plain text", () => {
    const input = '{"final": "All done — the package builds."}';
    const result = parseToolCalls(input);

    expect(result.hasToolCalls).toBe(false);
    expect(result.textContent).toBe("All done — the package builds.");
  });
});

describe("M365_INJECT_REPLY_TOOL", () => {
  // Lazily import formatMessages so we pick up the env var per test.
  async function importFormat() {
    const mod = await import("./tools.js");
    return mod.formatMessages;
  }

  const sampleTools = [
    {
      type: "function" as const,
      function: {
        name: "bash",
        description: "Run a shell command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    },
  ];
  const userMsg = [{ role: "user" as const, content: "do a thing" }];

  it("does NOT inject the reply tool when the env var is unset", async () => {
    delete process.env.M365_INJECT_REPLY_TOOL;
    const fmt = await importFormat();
    const out = fmt(userMsg, sampleTools);
    expect(out).not.toContain("```reply");
  });

  it("injects a reply tool when M365_INJECT_REPLY_TOOL is set", async () => {
    process.env.M365_INJECT_REPLY_TOOL = "1";
    const fmt = await importFormat();
    const out = fmt(userMsg, sampleTools);
    expect(out).toContain("```reply");
    // It must also still include the caller's tools (fenced template)
    expect(out).toContain("```bash");
    delete process.env.M365_INJECT_REPLY_TOOL;
  });

  it("doesn't double-inject a reply tool already provided by the caller", async () => {
    process.env.M365_INJECT_REPLY_TOOL = "1";
    const fmt = await importFormat();
    const callerReply = {
      type: "function" as const,
      function: {
        name: "reply",
        description: "Caller-supplied reply",
        parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      },
    };
    const out = fmt(userMsg, [callerReply, ...sampleTools]);
    // Exactly one fenced template for the reply tool
    const matches = out.match(/```reply/g) ?? [];
    expect(matches).toHaveLength(1);
    delete process.env.M365_INJECT_REPLY_TOOL;
  });
});

describe("looksLikeHallucinatedCompletion", () => {
  it("flags claimed-but-not-done file mutations", () => {
    expect(looksLikeHallucinatedCompletion("I've replaced the README with a simplified, cleaner version that:")).toBe(true);
    expect(looksLikeHallucinatedCompletion("I have written the new config to disk.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("The README has been replaced with a shorter version.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("Done — I updated calc.py and saved it.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("The requested local edit is complete. No further changes are needed.")).toBe(true);
  });

  it("flags fakeable create-from-scratch hallucinations (no leading 'I')", () => {
    // The exact §8.12 failure string — bare "Created <file>" + "executed it".
    expect(looksLikeHallucinatedCompletion("Created fizzbuzz.py and executed it with python3.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("Wrote count_lines.py and ran it; the output is 42.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("Generated solution.js and executed it.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("I ran the script and it printed OK.")).toBe(true);
    expect(looksLikeHallucinatedCompletion("Executed it with python3 — all tests pass.")).toBe(true);
  });

  it("does NOT flag neutral prose, questions, or future intent", () => {
    expect(looksLikeHallucinatedCompletion("The hostname is web-prod-01.")).toBe(false);
    expect(looksLikeHallucinatedCompletion("I'll write the file next.")).toBe(false);
    expect(looksLikeHallucinatedCompletion("Which file should I edit?")).toBe(false);
    expect(looksLikeHallucinatedCompletion(null)).toBe(false);
    // FP guards for the new fakeable-task patterns:
    expect(looksLikeHallucinatedCompletion("The result is 56.")).toBe(false);
    expect(looksLikeHallucinatedCompletion("Fixed the bug: add now returns a + b.")).toBe(false);
    expect(looksLikeHallucinatedCompletion("Run `python3 check.py` to verify, e.g. in your shell.")).toBe(false);
    expect(looksLikeHallucinatedCompletion("I ran into an issue understanding the request.")).toBe(false);
    expect(looksLikeHallucinatedCompletion("This created some confusion, sorry.")).toBe(false);
  });
});

describe("isProseDocument (don't execute a written document's code fences)", () => {
  const bashTool = [{
    type: "function" as const,
    function: { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  }];
  const parse = (t: string) => parseToolCalls(t, bashTool);

  it("flags a markdown answer full of ```bash fences as a document", () => {
    const readme = `Here's a simplified README:

# my-tool
A thing that does stuff.

## Install
\`\`\`bash
pnpm install && pnpm build
\`\`\`

## Run
\`\`\`bash
pnpm run proxy 4141
\`\`\`
That should be everything you need to get going quickly.`;
    expect(isProseDocument(parse(readme))).toBe(true);
  });

  it("does NOT flag a single real action (the coding-loop case)", () => {
    expect(isProseDocument(parse("```bash\nsed -i 's/a - b/a + b/' calc.py\n```"))).toBe(false);
    expect(isProseDocument(parse("```bash\nls -la\n```"))).toBe(false);
  });

  it("does NOT flag a single action even with explanatory prose around it", () => {
    expect(isProseDocument(parse("I'll inspect the files first.\n```bash\nls -la && cat calc.py\n```"))).toBe(false);
  });

  it("does NOT flag two terse back-to-back commands (no document prose)", () => {
    expect(isProseDocument(parse("```bash\nls\n```\n```bash\ncat calc.py\n```"))).toBe(false);
  });

  it("does NOT flag Claude's 'preamble + a couple command fences' action style (F23)", () => {
    const claude = "I'll start by exploring the project structure and understanding the bug before fixing it.\n\n```bash\nls -la\n```\n\n```bash\ncat check.py\n```";
    expect(isProseDocument(parse(claude))).toBe(false);
  });

  it("still flags a document with markdown headers (the F15 case)", () => {
    const doc = "Here's a simplified README:\n\n## Install\n```bash\npnpm install\n```\n\n## Run\n```bash\npnpm start\n```";
    expect(isProseDocument(parse(doc))).toBe(true);
  });

  it("returns false when there are no tool calls at all", () => {
    expect(isProseDocument(parse("The answer is 42."))).toBe(false);
  });

  // A long headed answer to "what else could we add?" ending in an example command:
  // running it threw the answer away and started a stack nobody asked for.
  const recommendations = [
    "Here's what I'd add next for local dev, roughly in order of value.",
    "",
    "## Highest value next additions",
    "",
    "| Area | Addition | Why |",
    "|---|---|---|",
    ...Array.from({ length: 14 }, (_, i) =>
      `| Area ${i} | A seed script, health checks or a Make target for piece ${i} | Saves a few minutes on every fresh checkout and every onboarding |`),
    "",
    "## Observability",
    "Grafana, Loki and Tempo are already in the compose file behind a profile. To try them:",
    "",
  ].join("\n");
  const answerWithExample = `${recommendations}\`\`\`bash\ndocker compose --profile observability up -d\n\`\`\``;
  const guard = { longAnswers: true };

  // A real edit: an explanation of the fix, a python block whose comments start
  // with "# ", then the call that applies it. It is an action with or without the guard.
  const fixThenEdit = [
    "The failure comes from the date parser treating %d as zero padded on every platform, while the",
    "fixture dates use a single digit day. That is why only the first nine days of a month fail, and why",
    "the suite is green on the maintainer's machine. The fix is to accept both widths in the parser and",
    "to pin the expectation in the test so the two cannot drift apart again. The block below is the shape",
    "of the check I am going to make the parser satisfy:",
    "",
    "```python",
    ...Array.from({ length: 12 }, (_, i) => [
      `# case ${i}: a single digit day must parse the same as its padded form`,
      `assert parse_date("2026-11-${i + 1}") == parse_date("2026-11-${String(i + 1).padStart(2, "0")}")`,
    ]).flat(),
    "```",
    "",
    "Applying the change and running the suite:",
    "",
  ].join("\n");
  const fixThenEditCall = `${fixThenEdit}\`\`\`bash\nsed -i 's/%d/%e/' src/date.py && pytest -q tests/test_date.py\n\`\`\``;

  describe("with the guard off (the default)", () => {
    it("never reclassifies a single action, however long and structured the lead-in", () => {
      expect(recommendations.length).toBeGreaterThan(1500);
      expect(isProseDocument(parse(answerWithExample), answerWithExample, bashTool)).toBe(false);
    });

    it("keeps a python block with '# ' comments followed by a bash call as a tool call", () => {
      expect(fixThenEdit.trim().length).toBeGreaterThan(1500);
      expect(/^#{1,6}\s/m.test(fixThenEdit)).toBe(true); // what used to read as a heading
      expect(parse(fixThenEditCall).toolCalls).toHaveLength(1);
      expect(isProseDocument(parse(fixThenEditCall), fixThenEditCall, bashTool)).toBe(false);
    });
  });

  describe("with the guard on (M365_LONG_ANSWER_GUARD)", () => {
    const flagged = (text: string) => isProseDocument(parse(text), text, bashTool, guard);

    it("flags a long headed answer whose only fence is a trailing example", () => {
      expect(flagged(answerWithExample)).toBe(true);
    });

    it("flags a long answer built on a table alone", () => {
      const table = recommendations.replace(/^## .*$/gm, "");
      expect(/^#{1,6}\s/m.test(table)).toBe(false);
      expect(flagged(`${table}\`\`\`bash\nprintf example\n\`\`\``)).toBe(true);
    });

    it("keeps an action when a code block sits among the headed sections", () => {
      const text = `${recommendations.replace("## Observability", "## Observability\n```yaml\nprofiles: [observability]\n```")}\`\`\`bash\nprintf example\n\`\`\``;
      expect(flagged(text)).toBe(false);
    });

    it("keeps the python block with '# ' comments followed by a bash call as a tool call", () => {
      expect(flagged(fixThenEditCall)).toBe(false);
    });

    it("does not read a '# ' comment or a table row inside a fenced block as structure", () => {
      const prose = "I looked at the failing test and the stack trace points at the date parser. ".repeat(25);
      for (const fenced of ["```python\n# a comment\nx = 1\n```", "```text\n| a | b |\n|---|---|\n```"]) {
        const text = `${prose}\n\n${fenced}\n\n\`\`\`bash\nsed -i 's/%d/%e/' src/date.ts && pnpm test\n\`\`\``;
        expect(flagged(text)).toBe(false);
      }
    });

    it.each([
      ["mid-line python", "Example: ```python\n# comment\nx = 1\n```"],
      ["nested markdown", "```markdown\n```python\nx = 1\n```\n# comment\n```"],
      ["mid-line table", "Example: ```text\n| a | b |\n```"],
    ])("replay_7124b7e_fences: parses %s before a real trailing action", (_name, block) => {
      const text = `${"A detailed explanation of the fix without document structure. ".repeat(30)}\n${block}\n\`\`\`bash\nsed -i 's/a/b/' file && pytest -q\n\`\`\``;
      const parsed = parseToolCalls(text, bashTool);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(JSON.parse(parsed.toolCalls[0].function.arguments).command).toContain("sed -i");
      expect(isProseDocument(parsed, text, bashTool)).toBe(false);
      expect(isProseDocument(parsed, text, bashTool, guard)).toBe(false);
    });

    it.each([
      ["tilde python", "~~~python\n# comment\nx=1\n~~~\n```bash\nsed -i s/a/b/ file && pytest\n```"],
      ["four-backtick python", "````python\n# comment\nx=1\n````\n```bash\nsed -i s/a/b/ file && pytest\n```"],
    ])("replay_8d5a8dd_ambiguous: retains %s action", (_name, suffix) => {
      const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n${suffix}`;
      const parsed = parseToolCalls(text, bashTool);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(JSON.parse(parsed.toolCalls[0].function.arguments).command).toContain("sed -i");
      expect(isProseDocument(parsed, text, bashTool)).toBe(false);
      expect(isProseDocument(parsed, text, bashTool, guard)).toBe(false);
    });

    // #139: since the CommonMark scanner (#71) these read as no call and no re-ask.
    it.fails.each([
      ["unclosed python before native closer", "```python\n# comment\nx=1\n```bash\nsed -i s/a/b/ file && pytest\n</invoke>"],
    ])("replay_8d5a8dd_ambiguous: retains %s action", (_name, suffix) => {
      const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n${suffix}`;
      const parsed = parseToolCalls(text, bashTool);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(JSON.parse(parsed.toolCalls[0].function.arguments).command).toContain("sed -i");
      expect(isProseDocument(parsed, text, bashTool)).toBe(false);
      expect(isProseDocument(parsed, text, bashTool, guard)).toBe(false);
    });

    it.each(["# comment", "| table row |"])("replay_ea83f49_mixed_fences: retains action after four-backtick block containing %s", (structure) => {
      const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n${"`".repeat(4)}python\n\`\`\`\n${structure}\n\`\`\`python\n${"`".repeat(4)}\n\`\`\`bash\nsed -i s/a/b/ file && pytest\n\`\`\``;
      const parsed = parseToolCalls(text, bashTool);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(JSON.parse(parsed.toolCalls[0].function.arguments).command).toBe("sed -i s/a/b/ file && pytest");
      expect(isProseDocument(parsed, text, bashTool)).toBe(false);
      expect(isProseDocument(parsed, text, bashTool, guard)).toBe(false);
    });

    it.each(["~~~", "~~~~"])("conservatively retains a call when %s appears inside a closed native fence", (marker) => {
      const text = `# Heading\n${"Detailed explanation of the change. ".repeat(50)}\n\`\`\`python\n${marker}python\nx=1\n${marker}\n\`\`\`\n\`\`\`bash\nprintf example\n\`\`\``;
      const parsed = parseToolCalls(text, bashTool);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(isProseDocument(parsed, text, bashTool)).toBe(false);
      expect(isProseDocument(parsed, text, bashTool, guard)).toBe(false);
    });

    // #139: since the CommonMark scanner (#71) these read as no call and no re-ask.
    it.fails.each(["````", "`````"])("conservatively retains a call when %s appears inside a closed native fence", (marker) => {
      const text = `# Heading\n${"Detailed explanation of the change. ".repeat(50)}\n\`\`\`python\n${marker}python\nx=1\n${marker}\n\`\`\`\n\`\`\`bash\nprintf example\n\`\`\``;
      const parsed = parseToolCalls(text, bashTool);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(isProseDocument(parsed, text, bashTool)).toBe(false);
      expect(isProseDocument(parsed, text, bashTool, guard)).toBe(false);
    });

    it.each(["# Heading", "| Area | Value |"])("conservatively keeps action with %s and a mid-line nested fence", (structure) => {
      const text = `${structure}\n${"Useful explanation. ".repeat(90)}\nExample: \`\`\`markdown\n\`\`\`python\n# comment\n\`\`\`\n\`\`\`\n\`\`\`bash\nprintf example\n\`\`\``;
      const parsed = parseToolCalls(text, bashTool);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(isProseDocument(parsed, text, bashTool)).toBe(false);
      expect(isProseDocument(parsed, text, bashTool, guard)).toBe(false);
    });

    it("still flags a genuinely structured answer with a native-closer example", () => {
      const text = `${recommendations}\`\`\`bash\nprintf example\n</invoke>`;
      const parsed = parseToolCalls(text, bashTool);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(isProseDocument(parsed, text, bashTool)).toBe(false);
      expect(isProseDocument(parsed, text, bashTool, guard)).toBe(true);
    });

    it("does not count mid-line fenced content towards the length threshold", () => {
      const text = `# Heading\nBrief.\nExample: \`\`\`python\n${"# filler\n".repeat(300)}\`\`\`\n\`\`\`bash\nprintf example\n\`\`\``;
      expect(parseToolCalls(text, bashTool).toolCalls).toHaveLength(1);
      expect(flagged(text)).toBe(false);
    });

    it.each(["    | a | b |", "     | a | b |", "\t| a | b |", " \t| a | b |", "    # comment", "\t# comment"])("replay_f2d1258_indented: keeps action after code line %j", (line) => {
      const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n\n${line}\n\n\`\`\`bash\nsed -i s/a/b/ file && pytest\n\`\`\``;
      const parsed = parseToolCalls(text, bashTool);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(JSON.parse(parsed.toolCalls[0].function.arguments).command).toBe("sed -i s/a/b/ file && pytest");
      expect(isProseDocument(parsed, text, bashTool)).toBe(false);
      expect(isProseDocument(parsed, text, bashTool, guard)).toBe(false);
    });

    it.each(["", " ", "  ", "   "])("recognizes real heading and table with %j indentation", (indent) => {
      for (const structure of ["| a | b |\n" + indent + "| --- | --- |", "# Heading"]) {
        const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n\n${indent}${structure}\n\`\`\`bash\nprintf example\n\`\`\``;
        const parsed = parseToolCalls(text, bashTool);
        expect(parsed.toolCalls).toHaveLength(1);
        expect(isProseDocument(parsed, text, bashTool)).toBe(false);
        expect(isProseDocument(parsed, text, bashTool, guard)).toBe(true);
      }
    });

    it("does not erase indentation on the first prose line", () => {
      const text = `    | a | b |\n${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n\`\`\`bash\nprintf example\n\`\`\``;
      const parsed = parseToolCalls(text, bashTool);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(isProseDocument(parsed, text, bashTool, guard)).toBe(false);
    });

    it.each([
      ["HTML comment heading", "<!--\n# internal implementation note\n-->"],
      ["HTML comment table", "<!--\n| a | b |\n-->"],
      ["HTML pre", "<pre>\n# code comment\n</pre>"],
      ["multiline inline code", "Here is the snippet: `first line\n# this is code, not a heading\nlast line`"],
      ["indented code with real heading", "# Plan\n    x = 1"],
      ["inline code with real heading", "# Plan\nUse `example` here."],
      ["list with real heading", "# Plan\n- item"],
      ["link with real heading", "# Plan\n[reference](example)"],
    ])("replay_a804b53_markup: retains action with %s", (_name, block) => {
      const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n\n${block}\n\n\`\`\`bash\nsed -i s/a/b/ file && pytest\n\`\`\``;
      const parsed = parseToolCalls(text, bashTool);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(JSON.parse(parsed.toolCalls[0].function.arguments).command).toBe("sed -i s/a/b/ file && pytest");
      expect(isProseDocument(parsed, text, bashTool)).toBe(false);
      expect(isProseDocument(parsed, text, bashTool, guard)).toBe(false);
    });

    it.each([
      ["empty", "||", false], ["space", "| |", false], ["separator", "|---|---|", false],
      ["one row", "| a | b |", false], ["blank header", "| | |\n|---|---|", false],
      ["punctuation header", "| ... | --- |\n|---|---|", false],
      ["valid table", "| a | b |\n|---|---|\n| x | y |", true],
      ["escaped pipe", "| a \\| b | c |\n| --- | :---: |", true],
      ["mismatched columns", "| a | b |\n| --- |", false],
      ["CRLF spaced", "   | a | b |\r\n   | --- | --- |", true],
      ["four spaces", "    | a | b |\n    | --- | --- |", false],
      ["tab", "\t| a | b |\n\t| --- | --- |", false],
      ["heading", "# Heading", true],
    ])("replay_34e3a2d_table: %s", (_name, structure, expected) => {
      const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n\n${structure}\n\`\`\`bash\nsed -i s/a/b/ file && pytest\n\`\`\``;
      const parsed = parseToolCalls(text, bashTool);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(JSON.parse(parsed.toolCalls[0].function.arguments).command).toBe("sed -i s/a/b/ file && pytest");
      expect(isProseDocument(parsed, text, bashTool)).toBe(false);
      expect(isProseDocument(parsed, text, bashTool, guard)).toBe(expected);
    });

    it.each([
      ["#  ", false], ["##    ", false], ["# ---", false], ["#", false], ["### !!!", false], ["#### ###", false],
      ["# Heading", true], ["## 123", true], ["### Café", true], ["  # 東京", true],
      ["| --- | ... |\n| --- | --- |", false], ["| 東京 | ... |\n| --- | --- |", true],
    ])("replay_84edab9_heading: meaningful structure %j", (row, expected) => {
      const text = `${"Detailed explanation of the change and why it is needed. ".repeat(32)}\n\n${row}\n\n\`\`\`bash\nsed -i s/a/b/ file && pytest\n\`\`\``;
      const parsed = parseToolCalls(text, bashTool);
      expect(parsed.toolCalls).toHaveLength(1);
      expect(JSON.parse(parsed.toolCalls[0].function.arguments).command).toBe("sed -i s/a/b/ file && pytest");
      expect(isProseDocument(parsed, text, bashTool)).toBe(false);
      expect(isProseDocument(parsed, text, bashTool, guard)).toBe(expected);
    });

    it("counts only the prose outside fenced blocks towards the length", () => {
      const filler = "```python\n" + "# filler\n".repeat(400) + "```";
      const text = `## Heading\nShort prose.\n\n${filler}\n\n\`\`\`bash\nprintf example\n\`\`\``;
      expect(flagged(text)).toBe(false);
    });

    it("does NOT flag a single action with a long but unstructured lead-in", () => {
      const lead = `${"I looked at the failing test and the stack trace points at the date parser. ".repeat(25)}\n`;
      expect(flagged(`${lead}\`\`\`bash\nsed -i 's/%d/%e/' src/date.ts && pnpm test\n\`\`\``)).toBe(false);
    });

    it("does NOT flag a single action with a short headed lead-in", () => {
      expect(flagged("## Step 2\nNow run the migration.\n```bash\npnpm db:migrate\n```")).toBe(false);
    });

    it("does NOT flag a single call when the raw text isn't given", () => {
      expect(isProseDocument(parse(answerWithExample), undefined, bashTool, guard)).toBe(false);
      expect(isProseDocument(parse(answerWithExample), answerWithExample, undefined, guard)).toBe(false);
    });

    it.each(["# Heading", "| Area | Value |\n| --- | --- |"])("uses the 1500-character trimmed boundary for %s", (structure) => {
      const prefix = (length: number) => structure + "\n" + "x".repeat(length - structure.length - 1);
      for (const [length, expected] of [[1499, false], [1500, true], [1501, true]] as const) {
        expect(flagged(`${prefix(length)}\n\n\`\`\`bash\nprintf example\n\`\`\``)).toBe(expected);
      }
    });

    it("needs the call to end the reply: text after it makes the call an action", () => {
      expect(flagged(`${answerWithExample}\n\n`)).toBe(true);
      expect(flagged(`${answerWithExample}\nMore prose follows.`)).toBe(false);
      expect(flagged(`${answerWithExample}\n\`\`\`text\noutput\n\`\`\``)).toBe(false);
    });

    it("keeps an opening call despite a long structured tail", () => {
      expect(flagged(`\`\`\`bash\nprintf example\n\`\`\`\n${recommendations}`)).toBe(false);
    });

    it("leaves the multi-call rules as they were", () => {
      const readme = "# Title\nintro\n```bash\nls\n```\ntext\n```bash\npwd\n```";
      expect(isProseDocument(parse(readme), readme, bashTool, guard)).toBe(isProseDocument(parse(readme), readme, bashTool));
      expect(isProseDocument(parse(readme), readme, bashTool)).toBe(true);
    });
  });
});

describe("a call the model restates as a correction", () => {
  const bashTool = [{
    type: "function" as const,
    function: { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  }];
  const PLAN = "The logs are plain text, so the viewer can read them once they are renamed. Two of the files are empty "
    + "and can go. Next I'll rename the rest to `.log`, delete the two empty ones, and point the index page at the "
    + "local copies, keeping a backup of the page first so the change is easy to undo if anything looks wrong.";
  const CMD1 = "cd /tmp/proj && rm logs/a.txt logs/b.txt && for f in logs/*.txt; do mv \"$f\" \"${f%.txt}.log\"; done && ls logs; grep -n 'href\\|src' index.html";
  const CMD2 = "cd /tmp/proj && rm logs/a.txt logs/b.txt && for f in logs/*.txt; do mv \"$f\" \"${f%.txt}.log\"; done && ls logs; grep -n 'href' index.html";
  // The shape of the live Sonnet 5.5 reply: a long plan, the command with a glued
  // `</bash>`, a one-line apology, and the command again.
  const reply = `${PLAN}\n\n\`\`\`bash\n${CMD1}</bash>\n\`\`\`\n\nOops, that closing fence is wrong. Here is the same command, correctly formatted:\n\n\`\`\`bash\n${CMD2}\n\`\`\``;

  it("runs the corrected copy, as one call, and the document guard lets it through", () => {
    const parsed = parseToolCalls(reply, bashTool);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(JSON.parse(parsed.toolCalls[0].function.arguments).command).toBe(CMD2);
    expect(isProseDocument(parsed, reply, bashTool)).toBe(false);
  });

  it("leaves nothing after the call to report as speculation", async () => {
    const { textAfterFirstToolCall } = await import("./tools.js");
    expect(textAfterFirstToolCall(reply, bashTool)).toBe("");
  });

  it("restates on the apology alone, when the first copy was well-formed", () => {
    const parsed = parseToolCalls(reply.replace("</bash>", ""), bashTool);
    expect(parsed.toolCalls.map((c) => JSON.parse(c.function.arguments).command)).toEqual([CMD2]);
  });

  it("keeps two calls when nothing says the second corrects the first", () => {
    const twice = `\`\`\`bash\n${CMD1}\n\`\`\`\n\nThen:\n\n\`\`\`bash\n${CMD2}\n\`\`\``;
    expect(parseToolCalls(twice, bashTool).toolCalls).toHaveLength(2);
  });

  it("keeps different commands apart, whatever the gap says — and a give-up is still a document", () => {
    const giveUp = "The notes/ directory doesn't appear to exist in the sandbox I have access to, so I'm unable to look "
      + "for the code myself. The task references a filesystem that isn't reachable through my tools. You can find it "
      + "by running this in your project, and if the first one is wrong for your layout, sorry, try:\n\n"
      + "```bash\ngrep -rn 'SECRET_CODE=' notes/*.txt\n```\n\nOr more broadly:\n\n```bash\ngrep -r 'SECRET_CODE=' notes/ | sed 's/.*SECRET_CODE=//'\n```";
    const parsed = parseToolCalls(giveUp, bashTool);
    expect(parsed.toolCalls).toHaveLength(2);
    expect(isProseDocument(parsed, giveUp, bashTool)).toBe(true);
  });
});

describe("looksLikeConfabulation", () => {
  it("flags real M365 give-up confabulations", () => {
    expect(looksLikeConfabulation("I'm unable to access or list any files in the working directory (all shell commands are returning no output).")).toBe(true);
    expect(looksLikeConfabulation("I don't have access to your project files or the ability to run python3 check.py here.")).toBe(true);
    expect(looksLikeConfabulation("To move forward, please paste the contents of calc.py and check.py.")).toBe(true);
    expect(looksLikeConfabulation("It looks like the execution environment isn't returning any output to the commands.")).toBe(true);
    // exact strings from the live pi README run that previously slipped through
    expect(looksLikeConfabulation("The `README.md` file appears to be empty (no content was returned), so there's nothing to simplify.")).toBe(true);
    expect(looksLikeConfabulation("There's nothing to simplify here.")).toBe(true);
    // F12.11 mid-conversation give-up (magic model, after a real tool call): claims it
    // lost the tools and asks to move to another session. Previously slipped through.
    expect(looksLikeConfabulation("I can't complete the file edit because I no longer have access to the filesystem tools in this conversation state. Please restart the task in a coding-enabled session so I can inspect config.json and change the port from 3000 to 8080.")).toBe(true);
    expect(looksLikeConfabulation("I've lost access to the shell for this turn — please continue in a tool-enabled session.")).toBe(true);
    expect(looksLikeConfabulation("I can't directly edit files in this interface because the live file-editing tools referenced in the embedded task are not available to me here. If you open config.json and change the port from 3000 to 8080 that will satisfy the request.")).toBe(true);

    // §12.13 wrong-machine reports: true statements about M365's own sandbox.
    expect(looksLikeConfabulation("I ran container.exec with `pwd` and it returned /mnt/data.")).toBe(true);
    expect(looksLikeConfabulation("container.download output shows the file in /mnt/data/tmp.")).toBe(true);
    expect(looksLikeConfabulation("I ran the commands. - pwd -> /mnt/data")).toBe(true);
    // Exact GPT-5.6 follow-up from the live OMP failure (2026-08-06).
    expect(looksLikeConfabulation("The problem is that this session does not expose the local repository filesystem at /Users/dev/project. My filesystem only contained /mnt/data.")).toBe(true);
  });

  it("flags Turkish give-ups (the model answers in the user's language)", () => {
    // Exact strings from live Windows/pi/GPT-5.6 runs that went straight to the user.
    expect(looksLikeConfabulation("Projeyi inceledim ancak bu oturumda dosya oluşturma özelliğim devre dışı olduğu için `ozet.md` dosyasını doğrudan kaydedemiyorum.")).toBe(true);
    expect(looksLikeConfabulation("Projeyi inceleyip ozet.md oluşturabilmem için bu oturumda depo dosyalarını okuma ve dosya yazma aracı etkin değil.")).toBe(true);
    expect(looksLikeConfabulation("Bu oturumda yeni bir araç çağrısı yapamadığım için dosyayı güvenilir biçimde oluşturamadım.")).toBe(true);
    expect(looksLikeConfabulation("Dosya erişimi etkin bir kodlama oturumunda aynı isteği yeniden çalıştırdığınızda hazırlanabilir.")).toBe(true);
    expect(looksLikeConfabulation("İçeriği kopyalayıp ozet.md adıyla kaydedebilirsin.")).toBe(true);
    expect(looksLikeConfabulation("Üzgünüm, dosyaya erişemiyorum.")).toBe(true);
    // Missed live (pdf + docx tasks): "ability" and "produce" weren't in the lists.
    expect(looksLikeConfabulation("Dosya oluşturma yeteneğim şu anda devre dışı olduğu için `notlar.pdf` dosyasını doğrudan üretemiyorum.")).toBe(true);
    expect(looksLikeConfabulation("Word belgesini hazırlayamıyorum.")).toBe(true);
    // Missed live on the final build (pdf task, after a real tool call).
    expect(looksLikeConfabulation("PDF oluşturma işlemini bu oturumda tamamlayamıyorum. Alternatif olarak Markdown dosyasını Visual Studio Code’da açabilirsiniz.")).toBe(true);
    expect(looksLikeConfabulation("`pandoc` sistemde kurulu olmadığı için PDF oluşturma komutu başarısız oldu. Bu oturumda yeni araç kurma veya indirilebilir PDF oluşturma yetkim bulunmuyor.")).toBe(true);
  });

  it("does NOT flag a Turkish project summary that merely talks about sessions or disabled flags", () => {
    // This repo's own vocabulary — a summary of it must not read as a give-up.
    expect(looksLikeConfabulation("Kimlik doğrulama ve oturum yönetimi MSAL ile yapılır.")).toBe(false);
    expect(looksLikeConfabulation("M365_NO_CONFAB_RETRY ile retry devre dışı bırakılır.")).toBe(false);
    expect(looksLikeConfabulation("Harness dosyayı okuyamıyorsa hata döner; proxy komutu kendisi çalıştıramaz.")).toBe(false);
    expect(looksLikeConfabulation("ozet.md oluşturuldu: 18 bölüm, paket mimarisi ve araç çağrısı akışı.")).toBe(false);
    // Third person ("yetkisi"), not first ("yetkim"): describes the code, not a give-up.
    expect(looksLikeConfabulation("Kullanıcının yetkisi bulunmuyorsa proxy 403 döner.")).toBe(false);
  });

  it("flags the first-person 'can't generate files' / 'can't … in this session' give-ups", () => {
    // Exact GPT-5.6 reply from a live PDF task (Windows / pi, relay_batch): it went
    // to the user with no forcing retry.
    expect(looksLikeConfabulation("You’re right. The recorded command was truncated at `margin: 22m`, produced no output, and did not create the intended HTML, CSS, or PDF.\n\nI can’t generate files in the current session. If you paste the original document content or request again, I can provide complete, copy-paste-ready HTML/CSS that you can save locally and print to PDF.")).toBe(true);
    // GPT-6.1 Sol's, quoted in hypotheses §27.
    expect(looksLikeConfabulation("I can't create or run scripts in this session.")).toBe(true);
    expect(looksLikeConfabulation("I'm unable to produce the PDF here.")).toBe(true);
    expect(looksLikeConfabulation("I am not able to export documents during this conversation.")).toBe(true);
  });

  it("does NOT flag what a program can't do, or a question that offers code", () => {
    // Third person: a finished answer describing a tool's limits.
    expect(looksLikeConfabulation("Done. Note that the exporter can't generate PDFs without wkhtmltopdf installed.")).toBe(false);
    expect(looksLikeConfabulation("The CLI cannot export documents in a chat session; run it from a terminal.")).toBe(false);
    // A real reply (no request in the prompt): a question, not a give-up.
    expect(looksLikeConfabulation("I can see the tests in `test.mjs`, but there’s no request or `todo.mjs` implementation yet.\n\nWould you like me to write the copy-paste-ready `todo.mjs` code that satisfies these tests?")).toBe(false);
  });

  it("does NOT flag genuine final answers or normal prose", () => {
    expect(looksLikeConfabulation("Fixed the bug: add now returns a + b, and check.py prints OK.")).toBe(false);
    expect(looksLikeConfabulation("The hostname is web-prod-01.")).toBe(false);
    expect(looksLikeConfabulation("Done.")).toBe(false);
    expect(looksLikeConfabulation(null)).toBe(false);
    expect(looksLikeConfabulation("")).toBe(false);
  });
});

describe("looksLikeRemoteArtifactCompletion", () => {
  it("flags the exact Teams-hosted patch shape returned by GPT-5.6", () => {
    const response = "I prepared the update for `plan.md`.\n\n[Download the update patch](https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/0-weu-d17-example/views/original/plan-update.patch)";
    expect(looksLikeRemoteArtifactCompletion(response)).toBe(true);
  });

  // Detection must be anchored to an M365 artifact (Teams URL, sandbox path,
  // citation marker). "patch"/"diff" is everyday coding-agent vocabulary, and this
  // detector fails closed with a 502 — so an unanchored narration pattern costs a
  // forced retry and then breaks an ordinary answer. Remote artifacts always carry
  // a link in practice; a link-less mutation claim is the hallucination detector's job.
  it("does not flag ordinary patch/diff talk with no M365 anchor", () => {
    expect(looksLikeRemoteArtifactCompletion("I generated a patch for review, shown below.")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion("You can download the patch from the GitHub release page.")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion("I've attached the diff inline above for you to inspect.")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion("git format-patch generated 3 patch files in the repo.")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion("Here is the diff I prepared for the change:\n\n```diff\n-a\n+b\n```")).toBe(false);
  });

  it("flags GPT-5.6's hidden M365 file citation presented as a local edit", () => {
    expect(looksLikeRemoteArtifactCompletion("Updated [plan.md](\uE200cite\uE202turn1file1\uE201) locally:\n\n- Changed the status to complete")).toBe(true);
  });

  it("flags an entire updated file hosted in Teams instead of written locally", () => {
    const response = "Updated `plan.md` with `Status: complete`.\n\n[Download the updated plan.md](https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/0-weu-d15-example/views/original/plan.md)";
    expect(looksLikeRemoteArtifactCompletion(response)).toBe(true);
  });

  it("flags M365's sandbox path returned after a forced local-edit retry", () => {
    expect(looksLikeRemoteArtifactCompletion("The update is complete. [Download plan.md](sandbox:/mnt/data/plan.md)")).toBe(true);
  });

  it("does not flag normal links, images, or local-edit confirmations", () => {
    expect(looksLikeRemoteArtifactCompletion("See the documentation at https://example.com/setup.patch-notes")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion("Download the source at https://eu-prod.asyncgw.teams.microsoft.com/v1/objects/example/views/original/plan.md")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion("![generated image](https://example.com/image.png)")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion("Updated plan.md using the local edit tool.")).toBe(false);
    expect(looksLikeRemoteArtifactCompletion(null)).toBe(false);
  });
});

describe("tool-result labelling", () => {
  const tools = [
    { type: "function" as const, function: { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  ];

  it("labels a tool result with the command that produced it (not 'unknown')", async () => {
    const { formatMessages } = await import("./tools.js");
    const out = formatMessages(
      [
        { role: "user", content: "list files" },
        { role: "assistant", tool_calls: [{ id: "c1", function: { name: "bash", arguments: '{"command":"ls -la"}' } }] },
        { role: "tool", tool_call_id: "c1", content: "README.md" },
      ],
      tools,
    );
    expect(out).toContain('<tool_response tool="bash" command="ls -la">');
    expect(out).not.toContain('name="unknown"');
  });

  it("falls back to a generic tool label when the call can't be correlated", async () => {
    const { formatMessages } = await import("./tools.js");
    const out = formatMessages(
      [{ role: "tool", tool_call_id: "orphan", content: "some output" }],
      tools,
    );
    expect(out).toContain('<tool_response tool="tool">');
  });

  // GPT-5.6's CoT in a long pi session: "the tool is responding with an unexpected
  // label" — an edit labelled command="todo.mjs", a command shown re-quoted.
  it("labels a file tool by its path, not as a command", async () => {
    const { formatToolResponse } = await import("./tools.js");
    const history = [{ role: "assistant", tool_calls: [{ id: "e1", function: { name: "edit", arguments: '{"path":"todo.mjs","edits":[]}' } }] }];
    const out = formatToolResponse({ role: "tool", tool_call_id: "e1", content: "Successfully replaced 1 block(s) in todo.mjs." }, history);
    expect(out).toContain('<tool_response tool="edit" path="todo.mjs">');
    expect(out).not.toContain("command=");
  });

  it("keeps Windows backslashes verbatim instead of doubling them", async () => {
    const { formatToolResponse } = await import("./tools.js");
    const history = [{ role: "assistant", tool_calls: [{ id: "r1", function: { name: "read", arguments: JSON.stringify({ path: "C:\\Users\\alice\\todo.mjs" }) } }] }];
    const out = formatToolResponse({ role: "tool", tool_call_id: "r1", content: "ok" }, history);
    expect(out).toContain('<tool_response tool="read" path="C:\\Users\\alice\\todo.mjs">');
    expect(out).not.toContain("\\\\");
  });

  it("keeps double quotes verbatim inside single-quoted attributes when no single quote is present", async () => {
    const { formatToolResponse } = await import("./tools.js");
    const history = [{ role: "assistant", tool_calls: [{ id: "dq1", function: { name: "bash", arguments: JSON.stringify({ command: 'echo "$f"' }) } }] }];
    const out = formatToolResponse({ role: "tool", tool_call_id: "dq1", content: "hi" }, history);
    expect(out).toContain(`<tool_response tool="bash" command='echo "$f"'>`);
  });

  it("preserves both quote styles and backslashes when both quote types appear", async () => {
    const { formatToolResponse } = await import("./tools.js");
    const cmd = `for f in a.mjs; do printf '%s\\n' "$f"; done`;
    const history = [{ role: "assistant", tool_calls: [{ id: "b1", function: { name: "bash", arguments: JSON.stringify({ command: cmd }) } }] }];
    const out = formatToolResponse({ role: "tool", tool_call_id: "b1", content: "a.mjs" }, history);
    expect(out).toContain(`<tool_response tool="bash" command="for f in a.mjs; do printf '%s\\n' &quot;$f&quot;; done">`);
    expect(out).toContain("printf '%s\\n'");
    expect(out).not.toContain("\\\\n");
    expect(out).not.toContain("'$f'"); // "$f" and '$f' are different shell commands
  });

  // Live (GPT-5.6, relay_batch, a PDF task): a label cut silently at 100 chars,
  // `command="… margin: 22m"`, was read as the command itself cut there.
  it("marks a long command it shortens, so the label doesn't read as a cut command", async () => {
    const { formatToolResponse } = await import("./tools.js");
    const cmd = `set -eu\ncss=".notlar-pdf.css"\nprintf '%s\\n' '@page { size: A4; margin: 22mm 20mm; }' 'body { font-family: "Segoe UI", Arial }' > "$css"`;
    const history = [{ role: "assistant", tool_calls: [{ id: "b2", function: { name: "bash", arguments: JSON.stringify({ command: cmd }) } }] }];
    const label = formatToolResponse({ role: "tool", tool_call_id: "b2", content: "(no output)" }, history).split("\n")[0];
    expect(label).toMatch(/…">$/);
    const short = [{ role: "assistant", tool_calls: [{ id: "b3", function: { name: "bash", arguments: '{"command":"ls -la"}' } }] }];
    expect(formatToolResponse({ role: "tool", tool_call_id: "b3", content: "x" }, short)).toContain('command="ls -la">');
  });

  it("unwraps a Codex Code Mode script and labels it as command with quotes preserved", async () => {
    const { formatToolResponse } = await import("./tools.js");
    const { codeModeShellScript } = await import("./fenced.js");
    const cmd = 'echo "$HOME"';
    const history = [{ role: "assistant", tool_calls: [{ id: "cm1", function: { name: "functions__exec", arguments: JSON.stringify({ input: codeModeShellScript(cmd) }) } }] }];
    const out = formatToolResponse({ role: "tool", tool_call_id: "cm1", content: "/home/u" }, history);
    expect(out).toContain(`<tool_response tool="functions__exec" command='echo "$HOME"'>`);
  });
});

describe("fenced tool format (the only format)", () => {
  const tools: ToolDef[] = [
    {
      type: "function" as const,
      function: {
        name: "bash",
        description: "Run a shell command",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "write_file",
        description: "Write a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" }, content: { type: "string" } },
          required: ["path", "content"],
        },
      },
    },
  ];

  it("parses a fenced tool call when tools are passed", () => {
    const result = parseToolCalls("```bash\nls -la\n```", tools);
    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls[0].function.name).toBe("bash");
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ command: "ls -la" });
    expect(result.textContent).toBeNull();
  });

  it("tolerates a stray JSON tool call (fallback for when M365 ignores the contract)", () => {
    const result = parseToolCalls('{"tool": "bash", "arguments": {"command": "ls"}}', tools);
    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls[0].function.name).toBe("bash");
  });

  it("normalizes a leaked container.exec JSON tool call to the caller shell tool", () => {
    const result = parseToolCalls('{"tool":"container.exec","arguments":{"command":"ls -la"}}', tools);
    expect(result.hasToolCalls).toBe(true);
    expect(result.toolCalls[0].function.name).toBe("bash");
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({ command: "ls -la" });
  });

  it("emits a fenced <tools> block and renders history as fenced calls", async () => {
    const mod = await import("./tools.js");
    const out = mod.formatMessages(
      [
        { role: "user", content: "make a file" },
        {
          role: "assistant",
          tool_calls: [{ id: "c1", function: { name: "write_file", arguments: '{"path":"a.py","content":"print(1)"}' } }],
        },
      ],
      tools,
    );
    expect(out).toContain("```write_file");
    expect(out).toContain("path: a.py");
    expect(out).not.toContain('{"tool":');
  });
});

describe("formatToolDefinitions", () => {
  const tools = [
    {
      type: "function" as const,
      function: {
        name: "read_file",
        description: "Read file contents",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    },
  ];

  it("emits the fenced contract (delegates to formatFencedToolDefinitions)", () => {
    const output = formatToolDefinitions(tools);

    expect(output).toContain("TOOL USE IS REQUIRED");
    expect(output).toContain("PRIMARY JOB");
    expect(output).toContain("SECONDARY");
    expect(output).toContain("ACTION"); // a fence is an executed action, not an illustration
  });

  it("lists each tool as a fenced template inside <tools>", () => {
    const output = formatToolDefinitions(tools);

    expect(output).toContain("read_file"); // the tool name heads its template
    expect(output).toContain("```read_file");
    expect(output).toContain("<tools>");
    expect(output).toContain("</tools>");
  });
});

describe("truncateAtFabricatedToolResponse (a self-written <tool_response> is a stop sequence)", () => {
  const bash = { type: "function" as const, function: { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } };
  // Shape of a Sonnet 4.6 fix-bug turn (Sep 28 bench): a real action, then an
  // INVENTED result, then more actions built on the invention — 3-4 fences in
  // the 13 turns the document guard returned as prose in that run.
  const fabricated = "\n```bash\nls -la && cat check.py && cat calc.py\n```\n\n<tool_response>\ntotal 20\ndrwxr-xr-x 1 user user 4096 .\n-rw-r--r-- 1 user user 30 calc.py\ndef add(a, b):\n    return a - b\n</tool_response>\n\nThe bug is the minus sign. Fixing it:\n\n```bash\nsed -i 's/a - b/a + b/' calc.py\n```\n\n<tool_response>\n</tool_response>\n\n```bash\ncat calc.py\n```\n\n<tool_response>\ndef add(a, b):\n    return a + b\n</tool_response>\n\n```bash\npython3 check.py\n```\n\n<tool_response>\nOK\n</tool_response>\n\nFixed — check.py prints OK.";

  it("keeps the real action and drops the invented result and everything after it", async () => {
    const { truncateAtFabricatedToolResponse, parseToolCalls, isProseDocument } = await import("./tools.js");
    const cut = truncateAtFabricatedToolResponse(fabricated, [bash]);
    expect(cut).toBe("\n```bash\nls -la && cat check.py && cat calc.py\n```");
    const parsed = parseToolCalls(cut, [bash]);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(JSON.parse(parsed.toolCalls[0].function.arguments).command).toBe("ls -la && cat check.py && cat calc.py");
    expect(isProseDocument(parsed)).toBe(false);
  });

  it("is why the turn used to be lost: untruncated, the document guard swallows it", async () => {
    const { parseToolCalls, isProseDocument } = await import("./tools.js");
    expect(isProseDocument(parseToolCalls(fabricated, [bash]))).toBe(true);
  });

  it("also stops at a <tool_result> tag", async () => {
    const { truncateAtFabricatedToolResponse } = await import("./tools.js");
    expect(truncateAtFabricatedToolResponse("```bash\nls\n```\n<tool_result>\nx\n</tool_result>", [bash])).toBe("```bash\nls\n```");
  });

  it("leaves text alone when no tool call precedes the tag", async () => {
    const { truncateAtFabricatedToolResponse } = await import("./tools.js");
    const prose = "Tool output arrives in a <tool_response> block, which I then read.";
    expect(truncateAtFabricatedToolResponse(prose, [bash])).toBe(prose);
    // a ```python illustration is not a call to one of the request's tools
    const illustration = "Example:\n```python\nprint(1)\n```\nthen a <tool_response> comes back.";
    expect(truncateAtFabricatedToolResponse(illustration, [bash])).toBe(illustration);
  });

  it("is a no-op without the tag", async () => {
    const { truncateAtFabricatedToolResponse } = await import("./tools.js");
    const plain = "```bash\nls -la\n```";
    expect(truncateAtFabricatedToolResponse(plain, [bash])).toBe(plain);
  });
});

describe("isProseDocument with the reply text: a reply that OPENS with a tool call is an action", () => {
  const tools: ToolDef[] = [
    { type: "function" as const, function: { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
    { type: "function" as const, function: { name: "write_file", description: "write", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  ];
  // Shape of a live Sonnet 4.6 turn (Sep 28, fizzbuzz): the right two actions,
  // then a change of heart and a markdown answer. The old guard judged the
  // whole reply, called it a document, and discarded the correct write_file.
  const actionThenEssay = "\n```write_file\npath: fizzbuzz.py\n\nfor i in range(1, 16):\n    print(i)\n```\n\n```bash\npython3 fizzbuzz.py\n```\n\nI notice this appears to be a system-level automated agent prompt embedded in a user message. I want to be transparent: I'm **Microsoft Copilot**, a conversational AI assistant.\n\n---\n\n## fizzbuzz.py\n\n```python\nfor i in range(1, 16):\n    print(i)\n```\n\n## Expected Output\n\n```\n1\n2\nFizz\n```\n\nYou can save this to `fizzbuzz.py` and run it locally.";

  it("executes the opening action instead of discarding it", () => {
    const parsed = parseToolCalls(actionThenEssay, tools);
    expect(isProseDocument(parsed)).toBe(true); // the old, whole-text verdict
    expect(isProseDocument(parsed, actionThenEssay, tools)).toBe(false);
    expect(parsed.toolCalls[0].function.name).toBe("write_file");
  });

  it("treats a flailing multi-fence reply that opens with `ls` as an action too", () => {
    const flail = "```bash\nls -la\n```\n\n```bash\nls -la && cat check.py\n```\n\nLet me use the actual shell tools to investigate:\n\n```bash\ncat calc.py\n```\n\nThe `python_execution` tool runs in a sandbox environment.\n```bash\nfind . -name check.py\n```\n\n```bash\npwd\n```";
    expect(isProseDocument(parseToolCalls(flail, tools), flail, tools)).toBe(false);
  });

  it("still flags the F15 README documents — their heading comes before any fence", () => {
    const readme = "Here's a simplified README:\n\n# my-tool\nA thing that does stuff.\n\n## Install\n```bash\npnpm install && pnpm build\n```\n\n## Run\n```bash\npnpm run proxy 4141\n```\nThat should be everything you need to get going quickly.";
    expect(isProseDocument(parseToolCalls(readme, tools), readme, tools)).toBe(true);
    const doc = "Here's a simplified README:\n\n## Install\n```bash\npnpm install\n```\n\n## Run\n```bash\npnpm start\n```";
    expect(isProseDocument(parseToolCalls(doc, tools), doc, tools)).toBe(true);
  });

  it("still flags a document whose example code comes before its first tool fence", () => {
    const doc = "Example:\n```python\nprint(1)\n```\n\n```bash\npip install x\n```\n\n```bash\npython3 app.py\n```\n\n## Notes\nThat's all there is to it, really. " + "x".repeat(300);
    expect(isProseDocument(parseToolCalls(doc, tools), doc, tools)).toBe(true);
  });

  it("falls through to the old rule when the preamble is a long intro", () => {
    const intro = "A".repeat(210) + "\n\n```bash\nls\n```\n\n## Next\n```bash\ncat a\n```";
    expect(isProseDocument(parseToolCalls(intro, tools), intro, tools)).toBe(true);
  });

  it("keeps Claude's one-line lead-in style an action", () => {
    const claude = "I'll start by exploring the project structure.\n\n```bash\nls -la\n```\n\n```bash\ncat check.py\n```";
    expect(isProseDocument(parseToolCalls(claude, tools), claude, tools)).toBe(false);
  });

  it("textAfterFirstToolCall returns the tail after the first real call", async () => {
    const { textAfterFirstToolCall } = await import("./tools.js");
    expect(textAfterFirstToolCall("```bash\nls\n```\n\nand then more", tools)).toBe("and then more");
    expect(textAfterFirstToolCall("```bash\nls\n```", tools)).toBe("");
    expect(textAfterFirstToolCall("no calls here", tools)).toBe("");
    expect(textAfterFirstToolCall("```python\nx\n```\n```bash\nls\n```\ntail", tools)).toBe("tail");
  });
});

describe("transcript style (which tags wrap the framing and harness system prompts)", () => {
  // Claude Sonnet 5 reads a `<system>` block inside a user turn as a forged
  // system prompt and ignores the framing it carries (docs §21). The Sonnet 5
  // variants therefore label text by its real source; every other variant
  // must keep the historical tags byte-for-byte.
  const tools = [
    { type: "function" as const, function: { name: "bash", description: "run", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  ];
  const msgs = [
    { role: "system", content: "You are an autonomous coding agent." },
    { role: "user", content: "fix the bug" },
  ];

  it("keeps <system> tags for baseline — the bench-tuned default is unchanged", async () => {
    const { formatMessages } = await import("./tools.js");
    const out = formatMessages(msgs, tools, undefined, undefined, "baseline");
    expect(out).toMatch(/^<system>\nYou are the execution core/);
    expect(out).toContain("<system>\nYou are an autonomous coding agent.\n</system>");
    expect(out).not.toContain("harness_");
  });

  it("never emits a <system> tag for the user-voice variants", async () => {
    const { formatMessages } = await import("./tools.js");
    for (const v of ["honest", "terse_user", "relay", "relay_batch"]) {
      const out = formatMessages(msgs, tools, undefined, undefined, v);
      expect(out).not.toContain("<system>");
      expect(out).toContain("<harness_system_prompt>\nYou are an autonomous coding agent.\n</harness_system_prompt>");
      expect(out).toContain("```bash"); // shell-routing survives
      expect(out).toContain("<user>\nfix the bug\n</user>");
    }
  });

  it("retag changes only the wrapper, not the baseline text inside it", async () => {
    const { formatMessages, formatToolDefinitions } = await import("./tools.js");
    const out = formatMessages(msgs, tools, undefined, undefined, "retag");
    expect(out).toContain(`<harness_instructions>\n${formatToolDefinitions(tools, "baseline")}\n</harness_instructions>`);
    expect(out).not.toContain("<system>");
  });

  it("tells the model its built-in sandbox is the wrong machine in every user-voice variant", async () => {
    const { formatToolDefinitions } = await import("./tools.js");
    for (const v of ["honest", "terse_user", "relay", "relay_batch"]) {
      expect(formatToolDefinitions(tools, v)).toMatch(/sandbox/);
    }
  });
});
