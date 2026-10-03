// Quick E2E of the SHIPPING tool path with a shell tool present (so shell-routing
// engages — the documented-working case). Confirms the proxy emits a tool_call and
// uses the tool result. Model overridable (default gpt-5.5-think-deeper).
import { createApp } from "../../packages/proxy-lib/dist/index.mjs";
import { getToken } from "../../packages/core/dist/index.mjs";

const MODEL = process.argv[2] || "gpt-5.5-think-deeper";
await getToken();
const app = createApp({});
const TOOLS = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command in the project root",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "the command" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];
const chat = async (messages) => {
  const t0 = Date.now();
  const res = await app.fetch(
    new Request("http://local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, stream: false, messages, tools: TOOLS }),
    }),
  );
  const j = await res.json();
  return {
    status: res.status,
    choice: j.choices?.[0],
    elapsed: ((Date.now() - t0) / 1000).toFixed(1),
  };
};

const msgs = [{ role: "user", content: "Print the current directory's files. Use the bash tool." }];
console.log(`[e2e] model=${MODEL} turn1 →`, msgs[0].content);
let r = await chat(msgs);
const tc = r.choice?.message?.tool_calls?.[0];
console.log(
  `[e2e] turn1 ${r.status} in ${r.elapsed}s finish=${r.choice?.finish_reason} tool_call=${JSON.stringify(tc?.function)}`,
);
if (!tc) {
  console.log(
    "[e2e] turn1: NO TOOL CALL — content:",
    JSON.stringify(r.choice?.message?.content)?.slice(0, 300),
  );
  process.exit(1);
}

msgs.push({ role: "assistant", content: null, tool_calls: r.choice.message.tool_calls });
msgs.push({
  role: "tool",
  tool_call_id: tc.id,
  name: tc.function.name,
  content: "README.md\npackage.json\nsrc",
});
r = await chat(msgs);
console.log(`[e2e] turn2 ${r.status} in ${r.elapsed}s finish=${r.choice?.finish_reason}`);
console.log("[e2e] turn2 final:", JSON.stringify(r.choice?.message?.content)?.slice(0, 300));
const ok = r.status === 200 && /README|package\.json/.test(r.choice?.message?.content || "");
console.log(
  ok
    ? "[e2e] PASS — proxy emitted a tool_call AND used the result"
    : "[e2e] turn2 did not echo the listing (still a tool_call turn?)",
);
