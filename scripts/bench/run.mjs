// m365-bench: a tiny Terminal-Bench-style harness to QUANTIFY what works best.
//
// Drives the local proxy as an OpenAI-compatible agent loop over a throwaway
// sandbox, runs each task's objective verifier, and prints a scorecard. Vary ONE
// lever (tool format, model/tone, prompt, optionsSets) per run via --label and
// diff the JSON outputs. No guessing — pass-rate is a number.
//
// Usage:
//   node scripts/bench/run.mjs --base-url http://localhost:4141/v1 --model m365-copilot \
//       [--label magic-json] [--tasks fizzbuzz,fix-bug] [--max-turns 12] [--repeat 1]
//
// ⚠ Executes MODEL-GENERATED shell in a temp dir (model-driven RCE by design).
//   Tasks are benign; still, run on a throwaway box if paranoid.
//
// Output: console scorecard + scripts/bench/out/<label>-<ts>.json

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { Agent, setGlobalDispatcher } from "undici";
import { TASKS } from "./tasks.mjs";

// Slow reasoning models (e.g. gpt-6-think-deeper) can hold a non-streaming request
// open for minutes; undici's default 300s headersTimeout would kill the turn and
// throw an uncaught UND_ERR_HEADERS_TIMEOUT that aborts the whole run (discarding
// every result gathered so far). Raise the transport timeouts and enforce one clean
// overall cap via AbortSignal in chat(). Override with BENCH_TIMEOUT_MS.
const REQ_TIMEOUT_MS = Number(process.env.BENCH_TIMEOUT_MS ?? 15 * 60 * 1000);
setGlobalDispatcher(new Agent({ headersTimeout: REQ_TIMEOUT_MS + 30_000, bodyTimeout: REQ_TIMEOUT_MS + 30_000 }));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const BASE = opt("--base-url", "http://localhost:4141/v1").replace(/\/$/, "");
const MODEL = opt("--model", "m365-copilot");
const LABEL = opt("--label", MODEL);
const MAX_TURNS = Number(opt("--max-turns", "12"));
const REPEAT = Number(opt("--repeat", "1"));
const PICK = opt("--tasks", "");
const tasks = PICK ? TASKS.filter(t => PICK.split(",").includes(t.name)) : TASKS;
const IMAGE = opt("--image", "python:3-slim");

// --- Docker sandbox: model-generated commands run in a --network none container
// with ONLY the task dir mounted, as the host uid (so file ops stay owner-clean).
// No host RCE, no egress. Real python3/bash for genuine "does the code work" checks.
const UID = execSync("id -u").toString().trim();
const GID = execSync("id -g").toString().trim();
function startContainer(sandbox) {
  return execSync(`docker run -d --rm --network none --user ${UID}:${GID} -e HOME=/tmp -v ${sandbox}:/work -w /work ${IMAGE} sleep 1800`, { encoding: "utf8" }).trim();
}
function dexec(cid, cmd, timeoutMs = 30000) {
  return spawnSync("docker", ["exec", "-w", "/work", cid, "bash", "-lc", cmd], { timeout: timeoutMs, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
}
function rmContainer(cid) { try { execSync(`docker rm -f ${cid}`, { stdio: "ignore" }); } catch {} }

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "bench", "out");
mkdirSync(OUT, { recursive: true });

// Per-request harness system prompt. Default is the neutral baseline; override via
// BENCH_SYSTEM (or --system <file>) to sweep prompt-framing hypotheses without an
// agent rebuild. Keep it constant within a run; vary it across labeled runs.
const DEFAULT_SYSTEM = "You are an autonomous coding agent working in a real shell. Use the provided tools to actually do the task against the live filesystem. Do not ask questions. When the task is fully complete, reply with a one-line confirmation.";
const SYSTEM_FILE = opt("--system", "");
const SEED = process.env.BENCH_SEED ?? ""; // "", "ls", or "cat" — context-seed level
const SYSTEM = SYSTEM_FILE ? readFileSync(SYSTEM_FILE, "utf8").trim()
  : (process.env.BENCH_SYSTEM ?? DEFAULT_SYSTEM);

// --- OpenAI tools the agent is given ---
const ALL_TOOLS = [
  { type: "function", function: { name: "bash", description: "Run a shell command in the working directory and get stdout/stderr.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
  { type: "function", function: { name: "read_file", description: "Read a file's contents.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Write (create/overwrite) a file with the given contents.", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "edit_file", description: "Replace the first occurrence of `old` with `new` in a file.", parameters: { type: "object", properties: { path: { type: "string" }, old: { type: "string" }, new: { type: "string" } }, required: ["path", "old", "new"] } } },
];
const TOOLSET = opt("--tool-set", "");  // e.g. "bash" to test a lean payload
const TOOLS = TOOLSET ? ALL_TOOLS.filter(t => TOOLSET.split(",").includes(t.function.name)) : ALL_TOOLS;

function execTool(name, a, sandbox, cid) {
  try {
    if (name === "bash") {
      const r = dexec(cid, a.command ?? "");
      const out = `exit=${r.status ?? "timeout/null"}\n${(r.stdout || "")}${r.stderr ? "\n[stderr]\n" + r.stderr : ""}`;
      return out.slice(0, 4000);
    }
    const safe = (p) => { const full = join(sandbox, p ?? ""); if (!full.startsWith(sandbox)) throw new Error("path escapes sandbox"); return full; };
    if (name === "read_file") return readFileSync(safe(a.path), "utf8").slice(0, 6000);
    if (name === "write_file") { const f = safe(a.path); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, a.content ?? ""); return `wrote ${a.path} (${(a.content || "").length} bytes)`; }
    if (name === "edit_file") {
      const f = safe(a.path); const cur = readFileSync(f, "utf8");
      if (!cur.includes(a.old)) return `ERROR: 'old' string not found in ${a.path}`;
      writeFileSync(f, cur.replace(a.old, a.new)); return `edited ${a.path}`;
    }
    return `ERROR: unknown tool ${name}`;
  } catch (e) { return `ERROR: ${e.message}`; }
}

async function chat(messages) {
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer bench" },
      body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, stream: false }),
      signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
    });
    if (!res.ok) { const t = await res.text(); return { error: `HTTP ${res.status}: ${t.slice(0, 200)}` }; }
    return res.json();
  } catch (e) {
    // Never let a transport error (timeout, reset, throttle-hang) crash the whole
    // run — degrade to an error row so remaining tasks run and the scorecard writes.
    return { error: `fetch failed: ${e.cause?.code || e.name}: ${e.message}` };
  }
}

function setupSandbox(task) {
  const dir = mkdtempSync(join(tmpdir(), `bench-${task.name}-`));
  for (const [rel, content] of Object.entries(task.files ?? {})) {
    const f = join(dir, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, content);
  }
  return dir;
}

function verify(task, sandbox, cid, finalAnswer) {
  if (task.expectAnswer) return (finalAnswer || "").includes(task.expectAnswer);
  if (task.verifyCmd) { const r = dexec(cid, task.verifyCmd); return r.status === 0; }
  return false;
}

async function runTask(task) {
  const sandbox = setupSandbox(task);
  let cid;
  try { cid = startContainer(sandbox); } catch (e) { return { task: task.name, solved: false, outcome: "ERROR", toolTurns: 0, msgs: 0, elapsedMs: 0, error: "container start failed: " + e.message, finalAnswer: "" }; }
  const runId = `${Date.now().toString(36)}-${Math.floor(performance.now())}`;
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `${task.prompt}\n\n<!-- bench-run:${runId} -->` }, // nonce → fresh proxy conversation
  ];

  // Optional context-seed (BENCH_SEED=ls|cat): inject a REAL prior tool round so
  // the model arrives mid-loop on a provably-present filesystem. Tests whether the
  // model will CONTINUE a tool loop even though it won't START one (the turn-1
  // confabulation "the directory is empty / commands return nothing"). `ls` seeds
  // just the directory tree; `cat` also seeds every file's contents.
  if (SEED === "ls" || SEED === "cat") {
    const cmd = SEED === "cat"
      ? "ls -laR; echo '--- FILE CONTENTS ---'; for f in $(find . -type f); do echo \"### $f\"; cat \"$f\"; done"
      : "ls -laR";
    const seedOut = execTool("bash", { command: cmd }, sandbox, cid);
    const callId = `seed_${runId}`;
    messages.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: callId, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: cmd }) } }],
    });
    messages.push({ role: "tool", tool_call_id: callId, content: seedOut });
  }
  let toolTurns = 0, proseTurns = 0, msgs = 0, finalAnswer = null, endReason = "maxturns", error = null;
  const t0 = Date.now();

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await chat(messages);
    msgs++;
    if (resp.error) { error = resp.error; endReason = "error"; break; }
    const m = resp.choices?.[0]?.message;
    if (!m) { error = "no message"; endReason = "error"; break; }
    if (m.tool_calls?.length) {
      messages.push({ role: "assistant", content: m.content ?? null, tool_calls: m.tool_calls });
      for (const tc of m.tool_calls) {
        let a = {}; try { a = JSON.parse(tc.function.arguments || "{}"); } catch {}
        const result = execTool(tc.function.name, a, sandbox, cid);
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        toolTurns++;
      }
    } else {
      finalAnswer = m.content || "";
      endReason = "prose";
      break;
    }
    await new Promise(r => setTimeout(r, 800)); // gentle pacing
  }

  const solved = verify(task, sandbox, cid, finalAnswer);
  rmContainer(cid);
  try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
  const outcome = solved ? "SOLVED" : error ? `ERROR` : endReason === "prose" ? "GAVE_UP_PROSE" : "MAX_TURNS";
  return { task: task.name, solved, outcome, toolTurns, msgs, elapsedMs: Date.now() - t0, error, finalAnswer: (finalAnswer || "").slice(0, 120) };
}

// --- run ---
console.log(`[bench] label=${LABEL} model=${MODEL} base=${BASE} tasks=${tasks.map(t=>t.name).join(",")} repeat=${REPEAT}`);
const rows = [];
for (let rep = 0; rep < REPEAT; rep++) {
  for (const task of tasks) {
    const r = await runTask(task);
    rows.push({ ...r, rep });
    console.log(`  ${r.task.padEnd(14)} ${r.outcome.padEnd(14)} tools=${r.toolTurns} msgs=${r.msgs} ${Math.round(r.elapsedMs/1000)}s ${r.error ? "(" + r.error.slice(0,50) + ")" : ""} ${r.solved ? "" : "answer=" + JSON.stringify(r.finalAnswer)}`);
    await new Promise(rr => setTimeout(rr, 1500));
  }
}

const solved = rows.filter(r => r.solved).length;
const pct = Math.round((solved / rows.length) * 100);
const byOutcome = rows.reduce((m, r) => ((m[r.outcome] = (m[r.outcome] || 0) + 1), m), {});
const avgTools = (rows.reduce((s, r) => s + r.toolTurns, 0) / rows.length).toFixed(1);
const totalMsgs = rows.reduce((s, r) => s + r.msgs, 0);

console.log(`\n[bench] === SCORECARD: ${LABEL} ===`);
console.log(`[bench] SOLVED ${solved}/${rows.length} (${pct}%)  |  outcomes: ${Object.entries(byOutcome).map(([k,v])=>`${k}=${v}`).join(" ")}`);
console.log(`[bench] avg tool-calls/task: ${avgTools}  |  M365 messages spent: ${totalMsgs}`);
writeFileSync(join(OUT, `${LABEL}-${TS}.json`), JSON.stringify({ label: LABEL, model: MODEL, base: BASE, ts: TS, pct, solved, total: rows.length, byOutcome, avgTools, totalMsgs, system: SYSTEM, rows }, null, 2));
console.log(`[bench] → scripts/bench/out/${LABEL}-${TS}.json`);
