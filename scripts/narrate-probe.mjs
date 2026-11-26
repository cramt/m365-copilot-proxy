// Does the model say what it's doing beside its tool call? (hypotheses §60 F166, §64 F183)
//
// Sends Codex-shaped chat completions to a running proxy: a system line asking for a
// brief preamble, one `shell` tool, and tasks: a first turn, a mid-task turn (a failing
// `npm test` result) and, for F183, the turn after a run that failed to start
// (`after-failure`). Each turn is classified by what came back:
// `tool+narration` (text beside the call: what Codex shows as commentary),
// `tool-only`, or `text-only` (no call), and `runsItYourself` flags commentary that
// tells the user to run the block themselves. One JSON line per turn on stdout.
//
//   M365_NARRATE=sentence <start the proxy on PORT>   # the arm under test
//   node scripts/narrate-probe.mjs <port> <arm-label> [repeats] > out.ndjson
//   NARRATE_TASKS=first,after-failure NARRATE_NO_SYSTEM=1 NARRATE_MODELS=gpt-6.2-sol   # F183's runs
//
// Sequential, 8 s apart; every turn opens a new conversation, so keep repeats small.

const [port = "4141", arm = "unset", repeatsArg = "2"] = process.argv.slice(2);
const repeats = Number(repeatsArg);
const MODELS = (process.env.NARRATE_MODELS ?? "gpt-6.2-sol,claude-sonnet-5").split(",");
const SYSTEM = process.env.NARRATE_NO_SYSTEM === "1" ? [] : [{ role: "system", content: "You are a coding agent working in the user's repository. Before making tool calls, send a brief preamble (8-12 words) to the user explaining what you're about to do." }];
const RUNS_IT_YOURSELF = /\b(paste|copy)\b|\bopen (a |an |the )?(new )?(windows )?(powershell|terminal|command prompt)\b|\bstart menu\b|\brun (this|it|that|the (block|command|script|check))\b|\byou can run\b|\bneed you to\b|\bsend (me )?(back )?the output\b/i;
const TOOLS = [{
  type: "function",
  function: { name: "shell", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
}];
const ALL_TASKS = {
  first: [{ role: "user", content: "Find the three largest files under this folder and tell me their sizes." }],
  mid: [
    { role: "user", content: "Find why `npm test` fails in this project and fix it." },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "npm test 2>&1 | tail -20" }) } }] },
    { role: "tool", tool_call_id: "call_1", content: "> demo@1.0.0 test\n> node --test\n\n✖ tests/sum.test.js (12.1ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n  6 !== 5\n      at TestContext.<anonymous> (tests/sum.test.js:5:10)\n\nℹ tests 3\nℹ pass 2\nℹ fail 1" },
  ],
  "after-failure": [
    { role: "user", content: "Find why `npm test` fails in this project and fix it." },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "npm test 2>&1 | tail -20" }) } }] },
    { role: "tool", tool_call_id: "call_1", content: "exec failed: the runner couldn't open the working directory '/home/dev/demo' (Access is denied). Nothing ran." },
  ],
};
const TASKS = Object.fromEntries((process.env.NARRATE_TASKS ?? "first,mid").split(",").map((name) => [name, ALL_TASKS[name]]));

async function turn(model, task) {
  const t0 = Date.now();
  const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: true, tools: TOOLS, messages: [...SYSTEM, ...TASKS[task]] }),
  });
  let content = "", args = "", calls = 0, buf = "";
  const dec = new TextDecoder();
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("");
      if (!data || data === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(data); } catch { continue; }
      const delta = ev.choices?.[0]?.delta ?? {};
      if (delta.content) content += delta.content;
      for (const tc of delta.tool_calls ?? []) {
        if (tc.id) calls++;
        if (tc.function?.arguments) args += tc.function.arguments;
      }
    }
  }
  const kind = calls > 0 ? (content.trim() ? "tool+narration" : "tool-only") : "text-only";
  const narration = content.trim();
  return { status: res.status, kind, runsItYourself: RUNS_IT_YOURSELF.test(narration), secs: +((Date.now() - t0) / 1000).toFixed(1), narration: narration.slice(0, 300), command: args.slice(0, 160) };
}

for (let r = 0; r < repeats; r++) {
  for (const model of MODELS) {
    for (const task of Object.keys(TASKS)) {
      const row = { at: new Date().toISOString(), arm, model, task, ...(await turn(model, task)) };
      console.log(JSON.stringify(row));
      console.error(`${arm} ${model} ${task}: ${row.kind} ${row.secs}s | ${row.narration.replace(/\s+/g, " ").slice(0, 100)}`);
      await new Promise((done) => setTimeout(done, 8000));
    }
  }
}
