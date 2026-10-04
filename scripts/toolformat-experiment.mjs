// A/B tool-call format experiment. Fresh conversation per call, agent on.
// Measures: does the model emit a parseable tool call (when expected),
// is it the right tool, and how much stray prose surrounds it.
// Run unsandboxed inside nix develop. Burns ~9 M365 messages.
import { ModelSession, parseToolCalls } from "../packages/core/dist/index.mjs";

const TOOLS_TEXT = `- read_file(path): read a file from the filesystem
- list_directory(path): list files in a directory
- bash(command): run a shell command`;

const FORMATS = {
  bare: `When a tool is needed, respond with ONLY this JSON object and nothing else:
{"tool":"<name>","arguments":{ ... }}`,
  fence_json: `When a tool is needed, respond with ONLY a fenced code block and nothing else:
\`\`\`json
{"tool":"<name>","arguments":{ ... }}
\`\`\``,
  fence_tool: `When a tool is needed, respond with ONLY a fenced code block tagged tool_call and nothing else:
\`\`\`tool_call
{"tool":"<name>","arguments":{ ... }}
\`\`\``,
};

function buildPrompt(mode, userQuery) {
  return `You are a tool-calling backend. You have these tools:
${TOOLS_TEXT}

${FORMATS[mode]}
If no tool is needed, just answer normally in plain text.

User: ${userQuery}`;
}

const PROMPTS = [
  { q: "Read the file /etc/hostname", expect: "read_file" },
  { q: "Show me what's in the /tmp directory", expect: "list_directory" },
  { q: "What is the capital of France? One word.", expect: null },
];

function classify(raw, expect) {
  const parsed = parseToolCalls(raw);
  const got = parsed.hasToolCalls ? parsed.toolCalls[0].function.name : null;
  const stray = (parsed.textContent || "").trim().length;
  if (expect === null) {
    // Should NOT call a tool
    return parsed.hasToolCalls ? "FALSE_TOOL" : "OK_PROSE";
  }
  if (!parsed.hasToolCalls) return "MISS_PROSE";
  if (got !== expect) return `WRONG_TOOL(${got})`;
  return stray > 0 ? `OK_TOOL+prose(${stray})` : "OK_TOOL_CLEAN";
}

const results = {};
for (const mode of Object.keys(FORMATS)) {
  results[mode] = [];
  for (const p of PROMPTS) {
    const session = new ModelSession(); // fresh conversation, agent on
    let raw = "";
    try {
      const stream = await session.run(buildPrompt(mode, p.q), "m365-copilot");
      for await (const d of stream) raw += d;
      if (stream.fullText.length > raw.length) raw = stream.fullText;
    } catch (e) {
      raw = `<error: ${e.message}>`;
    }
    const verdict = classify(raw, p.expect);
    results[mode].push({
      q: p.q,
      expect: p.expect,
      verdict,
      raw: raw.slice(0, 160).replace(/\n/g, "\\n"),
    });
    console.log(`[${mode}] ${verdict}  «${p.q}»`);
    console.log(`        raw: ${raw.slice(0, 160).replace(/\n/g, "\\n")}`);
    await new Promise((r) => setTimeout(r, 1500));
  }
}

console.log("\n===== SCOREBOARD =====");
for (const mode of Object.keys(results)) {
  const v = results[mode].map((r) => r.verdict);
  const good = v.filter((x) => x.startsWith("OK_TOOL") || x === "OK_PROSE").length;
  console.log(`${mode.padEnd(11)} ${good}/${PROMPTS.length}  [${v.join(", ")}]`);
}
