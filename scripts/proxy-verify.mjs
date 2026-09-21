// End-to-end proxy verification against live M365. Run unsandboxed.
// Usage: M365_DEBUG=1 node scripts/proxy-verify.mjs [--tools] [--agent]
import { createApp } from "../packages/proxy-lib/dist/index.mjs";
import { getToken } from "../packages/core/dist/index.mjs";

const useAgent = process.argv.includes("--agent");
const withTools = process.argv.includes("--tools");
const manyTools = process.argv.includes("--manytools");
// --model <id>: the magic default does not tool-call right now (route-probe
// 2026-07-07, 0/2 confabulating "I have no shell"); the Claude tones do.
const MODEL = (process.argv.find((a) => a.startsWith("--model=")) ?? "--model=m365-copilot").slice(8);

// Mimic opencode's "build" agent toolset to reproduce the disengagement.
const OPENCODE_LIKE_TOOLS = [
  ["bash", "Execute a shell command in the project root", { command: "string", description: "string" }],
  ["read", "Read the contents of a file", { filePath: "string", offset: "number", limit: "number" }],
  ["write", "Write content to a file, overwriting it", { filePath: "string", content: "string" }],
  ["edit", "Replace a string in a file", { filePath: "string", oldString: "string", newString: "string" }],
  ["glob", "Find files matching a glob pattern", { pattern: "string", path: "string" }],
  ["grep", "Search file contents with a regex", { pattern: "string", include: "string", path: "string" }],
  ["list", "List files and directories", { path: "string", ignore: "array" }],
  ["webfetch", "Fetch a URL and return its contents", { url: "string", format: "string" }],
  ["todowrite", "Write the session todo list", { todos: "array" }],
  ["todoread", "Read the session todo list", {}],
  ["task", "Spawn a sub-agent for a complex task", { description: "string", prompt: "string" }],
  ["patch", "Apply a unified diff patch to files", { patch: "string" }],
].map(([name, description, props]) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(props).map(([k, t]) => [k, { type: t, description: `the ${k}` }]),
      ),
      required: Object.keys(props).slice(0, 1),
    },
  },
}));

console.log(`[verify] getToken... (useAgent=${useAgent}, withTools=${withTools})`);
await getToken();
console.log("[verify] auth OK");

const app = createApp({ useAgent });

async function call(path, init) {
  const res = await app.fetch(new Request(`http://local${path}`, init));
  return res;
}

// health
let r = await call("/health");
console.log("[health]", r.status, await r.text());

// models
r = await call("/v1/models");
const models = await r.json();
console.log("[models]", r.status, "→", models.data.map((m) => m.id).join(", "));

// chat
const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from the filesystem",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path" } },
        required: ["path"],
      },
    },
  },
];

async function chat(messages) {
  const t0 = Date.now();
  const res = await call("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: false, messages, tools: TOOLS }),
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const j = await res.json();
  return { status: res.status, choice: j.choices?.[0], elapsed };
}

if (process.argv.includes("--multiturn")) {
  // Turn 1: ask to read a file → expect a tool call
  const msgs = [{ role: "user", content: "Read the file /etc/hostname and tell me the hostname" }];
  console.log("[turn1] →", JSON.stringify(msgs));
  let res = await chat(msgs);
  console.log(`[turn1] ${res.status} in ${res.elapsed}s finish=${res.choice?.finish_reason}`);
  const tc = res.choice?.message?.tool_calls?.[0];
  console.log("[turn1] tool_call:", JSON.stringify(tc));
  if (!tc) { console.log("[turn1] NO TOOL CALL — abort"); process.exit(1); }

  // Execute the tool locally and feed the result back
  msgs.push({ role: "assistant", content: null, tool_calls: res.choice.message.tool_calls });
  msgs.push({ role: "tool", tool_call_id: tc.id, name: tc.function.name, content: "web-prod-01" });
  console.log("[turn2] → sending tool result 'web-prod-01'");
  res = await chat(msgs);
  console.log(`[turn2] ${res.status} in ${res.elapsed}s finish=${res.choice?.finish_reason}`);
  console.log("[turn2] final:", JSON.stringify(res.choice?.message?.content)?.slice(0, 400));
  // The model should echo the hostname we returned, not hallucinate
  const ok = res.status === 200 && /web-prod-01/.test(res.choice?.message?.content || "");
  console.log(ok ? "[multiturn] PASS — model used the tool result" : "[multiturn] CHECK — did not echo result");
  process.exit(res.status === 200 ? 0 : 1);
}

const body = {
  model: MODEL,
  stream: false,
  messages: manyTools
    ? [{ role: "user", content: "Reply with exactly the word: pong" }]
    : withTools
      ? [{ role: "user", content: "Read the file /etc/hostname" }]
      : [{ role: "user", content: "What is 2+2? Reply with just the number." }],
  ...(manyTools ? { tools: OPENCODE_LIKE_TOOLS } : withTools ? { tools: TOOLS } : {}),
};

console.log("[chat] sending:", JSON.stringify(body.messages));
const t0 = Date.now();
r = await call("/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const j = await r.json();
console.log(`[chat] ${r.status} in ${elapsed}s`);
console.log("[chat] choice:", JSON.stringify(j.choices?.[0], null, 2)?.slice(0, 800));
process.exit(r.status === 200 ? 0 : 1);
