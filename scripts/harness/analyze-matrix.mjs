// Aggregate harness cell outputs into a readable grid: for each model, a
// (prompt-size × toolset) table of turn-1 tool-call COMPLIANCE / SOLVE / DISENGAGE.
// Surfaces the core question — at what system-prompt size does tool-calling die?
//
//   node scripts/harness/analyze-matrix.mjs [labelPrefix]   (default "mx_")
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PREFIX = process.argv[2] || "mx_";
const OUT = join(process.cwd(), "scripts", "harness", "out");
const PSORT = { none: 0, small: 1, medium: 2, large: 3, huge: 4, custom: 5 };
const files = readdirSync(OUT).filter((f) => f.startsWith(PREFIX) && f.endsWith(".json"));
if (!files.length) {
  console.log(`no cell files matching ${PREFIX}* in ${OUT}`);
  process.exit(0);
}

// Keep the latest file per (model,prompt,preset).
const cells = new Map();
for (const f of files) {
  const m = JSON.parse(readFileSync(join(OUT, f), "utf8"));
  const key = `${m.model}|${m.promptSize}|${m.toolPreset}`;
  const prev = cells.get(key);
  if (!prev || m.ts > prev.ts) cells.set(key, m);
}
const all = [...cells.values()];
const models = [...new Set(all.map((c) => c.model))];
const presets = [...new Set(all.map((c) => c.toolPreset))].sort();
const prompts = [...new Set(all.map((c) => c.promptSize))].sort(
  (a, b) => (PSORT[a] ?? 9) - (PSORT[b] ?? 9),
);

const agg = (rows, pred) =>
  rows.length ? Math.round((rows.filter(pred).length / rows.length) * 100) : null;
const cellStat = (c) => ({
  n: c.rows.length,
  comply: agg(c.rows, (r) => r.compliedTurn1),
  solve: agg(c.rows, (r) => r.solved),
  diseng: agg(c.rows, (r) => r.disengaged),
  chars: c.systemChars,
});
const fmt = (s) =>
  s
    ? `c${String(s.comply).padStart(3)} s${String(s.solve).padStart(3)} d${String(s.diseng).padStart(3)}`
    : "    –     ";

for (const model of models) {
  console.log(
    `\n=== ${model} ===   (cNNN=turn-1 tool-call compliance%, sNNN=solve%, dNNN=disengage%)`,
  );
  const head = "prompt (chars)".padEnd(16) + presets.map((p) => p.padEnd(11)).join(" ");
  console.log(head);
  console.log("-".repeat(head.length));
  for (const prompt of prompts) {
    const first = all.find((c) => c.model === model && c.promptSize === prompt);
    const chars = first ? first.systemChars : "?";
    let line = `${prompt} (${chars})`.padEnd(16);
    for (const preset of presets) {
      const c = all.find(
        (x) => x.model === model && x.promptSize === prompt && x.toolPreset === preset,
      );
      line += (c ? fmt(cellStat(c)) : "    –     ") + " ";
    }
    console.log(line);
  }
}

// Death-curve callout: per (model,preset), the smallest prompt size where turn-1
// compliance first drops below 100% or disengage appears.
console.log(`\n=== compliance death curve (first prompt size where tool-calling breaks) ===`);
for (const model of models)
  for (const preset of presets) {
    const series = prompts
      .map((p) =>
        all.find((c) => c.model === model && c.promptSize === p && c.toolPreset === preset),
      )
      .filter(Boolean)
      .map((c) => ({ p: c.promptSize, chars: c.systemChars, ...cellStat(c) }));
    if (!series.length) continue;
    const broke = series.find((s) => (s.comply != null && s.comply < 100) || (s.diseng ?? 0) > 0);
    const tag = broke
      ? `BREAKS at "${broke.p}" (${broke.chars} chars): comply=${broke.comply}% disengage=${broke.diseng}%`
      : `holds across all tested sizes (max ${series[series.length - 1].chars} chars)`;
    console.log(`  ${model} / ${preset}: ${tag}`);
  }
console.log(`\n(${all.length} cells, ${files.length} files)`);
