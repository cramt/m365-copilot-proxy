// RE probe: how much can M365 Copilot EMIT in a single turn?
//
// Hypothesis (mine): `streamingMode: "ConciseWithPadding"` (hardcoded in
// copilot.ts/session.ts) silently caps output length. A coding agent that
// can't emit a 400-line file is unusable regardless of everything else.
//
// Method: ask for a deterministic, countable payload ("integers 1..N, one per
// line"). Parse the reply, find the highest contiguous integer actually
// returned, and total chars. If actual << requested, output is capped — and we
// learn WHERE. Then (optionally) sweep streamingMode to see if a different mode
// lifts the cap.
//
// Plain chat (no agent) by default — isolates raw generation capacity from
// tool-calling. Add --agent to measure the realistic agent-on capacity.
//
// Usage:
//   M365_NO_INTERACTIVE=1 CHROMIUM_PATH=$(which chromium) \
//     node scripts/output-ceiling-probe.mjs [--agent] [--targets 200,1000,4000]
//     [--sweep-modes] [--target-for-sweep 4000]
//
// Cost: one message per (target × mode). Default ~5 messages.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getToken, getOrCreateAgent, decodeJwt } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

const args = process.argv.slice(2);
const has = (k) => args.includes(k);
const val = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const USE_AGENT = has("--agent");
const TARGETS = val("--targets", "200,1000,2500,5000").split(",").map(Number);
const SWEEP_MODES = has("--sweep-modes");
const SWEEP_TARGET = Number(val("--target-for-sweep", String(Math.max(...TARGETS))));
// Candidate streamingMode values to try. "ConciseWithPadding" is current.
const MODES = ["ConciseWithPadding", "Balanced", "Verbose", "Full", "None"];

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "output-ceiling-out", TS);
mkdirSync(OUT, { recursive: true });

console.log(`[out-probe] out=${OUT}`);
const token = await getToken();
const claims = decodeJwt(token);
let agentId = null;
if (USE_AGENT) {
  agentId = await getOrCreateAgent();
  console.log(`[out-probe] agent=${agentId}`);
}

// A request that forces a long, trivially-countable output. We instruct "no
// commentary" so prose padding doesn't inflate the count.
function makePrompt(n) {
  return `Output every integer from 1 to ${n}, one per line, in order, with nothing else — no preamble, no commentary, no code fence. Begin with 1 and end with ${n}.`;
}

// Find the highest integer reached as a CONTIGUOUS run from 1, plus raw stats.
function analyze(textRaw) {
  const text = textRaw ?? "";
  const nums = (text.match(/\d+/g) ?? []).map(Number);
  // highest contiguous run starting from 1
  const present = new Set(nums);
  let contiguous = 0;
  while (present.has(contiguous + 1)) contiguous++;
  return {
    chars: text.length,
    lines: text.split("\n").length,
    distinctIntsSeen: present.size,
    maxIntSeen: nums.length ? Math.max(...nums) : 0,
    contiguousTo: contiguous,
    tailSample: text.slice(-160),
  };
}

const results = [];

async function run(target, mode) {
  const prompt = makePrompt(target);
  const r = await oneTurn({ token, claims, text: prompt, agentId, streamingMode: mode });
  const a = analyze(r.fullText);
  const row = {
    target,
    mode,
    agent: USE_AGENT,
    ...a,
    reached_pct: target ? Math.round((a.contiguousTo / target) * 100) : 0,
    truncated: a.contiguousTo < target,
    disengaged: r.disengaged,
    messageTypes: r.messageTypes,
    contentOrigin: r.contentOrigin,
    dea: r.scores?.dea_violation ?? null,
    throttle: r.throttle,
    serviceVersion: r.serviceVersion,
    elapsedMs: r.elapsedMs,
    error: r.error,
  };
  results.push(row);
  const errorPrefix = "ERR=";
  console.log(
    `[out-probe] target=${target} mode=${mode} → contiguousTo=${a.contiguousTo} (${row.reached_pct}%) ` +
    `chars=${a.chars} maxInt=${a.maxIntSeen} disengaged=${r.disengaged} ` +
    `${r.error ? errorPrefix + r.error : ""} ${r.elapsedMs}ms`,
  );
  if (a.contiguousTo < target)
    console.log(`           tail: …${a.tailSample.replace(/\n/g, "\\n").slice(-100)}`);
  return row;
}

// 1) Sweep targets at the default mode.
for (const t of TARGETS) {
  await run(t, "ConciseWithPadding");
}

// 2) Optionally sweep modes at a fixed (large) target.
if (SWEEP_MODES) {
  console.log(`\n[out-probe] --- streamingMode sweep at target=${SWEEP_TARGET} ---`);
  for (const m of MODES) {
    if (m === "ConciseWithPadding") continue; // already covered above if in TARGETS
    await run(SWEEP_TARGET, m);
  }
}

writeFileSync(
  join(OUT, "results.json"),
  JSON.stringify(
    {
      meta: {
        agent: USE_AGENT,
        targets: TARGETS,
        sweepModes: SWEEP_MODES,
        sweepTarget: SWEEP_TARGET,
        ts: TS,
      },
      results,
    },
    null,
    2,
  ),
);

// Verdict
const def = results
  .filter((r) => r.mode === "ConciseWithPadding")
  .sort((a, b) => a.target - b.target);
const firstTrunc = def.find((r) => r.truncated);
console.log(`\n[out-probe] === VERDICT (mode=ConciseWithPadding) ===`);
for (const r of def)
  console.log(`  ${r.target}: reached ${r.contiguousTo} (${r.reached_pct}%) chars=${r.chars}`);
if (firstTrunc) {
  console.log(
    `[out-probe] OUTPUT CAP: first truncation at target=${firstTrunc.target}, capped near ${firstTrunc.contiguousTo} ints / ${firstTrunc.chars} chars (~${Math.round(firstTrunc.chars / 4)} tokens).`,
  );
} else {
  console.log(
    `[out-probe] No truncation up to target=${Math.max(...def.map((r) => r.target))}. Output capacity exceeds that.`,
  );
}
console.log(`[out-probe] full output: ${OUT}`);
