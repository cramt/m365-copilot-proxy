#!/usr/bin/env node
// Real Claude Code and Codex, through copilot-api, against the proxy: small benign
// tasks, one run at a time with a cooldown between runs (each run opens at least
// one M365 conversation — the thread budget, F13). Per run it records:
//   - the outcome, from a verifier (SOLVED / FAIL / DISENGAGED / THROTTLED / TIMEOUT);
//   - from the proxy's debug log: M365 turns, M365 conversations (threads),
//     Disengaged events and the highest dea_violation score (H39a);
//   - through a header-logging shim in front of copilot-api: every request the
//     harness made and, for Claude Code, its x-claude-code-request-class (H39c).
// docs/hypotheses.md §39; setup in docs/claude-code-codex.md.
//
// Needs: the proxy started with M365_DEBUG=1 (reads ~/.config/opencode-m365/
// debug.log, or --proxy-log); copilot-api with a provider "m365" pointing at the
// proxy; `claude` and/or `codex` on PATH; python (fix-bug's verifier).
//
//   node scripts/harness-check.mjs --harness=claude,codex --tasks=fix-bug,find-needle,edit-config
//   node scripts/harness-check.mjs --harness=claude --tasks=web-search          # Claude Code WebSearch
//   node scripts/harness-check.mjs --cooldown=0 ...                              # against gateway-fake-m365.mjs
//
// Prompt arms (H39d): --claude-system-prompt-file=F replaces Claude Code's system
// prompt (--system-prompt-file), --claude-append-system-prompt-file=F appends to it,
// --codex-instructions-file=F replaces Codex's base instructions
// (model_instructions_file). --label=NAME tags the rows and the results file.
//
// The models' commands run on THIS machine, in a throwaway temp dir per run
// (benign tasks, like pi-reliability.sh). A THROTTLED run stops the loop.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { TASKS } from "./bench/tasks.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? "true"] : [a, "true"];
}));
const opt = {
  harness: (args.harness ?? "claude,codex").split(","),
  tasks: (args.tasks ?? "fix-bug,find-needle,edit-config").split(","),
  repeat: Number(args.repeat ?? 1),
  gateway: (args.gateway ?? "http://127.0.0.1:4141").replace(/\/$/, ""),
  model: args.model ?? "m365/claude-sonnet",
  cooldown: Number(args.cooldown ?? 90),
  timeout: Number(args.timeout ?? 300),
  proxyLog: args["proxy-log"] ?? path.resolve(os.homedir(), ".config", "opencode-m365", process.env.M365_LOG_FILE || "debug.log"),
  out: path.resolve(args.out ?? "harness-check-out"),
  // Codex 0.157's workspace-write sandbox refuses every command on Windows
  // ("blocked by policy", even `echo`), so there the runs go unsandboxed, in
  // their temp dir — the same exposure as Claude Code's allowed Bash.
  codexSandbox: args["codex-sandbox"] ?? (process.platform === "win32" ? "bypass" : "workspace-write"),
  recommendedEnv: args["recommended-env"] !== "false",
  shim: args.shim !== "false",
  keep: args.keep === "true",
  label: args.label ?? null,
  claudeSystemPromptFile: args["claude-system-prompt-file"] ? path.resolve(args["claude-system-prompt-file"]) : null,
  claudeAppendSystemPromptFile: args["claude-append-system-prompt-file"] ? path.resolve(args["claude-append-system-prompt-file"]) : null,
  codexInstructionsFile: args["codex-instructions-file"] ? path.resolve(args["codex-instructions-file"]) : null,
};
for (const f of [opt.claudeSystemPromptFile, opt.claudeAppendSystemPromptFile, opt.codexInstructionsFile]) {
  if (f && !fs.existsSync(f)) throw new Error(`prompt file not found: ${f}`);
}

const PYTHON = process.platform === "win32" ? "python" : "python3";
const read = (dir, f) => { try { return fs.readFileSync(path.join(dir, f), "utf8"); } catch { return ""; } };
const pyOut = (dir, file) => {
  try { return execFileSync(PYTHON, [file], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return ""; }
};

// Node verifiers for the bench tasks (their verifyCmd is bash), plus web-search.
const VERIFY = {
  "fix-bug": (dir) => pyOut(dir, "check.py").split(/\r?\n/).includes("OK"),
  "find-needle": (_dir, answer) => answer.includes("ZX42Q7"),
  "edit-config": (dir) => {
    try { const c = JSON.parse(read(dir, "config.json")); return c.port === 8080 && c.name === "app" && c.debug === false; } catch { return false; }
  },
  "ec-notes": (dir) => read(dir, "settings.txt").split(/\r?\n/).includes("port=8080"),
  "ec-plain": (dir) => read(dir, "value.txt").trim() === "8080",
  "ec-create": (dir) => read(dir, "greeting.txt").trim() === "hello world",
  "count-lines": (dir) => read(dir, "count.txt").trim() === "7",
  "web-search": (_dir, answer) => /github\.com\/cramt\/m365-copilot-proxy/i.test(answer),
  "subagent": (_dir, answer) => answer.includes("notes.txt"),
};
const EXTRA_TASKS = [{
  name: "web-search",
  files: {},
  prompt: "Use web search to find the GitHub repository for the open-source project \"m365-copilot-proxy\" by cramt. Reply with just its URL.",
  claudeTools: "Bash,Read,Edit,Write,WebSearch",
}, {
  // H39c: a subagent is a new conversation with its own first message.
  name: "subagent",
  files: { "notes.txt": "hello\n" },
  prompt: "Use a subagent (the Agent tool) to look at the files in this directory and report their names back. Then tell me the file names.",
  claudeTools: "Bash,Read,Edit,Write,Agent",
}];
const CLAUDE_ONLY = new Set(EXTRA_TASKS.map((t) => t.name));
const taskByName = (name) => EXTRA_TASKS.find((t) => t.name === name) ?? TASKS.find((t) => t.name === name);

for (const name of opt.tasks) {
  if (!taskByName(name) || !VERIFY[name]) throw new Error(`no task or Node verifier for "${name}" (have: ${Object.keys(VERIFY).join(", ")})`);
}

/** Run a command with a timeout; Windows needs the whole tree killed. */
function runProcess(cmd, argv, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "", stderr = "", timedOut = false;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: String(e), timedOut }); });
  });
}

/** `codex` is an npm shim; on Windows spawn its JS entry with node instead of codex.cmd. */
function codexCommand() {
  if (process.platform !== "win32") return { cmd: "codex", pre: [] };
  const root = execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "npm root -g"], { encoding: "utf8" }).trim();
  return { cmd: process.execPath, pre: [path.join(root, "@openai", "codex", "bin", "codex.js")] };
}

/** A pass-through proxy in front of copilot-api that records each request's harness headers. */
function startShim(target) {
  const events = [];
  const upstream = new URL(target);
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      let model = null;
      try { model = JSON.parse(body.toString("utf8")).model ?? null; } catch { /* not JSON */ }
      events.push({
        t: Date.now(), method: req.method, path: (req.url ?? "").split("?")[0], model,
        requestClass: req.headers["x-claude-code-request-class"] ?? null,
        agentId: req.headers["x-claude-code-agent-id"] ?? null,
        compaction: req.headers["x-claude-code-compaction"] ?? null,
      });
      const fwd = http.request({
        hostname: upstream.hostname, port: upstream.port, path: req.url, method: req.method,
        headers: { ...req.headers, host: upstream.host },
      }, (up) => { res.writeHead(up.statusCode ?? 502, up.headers); up.pipe(res); });
      fwd.on("error", (e) => { res.writeHead(502, { "content-type": "text/plain" }); res.end(String(e)); });
      fwd.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, events, close: () => server.close(),
  })));
}

const logSize = () => { try { return fs.statSync(opt.proxyLog).size; } catch { return 0; } };
function logSince(offset) {
  try {
    const fd = fs.openSync(opt.proxyLog, "r");
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.alloc(Math.max(0, size - offset));
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch { return ""; }
}

/** What the proxy's debug log says about one run's slice. */
function proxyMetrics(text) {
  const lines = text.split("\n");
  const runs = lines.filter((l) => l.includes("[model] run:"));
  const threads = new Set(runs.map((l) => l.match(/cid=([0-9a-f-]+)/)?.[1]).filter(Boolean));
  const dea = lines.map((l) => l.match(/Turn scores:.*\bdea_violation=([0-9.eE+-]+)/)?.[1]).filter(Boolean).map(Number);
  return {
    m365Turns: runs.length,
    threads: threads.size,
    requests: lines.filter((l) => l.includes("[handler] Chat completion:")).length,
    disengaged: lines.filter((l) => l.includes("Upstream Disengaged")).length,
    throttled: lines.filter((l) => /Upstream Throttled|m365_throttled/.test(l)).length,
    maxDea: dea.length ? Math.max(...dea) : null,
  };
}

function writeFiles(dir, files = {}) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
}

const QUIET_ENV = {
  DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: "false",
  CLAUDE_CODE_ENABLE_AWAY_SUMMARY: "0",
  CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
  CLAUDE_CODE_MAX_RETRIES: "1",
};

async function runClaude(task, dir, base) {
  const env = {
    ANTHROPIC_BASE_URL: base,
    ANTHROPIC_AUTH_TOKEN: "not-needed",
    ANTHROPIC_DEFAULT_HAIKU_MODEL: opt.model,
    CLAUDE_CODE_SUBAGENT_MODEL: opt.model,
    ...(opt.recommendedEnv ? QUIET_ENV : {}),
  };
  const settings = path.join(path.dirname(dir), `${path.basename(dir)}.claude-settings.json`);
  fs.writeFileSync(settings, JSON.stringify({ env }, null, 2));
  const procEnv = { ...process.env, ...env };
  delete procEnv.ANTHROPIC_API_KEY;
  const r = await runProcess("claude", [
    "-p", task.prompt, "--output-format", "json", "--safe-mode",
    "--tools", task.claudeTools ?? "Bash,Read,Edit,Write",
    "--permission-mode", "acceptEdits", "--allowedTools", task.claudeTools ?? "Bash",
    "--model", opt.model, "--settings", settings,
    ...(opt.claudeSystemPromptFile ? ["--system-prompt-file", opt.claudeSystemPromptFile] : []),
    ...(opt.claudeAppendSystemPromptFile ? ["--append-system-prompt-file", opt.claudeAppendSystemPromptFile] : []),
  ], { cwd: dir, env: procEnv, timeoutMs: opt.timeout * 1000 });
  let answer = r.stdout.trim(), harnessTurns = null;
  try {
    const result = JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
    answer = String(result.result ?? "");
    harnessTurns = result.num_turns ?? null;
  } catch { /* not JSON: keep the raw text */ }
  return { ...r, answer, harnessTurns };
}

async function runCodex(task, dir, base) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
  fs.writeFileSync(path.join(home, "config.toml"), [
    `model = ${JSON.stringify(opt.model)}`,
    `model_provider = "m365gw"`,
    `approval_policy = "never"`,
    `web_search = "disabled"`,
    ...(opt.codexInstructionsFile ? [`model_instructions_file = ${JSON.stringify(opt.codexInstructionsFile)}`] : []),
    ``,
    `[model_providers.m365gw]`,
    `name = "m365 via copilot-api"`,
    `base_url = ${JSON.stringify(`${base}/v1`)}`,
    `env_key = "M365_GATEWAY_KEY"`,
    `wire_api = "responses"`,
    `request_max_retries = 1`,
    `stream_max_retries = 1`,
    `stream_idle_timeout_ms = 300000`,
    ``,
    `[analytics]`,
    `enabled = false`,
    ``,
  ].join("\n"));
  const last = path.join(home, "last-message.txt");
  const sandbox = opt.codexSandbox === "bypass"
    ? ["--dangerously-bypass-approvals-and-sandbox"]
    : ["-s", opt.codexSandbox];
  const { cmd, pre } = codexCommand();
  const r = await runProcess(cmd, [...pre,
    "exec", "--skip-git-repo-check", "--json", ...sandbox, "-C", dir, "--output-last-message", last, task.prompt,
  ], { cwd: dir, env: { ...process.env, CODEX_HOME: home, M365_GATEWAY_KEY: "not-needed" }, timeoutMs: opt.timeout * 1000 });
  const answer = read(home, "last-message.txt");
  const harnessTurns = r.stdout.split(/\r?\n/).filter((l) => /"type":"turn\.completed"/.test(l)).length || null;
  if (!opt.keep) fs.rmSync(home, { recursive: true, force: true });
  return { ...r, answer, harnessTurns };
}

function outcomeOf(solved, r, m) {
  if (solved) return "SOLVED";
  const text = `${r.answer}\n${r.stdout}\n${r.stderr}`;
  // m365_throttle_hold: M365_AVOID_THROTTLING answers for the throttle without sending the turn.
  if (m.throttled > 0 || /m365_throttled|m365_throttle_hold|PerUserThrottled/.test(text)) return "THROTTLED";
  if (/\[m365-proxy: disengaged\]/.test(text) || m.disengaged >= 2) return "DISENGAGED";
  if (r.timedOut) return "TIMEOUT";
  return "FAIL";
}

async function preflight() {
  const res = await fetch(`${opt.gateway}/v1/models`).catch((e) => ({ ok: false, statusText: String(e) }));
  if (!res.ok) throw new Error(`copilot-api not answering at ${opt.gateway}: ${res.statusText}`);
  const ids = ((await res.json()).data ?? []).map((m) => m.id);
  if (!ids.includes(opt.model)) console.warn(`[harness-check] warning: ${opt.model} is not in copilot-api's model list (${ids.slice(0, 8).join(", ")}…)`);
  if (!fs.existsSync(opt.proxyLog)) console.warn(`[harness-check] note: no proxy log at ${opt.proxyLog} yet — turns, threads and Disengaged need the proxy started with M365_DEBUG=1`);
}

async function main() {
  await preflight();
  fs.mkdirSync(opt.out, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonl = path.join(opt.out, `runs-${stamp}${opt.label ? `-${opt.label}` : ""}.jsonl`);
  const shim = opt.shim ? await startShim(opt.gateway) : null;
  const base = shim?.url ?? opt.gateway;
  const plan = [];
  for (let i = 0; i < opt.repeat; i++) {
    for (const harness of opt.harness) for (const name of opt.tasks) {
      if (CLAUDE_ONLY.has(name) && harness !== "claude") continue; // Claude Code's own tools
      plan.push({ harness, name });
    }
  }
  console.log(`[harness-check] ${plan.length} runs, model ${opt.model}, cooldown ${opt.cooldown}s, results in ${jsonl}`);
  const rows = [];
  for (const [i, { harness, name }] of plan.entries()) {
    const task = taskByName(name);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `hc-${harness}-${name}-`));
    writeFiles(dir, task.files);
    const offset = logSize();
    const firstEvent = shim?.events.length ?? 0;
    const t0 = Date.now();
    const r = harness === "claude" ? await runClaude(task, dir, base) : await runCodex(task, dir, base);
    await new Promise((res) => setTimeout(res, 1000)); // let the proxy finish writing its log
    const metrics = proxyMetrics(logSince(offset));
    const events = shim ? shim.events.slice(firstEvent).filter((e) => e.method === "POST") : [];
    const classes = {};
    for (const e of events) {
      const k = e.requestClass ?? e.path;
      classes[k] = (classes[k] ?? 0) + 1;
    }
    const solved = VERIFY[name](dir, r.answer);
    const row = {
      run: i + 1, label: opt.label, harness, task: name, outcome: outcomeOf(solved, r, metrics),
      seconds: Math.round((Date.now() - t0) / 1000), harnessTurns: r.harnessTurns, ...metrics,
      harnessRequests: events.length, requestClasses: classes,
      answer: r.answer.slice(0, 300), exitCode: r.code, dir,
    };
    rows.push(row);
    fs.appendFileSync(jsonl, JSON.stringify(row) + "\n");
    console.log(`  [${i + 1}/${plan.length}] ${harness} ${name}: ${row.outcome} in ${row.seconds}s — M365 turns ${metrics.m365Turns}, threads ${metrics.threads}, disengaged ${metrics.disengaged}, max dea ${metrics.maxDea ?? "-"}, harness requests ${events.length} ${JSON.stringify(classes)}`);
    if (row.outcome === "SOLVED" && !opt.keep) fs.rmSync(dir, { recursive: true, force: true });
    else console.log(`      kept ${dir}`);
    if (row.outcome === "THROTTLED") { console.log("[harness-check] THROTTLED — stopping; more runs would only keep the throttle alive"); break; }
    if (i < plan.length - 1 && opt.cooldown > 0) await new Promise((res) => setTimeout(res, opt.cooldown * 1000));
  }
  shim?.close();
  console.log("\n[harness-check] summary");
  for (const harness of opt.harness) {
    const mine = rows.filter((r) => r.harness === harness);
    if (!mine.length) continue;
    const sum = (k) => mine.reduce((a, r) => a + (r[k] ?? 0), 0);
    console.log(`  ${harness}: ${mine.filter((r) => r.outcome === "SOLVED").length}/${mine.length} solved, ` +
      `${mine.filter((r) => r.outcome === "DISENGAGED").length} disengaged runs (${sum("disengaged")} Disengaged turns), ` +
      `${(sum("m365Turns") / mine.length).toFixed(1)} M365 turns and ${(sum("threads") / mine.length).toFixed(1)} threads per run`);
  }
}

main().catch((e) => { console.error(`[harness-check] ${e.message}`); process.exit(1); });
