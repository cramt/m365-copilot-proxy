// Probe: does a conversation survive the Opus priority-access wall MID-WAY,
// via M365_OPUS_FALLBACK_MODEL? (issue #18, docs/hypotheses.md §24 F59)
//
// Plays a harness against the proxy in-process: the model is asked to count
// with one ```bash `echo N` block per turn, the probe answers each with "N", and
// at the end the model must report the sum. Every turn is one Opus 5.5
// priority-access unit, so on an account with fewer units left than --steps the
// wall hits mid-conversation. With the fallback set, the proxy should move the
// conversation to the fallback model in a fresh M365 conversation WITH the full
// history: the numbering continues where it was (no restart at 1) and the final
// sum is right. Prints, per turn, which model answered.
//
// Usage (inside nix develop; spends up to --steps Opus units, then free 4.5 turns):
//   M365_OPUS_FALLBACK_MODEL=claude-opus-4.5 M365_DEBUG=1 M365_DUMP_FRAMES=1 \
//     node scripts/opus-fallback-probe.mjs [--steps=20] [--model=claude-opus]
// Without the fallback env var it shows the plain 429 at the wall instead.
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const arg = (name, def) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? def;
const STEPS = Number(arg("steps", "20"));
const MODEL = arg("model", "claude-opus");

const { createApp } = await import(pathToFileURL(resolve("packages/proxy-lib/dist/index.mjs")).href);
const { getToken } = await import(pathToFileURL(resolve("packages/core/dist/index.mjs")).href);
await getToken();
const app = createApp({});

const TOOLS = [{ type: "function", function: { name: "bash", description: "Run a shell command and return its output", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } }];
const messages = [
  { role: "system", content: "You are a careful assistant with a bash tool." },
  { role: "user", content: `Let's count with the shell, ONE number per turn: each turn, run exactly one \`echo N\` (N = 1, then 2, …, up to ${STEPS}), and wait for its output before the next. After the output of \`echo ${STEPS}\` comes back, don't run anything else: reply with the sum of all the outputs you received, as a number. (run ${Date.now()})` },
];

const log = [];
for (let turn = 1; turn <= STEPS + 3; turn++) {
  const t0 = Date.now();
  const res = await app.fetch(new Request("http://local/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: false, tools: TOOLS, messages }),
  }));
  const j = await res.json();
  const ms = Date.now() - t0;
  if (res.status !== 200) {
    console.log(`[fallback-probe] turn ${turn}: HTTP ${res.status} ${j.error?.code ?? ""} ${j.error?.param ?? ""} (${ms} ms) — stopping`);
    log.push({ turn, status: res.status, code: j.error?.code });
    break;
  }
  const msg = j.choices?.[0]?.message;
  const call = msg?.tool_calls?.[0];
  const opus = j.usage?.x_m365_opus_daily_remaining !== undefined ? ` opus left ${j.usage.x_m365_opus_daily_remaining}/day ${j.usage.x_m365_opus_weekly_remaining}/week` : "";
  if (call) {
    let cmd = "";
    try { cmd = JSON.parse(call.function.arguments).command ?? ""; } catch { /* keep "" */ }
    const n = cmd.match(/^\s*echo\s+(\d+)\s*$/)?.[1];
    console.log(`[fallback-probe] turn ${turn}: ${j.model} → ${JSON.stringify(cmd)} (${ms} ms)${opus}`);
    log.push({ turn, model: j.model, cmd });
    messages.push({ role: "assistant", content: null, tool_calls: [call] });
    messages.push({ role: "tool", tool_call_id: call.id, content: n ?? `unexpected command: ${cmd}` });
  } else {
    const text = (msg?.content ?? "").trim();
    console.log(`[fallback-probe] turn ${turn}: ${j.model} → final ${JSON.stringify(text.slice(0, 200))} (${ms} ms)${opus}`);
    log.push({ turn, model: j.model, final: text });
    break;
  }
}

const echoes = log.filter((l) => l.cmd).map((l) => Number(l.cmd.match(/echo\s+(\d+)/)?.[1]));
const inOrder = echoes.every((n, i) => n === i + 1);
const models = [...new Set(log.map((l) => l.model).filter(Boolean))];
const switchAt = log.findIndex((l, i) => i > 0 && l.model && log[i - 1].model && l.model !== log[i - 1].model);
const final = log.at(-1)?.final ?? "";
const expected = (STEPS * (STEPS + 1)) / 2;
console.log(`\n[fallback-probe] echoes ${echoes.join(",")} — ${inOrder ? "in order, no restart" : "NOT in order"}`);
console.log(`[fallback-probe] models: ${models.join(" → ")}${switchAt > 0 ? ` (switched at turn ${log[switchAt].turn})` : " (no switch)"}`);
console.log(`[fallback-probe] final answer ${final.includes(String(expected)) ? "CORRECT" : "WRONG/none"} (expected ${expected})`);
process.exit(0);
