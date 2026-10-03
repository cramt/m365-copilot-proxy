// One matrix cell of the tool-call harness: (model × system-prompt × toolset × task).
// Drives the proxy as a real OpenAI tool loop over a Docker sandbox, runs the task's
// objective verifier, and records the metrics that expose "big system prompt kills
// tool-calling": turn-1 COMPLIANCE (did it emit a tool call at all) and DISENGAGE
// (safety filter refused). Emits one JSON row to scripts/harness/out/.
//
// Usage: node scripts/harness/run-cell.mjs --base-url http://localhost:4142/v1 \
//   --model gpt-5.5-think-deeper --system scripts/harness/prompts/sys_large.txt \
//   --tool-preset large --tasks fix-bug --label L1 [--max-turns 10] [--repeat 1]
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { TASKS } from "../bench/tasks.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const BASE = opt("--base-url", "http://localhost:4142/v1").replace(/\/$/, "");
const MODEL = opt("--model", "m365-copilot");
const SYSTEM_FILE = opt("--system", "");
const SYSTEM = SYSTEM_FILE
  ? readFileSync(SYSTEM_FILE, "utf8").trim()
  : "You are a coding agent. Use the tools to complete the task.";
const PRESET = opt("--tool-preset", "standard");
const LABEL = opt("--label", `${MODEL}-${PRESET}`);
const MAX_TURNS = Number(opt("--max-turns", "10"));
const REPEAT = Number(opt("--repeat", "1"));
const PICK = opt("--tasks", "");
const IMAGE = opt("--image", "python:3-slim");
const tasks = PICK ? TASKS.filter((t) => PICK.split(",").includes(t.name)) : TASKS;

// --- toolsets: lean (1) / standard (4) / large (12, opencode-like) ---
const T = (name, description, props, required) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(
        Object.entries(props).map(([k, ty]) => [k, { type: ty, description: `the ${k}` }]),
      ),
      required: required ?? Object.keys(props).slice(0, 1),
    },
  },
});
const CORE_TOOLS = {
  bash: T("bash", "Run a shell command in the working directory and get stdout/stderr.", {
    command: "string",
  }),
  read_file: T("read_file", "Read a file's contents.", { path: "string" }),
  write_file: T(
    "write_file",
    "Write (create/overwrite) a file with the given contents.",
    { path: "string", content: "string" },
    ["path", "content"],
  ),
  edit_file: T(
    "edit_file",
    "Replace the first occurrence of `old` with `new` in a file.",
    { path: "string", old: "string", new: "string" },
    ["path", "old", "new"],
  ),
};
const EXTRA_TOOLS = {
  glob: T("glob", "Find files matching a glob pattern.", { pattern: "string", path: "string" }),
  grep: T("grep", "Search file contents with a regular expression.", {
    pattern: "string",
    path: "string",
  }),
  list: T("list", "List files and directories at a path.", { path: "string" }),
  webfetch: T("webfetch", "Fetch a URL and return its text contents.", { url: "string" }),
  todowrite: T("todowrite", "Write the session todo list.", { todos: "array" }),
  todoread: T("todoread", "Read the session todo list.", {}, []),
  task: T(
    "task",
    "Spawn a sub-agent for a complex sub-task.",
    { description: "string", prompt: "string" },
    ["description", "prompt"],
  ),
  patch: T("patch", "Apply a unified-diff patch to files.", { patch: "string" }),
};
const PRESETS = {
  lean: [CORE_TOOLS.bash],
  standard: Object.values(CORE_TOOLS),
  large: [...Object.values(CORE_TOOLS), ...Object.values(EXTRA_TOOLS)],
};
const TOOLS = PRESETS[PRESET] ?? PRESETS.standard;

// --- Docker sandbox (same isolation model as bench/run.mjs) ---
const UID = execSync("id -u").toString().trim();
const GID = execSync("id -g").toString().trim();
const startContainer = (sb) =>
  execSync(
    `docker run -d --rm --network none --user ${UID}:${GID} -e HOME=/tmp -v ${sb}:/work -w /work ${IMAGE} sleep 1800`,
    { encoding: "utf8" },
  ).trim();
const dexec = (cid, cmd, ms = 30000) =>
  spawnSync("docker", ["exec", "-w", "/work", cid, "bash", "-lc", cmd], {
    timeout: ms,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
const rmContainer = (cid) => {
  try {
    execSync(`docker rm -f ${cid}`, { stdio: "ignore" });
  } catch {}
};

const OUT = join(process.cwd(), "scripts", "harness", "out");
mkdirSync(OUT, { recursive: true });
const TS = new Date().toISOString().replace(/[:.]/g, "-");

function execTool(name, a, sandbox, cid) {
  try {
    if (name === "bash") {
      const r = dexec(cid, a.command ?? "");
      return `exit=${r.status ?? "null"}\n${r.stdout || ""}${r.stderr ? "\n[stderr]\n" + r.stderr : ""}`.slice(
        0,
        4000,
      );
    }
    if (name === "list") {
      const r = dexec(cid, `ls -la ${a.path ?? "."}`);
      return (r.stdout || r.stderr || "").slice(0, 3000);
    }
    if (name === "glob") {
      const r = dexec(cid, `find ${a.path ?? "."} -name '${(a.pattern ?? "*").replace(/'/g, "")}'`);
      return (r.stdout || "(none)").slice(0, 3000);
    }
    if (name === "grep") {
      const r = dexec(cid, `grep -rn '${(a.pattern ?? "").replace(/'/g, "")}' ${a.path ?? "."}`);
      return (r.stdout || "(no matches)").slice(0, 3000);
    }
    const safe = (p) => {
      const full = join(sandbox, p ?? "");
      if (!full.startsWith(sandbox)) throw new Error("path escapes sandbox");
      return full;
    };
    if (name === "read_file") return readFileSync(safe(a.path), "utf8").slice(0, 6000);
    if (name === "write_file") {
      const f = safe(a.path);
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, a.content ?? "");
      return `wrote ${a.path} (${(a.content || "").length} bytes)`;
    }
    if (name === "edit_file") {
      const f = safe(a.path);
      const cur = readFileSync(f, "utf8");
      if (!cur.includes(a.old)) return `ERROR: 'old' not found in ${a.path}`;
      writeFileSync(f, cur.replace(a.old, a.new));
      return `edited ${a.path}`;
    }
    if (name === "todoread") return "[]";
    if (name === "todowrite") return "ok";
    if (name === "patch")
      return "ERROR: patch tool not supported in this harness; use edit_file/write_file";
    if (name === "webfetch") return "ERROR: network disabled in sandbox";
    if (name === "task")
      return "ERROR: sub-agents disabled; do the work yourself with the other tools";
    return `ERROR: unknown tool ${name}`;
  } catch (e) {
    return `ERROR: ${e.message}`;
  }
}

async function chat(messages) {
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer harness" },
      body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, stream: false }),
    });
    const text = await res.text();
    let j = null;
    try {
      j = JSON.parse(text);
    } catch {}
    // Disengaged = the M365 safety filter refused. The proxy surfaces it as a 502 with
    // type "disengaged" (or the message mentions it). This is the big-prompt death mode.
    const disengaged = res.status === 502 && /disengag/i.test(text);
    if (!res.ok)
      return {
        error: `HTTP ${res.status}: ${(j?.error?.message || text).slice(0, 160)}`,
        disengaged,
      };
    return { json: j, disengaged: false };
  } catch (e) {
    return { error: `fetch: ${e.message}`, disengaged: false };
  }
}

function verify(task, cid, finalAnswer) {
  if (task.expectAnswer) return (finalAnswer || "").includes(task.expectAnswer);
  if (task.verifyCmd) return dexec(cid, task.verifyCmd).status === 0;
  return false;
}

async function runTask(task, rep) {
  const sandbox = mkdtempSync(join(tmpdir(), `hz-${task.name}-`));
  for (const [rel, content] of Object.entries(task.files ?? {})) {
    const f = join(sandbox, rel);
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, content);
  }
  let cid;
  try {
    cid = startContainer(sandbox);
  } catch (e) {
    return {
      task: task.name,
      rep,
      outcome: "SETUP_ERROR",
      solved: false,
      compliedTurn1: false,
      disengaged: false,
      toolTurns: 0,
      msgs: 0,
      elapsedMs: 0,
      error: e.message,
      finalAnswer: "",
    };
  }
  const runId = `${Date.now().toString(36)}-${Math.floor(performance.now())}`;
  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `${task.prompt}\n\n<!-- hz:${runId} -->` },
  ];
  let toolTurns = 0,
    msgs = 0,
    finalAnswer = null,
    endReason = "maxturns",
    error = null,
    disengaged = false,
    compliedTurn1 = false;
  const t0 = Date.now();
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const resp = await chat(messages);
    msgs++;
    if (resp.disengaged) {
      disengaged = true;
      error = resp.error;
      endReason = "disengaged";
      break;
    }
    if (resp.error) {
      error = resp.error;
      endReason = "error";
      break;
    }
    const m = resp.json?.choices?.[0]?.message;
    if (!m) {
      error = "no message";
      endReason = "error";
      break;
    }
    if (m.tool_calls?.length) {
      if (turn === 0) compliedTurn1 = true;
      messages.push({ role: "assistant", content: m.content ?? null, tool_calls: m.tool_calls });
      for (const tc of m.tool_calls) {
        let a = {};
        try {
          a = JSON.parse(tc.function.arguments || "{}");
        } catch {}
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: execTool(tc.function.name, a, sandbox, cid),
        });
        toolTurns++;
      }
    } else {
      finalAnswer = m.content || "";
      endReason = "prose";
      break;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  const solved = verify(task, cid, finalAnswer);
  rmContainer(cid);
  try {
    rmSync(sandbox, { recursive: true, force: true });
  } catch {}
  const outcome = disengaged
    ? "DISENGAGED"
    : solved
      ? "SOLVED"
      : error
        ? "ERROR"
        : endReason === "prose"
          ? compliedTurn1
            ? "WRONG"
            : "GAVE_UP_PROSE"
          : "MAX_TURNS";
  return {
    task: task.name,
    rep,
    outcome,
    solved,
    compliedTurn1,
    disengaged,
    toolTurns,
    msgs,
    elapsedMs: Date.now() - t0,
    error,
    finalAnswer: (finalAnswer || "").slice(0, 120),
  };
}

console.log(
  `[cell] ${LABEL} model=${MODEL} sys=${SYSTEM.length}ch preset=${PRESET}(${TOOLS.length}) tasks=${tasks.map((t) => t.name).join(",")}`,
);
const rows = [];
for (let rep = 0; rep < REPEAT; rep++)
  for (const task of tasks) {
    const r = await runTask(task, rep);
    rows.push(r);
    console.log(
      `  ${r.task.padEnd(13)} ${r.outcome.padEnd(14)} t1=${r.compliedTurn1 ? "Y" : "·"} tools=${r.toolTurns} ${Math.round(r.elapsedMs / 1000)}s ${r.error ? "(" + r.error.slice(0, 60) + ")" : ""}`,
    );
    await new Promise((r) => setTimeout(r, 1200));
  }
const promptSize = SYSTEM_FILE.match(/sys_(\w+)\.txt/)?.[1] || "custom";
const meta = {
  label: LABEL,
  model: MODEL,
  promptSize,
  systemFile: SYSTEM_FILE,
  systemChars: SYSTEM.length,
  toolPreset: PRESET,
  toolCount: TOOLS.length,
  ts: TS,
  rows,
};
writeFileSync(join(OUT, `${LABEL}-${TS}.json`), JSON.stringify(meta, null, 2));
const solved = rows.filter((r) => r.solved).length,
  comp = rows.filter((r) => r.compliedTurn1).length,
  dis = rows.filter((r) => r.disengaged).length;
console.log(
  `[cell] ${LABEL}: solved ${solved}/${rows.length}  turn1-compliance ${comp}/${rows.length}  disengaged ${dis}/${rows.length} → out/${LABEL}-${TS}.json`,
);
