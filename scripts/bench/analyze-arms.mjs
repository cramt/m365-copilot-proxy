// Per-arm forensics for sweep archives (phase-sweep.sh, sonnet5-sweep.sh): what
// each arm scored AND what happened on the wire. A scorecard alone can't tell
// "the framing failed" from "the model worked in its own sandbox", "the agent
// was dropped", "Disengaged" or "the network was down". This reads each arm's
// debug log and frame dumps too, maps them onto the arm's tasks, and drops runs
// that measured the infrastructure instead of the arm.
//
//   node scripts/bench/analyze-arms.mjs <archive-dir>... [--rows]
//        [--compare 'relay,default@agent-less' 'demo_only@agent-less']...
//
// Several dirs pool together, e.g. one sweep per account; labels keep the dir.
//
// Per arm, from the archive:
//   bench rows    <label>.json (phase-sweep copies it) or <label>-bench.txt
//   pi runs       <label>.csv / pi-<label>.csv, and failed runs' pi.out
//   wire          <label>-debug.log (M365_DEBUG=1) + <label>-frames/ (M365_DUMP_FRAMES=1)
//   arm, env      manifest.tsv (phase-sweep); otherwise the arm is the label's last part
//
// Each task (bench row or pi run) is matched to one conversation in the debug log,
// in order. A conversation starts at a `mode=full` request whose cid is new; a
// client re-sending the same first request stays in the same one. From it:
//   path      `agent` or `agent-less`: whether the LAST request carried the tool
//             agent, i.e. the path that served the result (a dead-route fallback
//             to agent-less counts as agent-less, and is flagged `fb`)
//   sandbox   turns with a "Coding and executing" Progress frame: the model ran
//             commands in its own remote sandbox. Don't count
//             `contentOrigin: CodeGenerator` instead; most such turns lack it.
//   diseng / jb  turns with a Disengaged message / a JailBreakClassifier origin
// If the number of conversations doesn't match the number of tasks, the arm's
// wire totals still print but its rows get path `?`.
//
// A task is INVALID (left out of every score) when it failed because of the
// infrastructure: its error is a transport failure or a throttle (WebSocket /
// connection / 429 / m365_throttled); or its conversation logged a network-level
// WS error or a Throttled turn; or it timed out in an arm whose log shows network
// failures elsewhere (a stalled connect leaves no error of its own). A solved
// task is always valid. Plain client timeouts in a healthy arm stay failures.
//
// --compare A B: Fisher's exact test (two-sided) on solved/valid between two
// selections. A selection is ARM[,ARM...][@agent|@agent-less], e.g. `relay,default`
// pools the two arm names; `@agent-less` keeps only tasks served agent-less.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PI_TASKS = ["fix-bug", "multi", "edit-config"];
const TRANSPORT = /WebSocket error|connection failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|m365_throttled|HTTP 429/i;
// A WS error the network caused. Not "closed before the connection was
// established": that's the proxy aborting a turn because the client gave up.
const NETWORK_WS_ERROR = /WS error: (connection failed|.*(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|getaddrinfo))/;

// --- discovery ---------------------------------------------------------------

function readManifest(dir) {
  const f = join(dir, "manifest.tsv");
  if (!existsSync(f)) return null;
  const [head, ...lines] = readFileSync(f, "utf8").trim().split("\n");
  const cols = head.split("\t");
  return lines.filter(Boolean).map((l) => Object.fromEntries(l.split("\t").map((v, i) => [cols[i], v])));
}

/** Arms in an archive: from manifest.tsv, else inferred from file names (older archives). */
export function discoverArms(dir) {
  const manifest = readManifest(dir);
  if (manifest) return manifest.map((m) => ({ dir, label: m.label, arm: m.arm, env: m.env || "", kind: m.kind }));
  const arms = [];
  for (const f of readdirSync(dir).sort()) {
    if (f.startsWith("pre-")) continue;
    let m;
    if ((m = f.match(/^(.*)-bench\.txt$/))) {
      const label = m[1];
      arms.push({ dir, label, arm: label.match(/-\d+-([A-Za-z0-9_]+)$/)?.[1] ?? label, env: "", kind: "bench" });
    } else if ((m = f.match(/^pi-(.*)\.csv$/))) {
      const label = m[1];
      const task = PI_TASKS.find((t) => label.endsWith(`-${t}`));
      arms.push({ dir, label, arm: `pi=${task ?? "?"}`, env: "", kind: "pi", csv: f });
    }
  }
  return arms;
}

// --- tasks -------------------------------------------------------------------

/** Bench rows from the JSON the bench wrote, else parsed from its console scorecard. */
function benchRows(dir, label) {
  const json = join(dir, `${label}.json`);
  if (existsSync(json)) {
    return JSON.parse(readFileSync(json, "utf8")).rows.map((r) => ({
      task: r.task, outcome: r.outcome, solved: !!r.solved, error: r.error || "",
    }));
  }
  const txt = join(dir, `${label}-bench.txt`);
  if (!existsSync(txt)) return [];
  const rows = [];
  for (const line of readFileSync(txt, "utf8").split("\n")) {
    const m = line.match(/^ {2}(\S+)\s+(SOLVED|GAVE_UP_PROSE|MAX_TURNS|ERROR)\s+tools=\d+ msgs=\d+ \d+s\s?(.*)$/);
    if (m) rows.push({ task: m[1], outcome: m[2], solved: m[2] === "SOLVED", error: m[2] === "ERROR" ? m[3].replace(/\s*answer=.*$/, "") : "" });
  }
  return rows;
}

/** pi runs from the CSV; a failed run's error is the tail of its pi.out, if kept. */
function piRows(dir, a) {
  const csv = join(dir, a.csv ?? `${a.label}.csv`);
  if (!existsSync(csv)) return [];
  const task = a.arm.replace(/^pi=/, "");
  return readFileSync(csv, "utf8").trim().split("\n").slice(1).filter(Boolean).map((l) => {
    const [run, , outcome, , runDir] = l.split(",");
    let error = "";
    if (outcome !== "SOLVED") {
      for (const f of [join(dir, `${a.label}-run${run}-pi.out`), join(runDir ?? "", "pi.out")]) {
        try { error = readFileSync(f, "utf8").trim().slice(-300); break; } catch { /* not kept */ }
      }
    }
    return { task: `${task}#${run}`, outcome, solved: outcome === "SOLVED", error };
  });
}

// --- wire --------------------------------------------------------------------

const emptyWire = () => ({ runs: [], cids: new Set(), corr: [], fallback: 0, internalError: 0, throttled: 0, wsError: 0, disengagedRetry: 0 });

/** Split an arm's debug log into conversations (see the header). */
export function conversations(log) {
  const convs = [];
  let cur = null;
  for (const line of log.split("\n")) {
    const cc = line.match(/\[handler\] Chat completion: .*mode=(\w+), cid=([0-9a-f-]+)/);
    if (cc) {
      if (cc[1] === "full" && !(cur && cur.cids.has(cc[2]))) { cur = emptyWire(); convs.push(cur); }
      cur?.cids.add(cc[2]);
      continue;
    }
    if (!cur) continue;
    let m;
    if ((m = line.match(/\[model\] run: model=\S+, agent=(\S+?), turn=\d+, sid=\S+, cid=([0-9a-f-]+)/))) {
      cur.runs.push(m[1] !== "none");
      cur.cids.add(m[2]);
    } else if ((m = line.match(/WS send: .*"clientCorrelationId":"([0-9a-f-]+)"/))) {
      cur.corr.push(m[1]);
    } else if (line.includes("Agent route dead")) cur.fallback++;
    else if (line.includes("Turn result: InternalError")) cur.internalError++;
    else if (/Upstream Throttled|Turn result: Throttled/.test(line)) cur.throttled++;
    else if (NETWORK_WS_ERROR.test(line)) cur.wsError++;
    else if (line.includes("Upstream Disengaged")) cur.disengagedRetry++;
  }
  return convs;
}

/** Per-turn frame verdicts, keyed by clientCorrelationId (= frame file name). */
function frameFlags(framesDir) {
  const flags = new Map();
  if (!existsSync(framesDir) || !statSync(framesDir).isDirectory()) return flags;
  for (const f of readdirSync(framesDir)) {
    if (!f.endsWith(".ndjson")) continue;
    const t = readFileSync(join(framesDir, f), "utf8");
    flags.set(f.slice(0, -7), {
      sandbox: t.includes("Coding and executing"),
      disengaged: t.includes('"messageType":"Disengaged"'),
      jailbreak: t.includes("JailBreakClassifier"),
    });
  }
  return flags;
}

// --- one arm -----------------------------------------------------------------

export function analyzeArm(a) {
  const rows = a.kind === "pi" ? piRows(a.dir, a) : benchRows(a.dir, a.label);
  const logFile = join(a.dir, `${a.label}-debug.log`);
  const convs = existsSync(logFile) ? conversations(readFileSync(logFile, "utf8")) : [];
  const frames = frameFlags(join(a.dir, `${a.label}-frames`));
  const mapped = convs.length === rows.length;
  const wire = { turns: 0, agent: 0, agentless: 0, sandbox: 0, disengaged: 0, jailbreak: 0, internalError: 0, fallback: 0, wsError: 0, throttled: 0 };
  convs.forEach((c, i) => {
    const turnFlags = c.corr.map((id) => frames.get(id)).filter(Boolean);
    const w = {
      turns: c.runs.length,
      agent: c.runs.filter(Boolean).length,
      agentless: c.runs.filter((x) => !x).length,
      sandbox: turnFlags.filter((x) => x.sandbox).length,
      disengaged: turnFlags.filter((x) => x.disengaged).length,
      jailbreak: turnFlags.filter((x) => x.jailbreak).length,
      internalError: c.internalError, fallback: c.fallback, wsError: c.wsError, throttled: c.throttled,
    };
    for (const k of Object.keys(wire)) wire[k] += w[k];
    if (mapped) {
      rows[i].wire = w;
      rows[i].path = c.runs.length ? (c.runs.at(-1) ? "agent" : "agent-less") : "?";
    }
  });
  for (const r of rows) {
    r.path ??= "?";
    const w = r.wire;
    r.invalid = r.solved ? null
      : TRANSPORT.test(r.error) ? (/429|throttl/i.test(r.error) ? "throttled" : "transport")
      : w?.throttled ? "throttled"
      : w?.wsError ? "transport"
      : wire.wsError && /timeout|timed out/i.test(r.error) ? "transport?"
      : null;
  }
  return { ...a, rows, wire, mapped, convs: convs.length, hasLog: existsSync(logFile) };
}

// --- statistics --------------------------------------------------------------

const logFact = (() => { const t = [0]; return (n) => { for (let i = t.length; i <= n; i++) t[i] = t[i - 1] + Math.log(i); return t[n]; }; })();

/** Fisher's exact test, two-sided, for [[a, b], [c, d]]. */
export function fisherExact(a, b, c, d) {
  const r1 = a + b, r2 = c + d, c1 = a + c, n = r1 + r2;
  const p = (x) => Math.exp(logFact(r1) + logFact(r2) + logFact(c1) + logFact(n - c1) - logFact(n) - logFact(x) - logFact(r1 - x) - logFact(c1 - x) - logFact(r2 - c1 + x));
  const p0 = p(a);
  let sum = 0;
  for (let x = Math.max(0, c1 - r2); x <= Math.min(r1, c1); x++) { const px = p(x); if (px <= p0 * (1 + 1e-7)) sum += px; }
  return Math.min(1, sum);
}

/** Valid tasks matching a selection like `relay,default@agent-less`. */
export function select(arms, spec) {
  const [names, path] = spec.split("@");
  const want = new Set(names.split(",").map((s) => s.trim()).filter(Boolean));
  return arms.filter((a) => want.has(a.arm)).flatMap((a) => a.rows).filter((r) => !r.invalid && (!path || r.path === path));
}

// --- report ------------------------------------------------------------------

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);
const score = (rows) => { const v = rows.filter((r) => !r.invalid); return `${v.filter((r) => r.solved).length}/${v.length}`; };
const pathOf = (rows) => {
  const agent = rows.filter((r) => r.path === "agent").length, less = rows.filter((r) => r.path === "agent-less").length;
  return !agent && !less ? "?" : !less ? "agent" : !agent ? "agent-less" : `mixed ${agent}/${less}`;
};
const fmtP = (p) => (p >= 0.001 ? p.toFixed(3) : p.toExponential(1));

function report(arms, { rows: showRows, compares }) {
  console.log(`${pad("arm", 16)} ${pad("path", 13)} ${lpad("solved", 7)} ${lpad("inv", 4)} | ${["turns", "agent", "noagt", "sandbx", "diseng", "jb", "IE", "fb", "ws", "thr"].map((h) => lpad(h, 7)).join("")} | label`);
  for (const a of arms) {
    const w = a.wire;
    const inv = a.rows.filter((r) => r.invalid).length;
    const armName = a.env ? `${a.arm} [${a.env}]` : a.arm;
    console.log(`${pad(armName, 16)} ${pad(pathOf(a.rows), 13)} ${lpad(score(a.rows), 7)} ${lpad(inv || "", 4)} | ${[w.turns, w.agent, w.agentless, w.sandbox, w.disengaged, w.jailbreak, w.internalError, w.fallback, w.wsError, w.throttled].map((x) => lpad(x || "·", 7)).join("")} | ${basename(a.dir)}/${a.label}${!a.hasLog ? "  (no debug log)" : a.mapped ? "" : `  (rows↔log mismatch: ${a.rows.length} tasks, ${a.convs} conversations)`}`);
    if (showRows) {
      for (const r of a.rows) {
        const w = r.wire;
        const flags = w ? [w.sandbox && `sandbox ${w.sandbox}`, w.disengaged && `diseng ${w.disengaged}`, w.fallback && "fb", w.internalError && `IE ${w.internalError}`].filter(Boolean).join(", ") : "";
        console.log(`    ${pad(r.task, 14)} ${pad(r.outcome, 14)} ${pad(r.path, 11)} ${r.invalid ? `INVALID(${r.invalid}) ` : ""}${flags}${r.error && !r.solved ? `  ${JSON.stringify(r.error.slice(0, 80))}` : ""}`);
      }
    }
  }

  // Pooled by arm name × the path that served each task.
  const groups = new Map();
  for (const a of arms) for (const r of a.rows) {
    const key = `${a.arm}\t${r.path}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  console.log(`\n=== pooled: arm × path (invalid tasks excluded) ===`);
  for (const [key, rs] of [...groups].sort()) {
    const [arm, path] = key.split("\t");
    const v = rs.filter((r) => !r.invalid);
    const sandbox = v.reduce((s, r) => s + (r.wire?.sandbox ?? 0), 0);
    const turns = v.reduce((s, r) => s + (r.wire?.turns ?? 0), 0);
    console.log(`  ${pad(arm, 16)} ${pad(path, 11)} ${lpad(score(rs), 7)}   sandbox turns ${sandbox}/${turns}${rs.length > v.length ? `   (${rs.length - v.length} invalid)` : ""}`);
  }

  for (const [x, y] of compares) {
    const A = select(arms, x), B = select(arms, y);
    const as = A.filter((r) => r.solved).length, bs = B.filter((r) => r.solved).length;
    console.log(`\ncompare  ${x}: ${as}/${A.length}   vs   ${y}: ${bs}/${B.length}   Fisher two-sided p = ${fmtP(fisherExact(as, A.length - as, bs, B.length - bs))}`);
  }
}

function main(argv) {
  const dirs = [], compares = [];
  let rows = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--rows") rows = true;
    else if (argv[i] === "--compare") { compares.push([argv[i + 1], argv[i + 2]]); i += 2; }
    else if (argv[i] === "-h" || argv[i] === "--help") { console.log(readFileSync(new URL(import.meta.url), "utf8").split("\nimport ")[0]); return; }
    else dirs.push(resolve(argv[i]));
  }
  if (!dirs.length) { console.error("usage: analyze-arms.mjs <archive-dir>... [--rows] [--compare A B]..."); process.exit(1); }
  if (compares.some((c) => !c[0] || !c[1])) { console.error("--compare needs two selections"); process.exit(1); }
  const arms = dirs.flatMap(discoverArms).map(analyzeArm);
  if (!arms.length) { console.error(`no arms found in ${dirs.join(", ")}`); process.exit(1); }
  report(arms, { rows, compares });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
