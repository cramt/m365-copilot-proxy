import { describe, it, expect } from "vitest";
import { parseToolCalls, formatToolDefinitions, looksLikeConfabulation, looksLikeHallucinatedCompletion, looksLikeRemoteArtifactCompletion, isProseDocument } from "./tools.js";

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
});

describe("fenced tool format (the only format)", () => {
  const tools = [
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
  const tools = [
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
    for (const v of ["honest", "terse_user", "relay"]) {
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
    for (const v of ["honest", "terse_user", "relay"]) {
      expect(formatToolDefinitions(tools, v)).toMatch(/sandbox/);
    }
  });
});
