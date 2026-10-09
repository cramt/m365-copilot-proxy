// Aggregate sweep result JSONs into a strategy × task matrix + per-strategy totals.
// Reads scripts/bench/out/<prefix>-*.json (default prefix "s2"). Each file is one
// (task, strategy) cell. Prints outcome per cell and a ranked leaderboard.
//
//   node scripts/bench/analyze-sweep.mjs [prefix] [model]
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PREFIX = process.argv[2] || "s2";
const MODEL = process.argv[3];
const OUT = join(process.cwd(), "scripts", "bench", "out");
const files = readdirSync(OUT).filter((f) => f.startsWith(`${PREFIX}-`) && f.endsWith(".json"));

// Labels are <prefix>-<task>-<strategy> with an optional -rN round suffix.
const TASKS = ["fix-bug", "find-needle", "edit-config", "fizzbuzz", "count-lines"];
const STRATS = [
  "baseline",
  "minimal",
  "recency",
  "fewshot",
  "proof_demand",
  "persona",
  "react",
  "negative",
  "terse",
  "reply_tool",
  "relay",
  "honest",
  "dual_env",
  "dual_env_sys",
  "dual_env_protocol",
  "default",
];

const OUTCOME_GLYPH = { SOLVED: "✔", GAVE_UP_PROSE: "prose", MAX_TURNS: "maxT", ERROR: "ERR" };

const cell = {};
const latest = new Map();
for (const f of files.sort()) {
  let j;
  try {
    j = JSON.parse(readFileSync(join(OUT, f), "utf8"));
  } catch {
    continue;
  }
  if (MODEL && j.model !== MODEL) continue;
  const label = j.label || "";
  latest.set(JSON.stringify([j.model ?? "unknown", label]), j);
}
for (const j of latest.values()) {
  const label = j.label || "";
  const rest = label.slice(PREFIX.length + 1); // "<task>-<strategy>"
  const task = TASKS.find((t) => rest.startsWith(`${t}-`));
  if (!task) continue;
  const strat = rest.slice(task.length + 1).replace(/-r\d+$/, "");
  if (!STRATS.includes(strat)) continue;
  const group = `${j.model ?? "unknown"} / ${strat}`;
  cell[group] ??= {};
  for (const row of j.rows ?? []) {
    const rowTask = row.task ?? task;
    cell[group][rowTask] ??= [];
    cell[group][rowTask].push({ ...row, _disengaged: /diseng/i.test(row.error || "") });
  }
}

const usedTasks = TASKS.filter((t) => Object.values(cell).some((group) => group[t]));
const usedStrategies = Object.keys(cell);
const strategyWidth = Math.max(19, ...usedStrategies.map((group) => group.length + 2));
const pad = (s, n) => String(s).padEnd(n);

console.log(`\n=== Strategy × Task (prefix ${PREFIX}, ${files.length} files) ===\n`);
console.log(
  pad("model / strategy", strategyWidth) +
    usedTasks.map((t) => pad(t, 14)).join("") +
    "  | solved  tools  diseng  max DEA",
);
console.log("-".repeat(strategyWidth + usedTasks.length * 14 + 26));
const board = [];
for (const s of usedStrategies) {
  let solved = 0,
    tools = 0,
    diseng = 0,
    cells = 0;
  let maxDeaScore = null;
  const cols = usedTasks.map((t) => {
    const rows = cell[s][t];
    if (!rows) return pad("·", 14);
    cells += rows.length;
    const wins = rows.filter((row) => row.solved).length;
    const calls = rows.reduce((sum, row) => sum + (row.toolTurns || 0), 0);
    solved += wins;
    tools += calls;
    for (const row of rows) {
      if (row._disengaged) diseng++;
      if (typeof row.maxDeaScore === "number")
        maxDeaScore = Math.max(maxDeaScore ?? 0, row.maxDeaScore);
    }
    const first = rows[0];
    const result =
      rows.length === 1
        ? first.solved
          ? "✔SOLVED"
          : first._disengaged
            ? "✗diseng"
            : OUTCOME_GLYPH[first.outcome] || first.outcome
        : `${wins}/${rows.length}`;
    return pad(`${result}(${calls}t)`, 14);
  });
  board.push({ s, solved, cells, tools, diseng });
  console.log(
    pad(s, strategyWidth) +
      cols.join("") +
      `  | ${solved}/${cells}     ${tools}      ${diseng}      ${maxDeaScore ?? "n/a"}`,
  );
}

console.log(`\n=== Leaderboard (by solved, then fewest disengaged) ===`);
board.sort(
  (a, b) =>
    b.solved / b.cells - a.solved / a.cells ||
    a.diseng / a.cells - b.diseng / b.cells ||
    b.tools - a.tools,
);
let rank = 1;
for (const b of board) {
  console.log(
    `  ${rank++}. ${pad(b.s, 13)} solved ${b.solved}/${b.cells}  disengaged ${b.diseng}  toolcalls ${b.tools}`,
  );
}
console.log("");
