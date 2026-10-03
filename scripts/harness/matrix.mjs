// Tool-call matrix sweep: for each (model × system-prompt-size × toolset-size), run
// the verifiable tasks through the proxy and record solve / turn-1-compliance /
// disengage. Purpose-built to expose where a BIG SYSTEM PROMPT kills tool-calling.
//
// Starts an in-process proxy (serve.mjs), runs the grid via run-cell.mjs, cleans up.
//
// Config (env, all optional — defaults are SMALL to protect M365 quota):
//   MODELS   default "gpt-5.5-think-deeper"        (comma-sep model ids)
//   PROMPTS  default "none,small,medium,large,huge" (→ prompts/sys_<p>.txt)
//   PRESETS  default "standard"                     (lean|standard|large)
//   TASKS    default "fix-bug"                       (bench task names)
//   REPEAT   default 1
//   PORT     default 4142
//   MAX_TURNS default 8
//
// Cost ≈ (#models × #prompts × #presets) cells × (#tasks × REPEAT) task-runs, each a
// multi-turn tool loop → several M365 messages. Scale deliberately.
//
// Usage: node scripts/harness/matrix.mjs        (small default)
//   MODELS="m365-copilot,gpt-5.5-think-deeper" PROMPTS="none,large,huge" \
//   PRESETS="lean,standard,large" TASKS="fix-bug,edit-config" node scripts/harness/matrix.mjs
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 4142);
const BASE = `http://localhost:${PORT}/v1`;
const MODELS = (process.env.MODELS || "gpt-5.5-think-deeper")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PROMPTS = (process.env.PROMPTS || "none,small,medium,large,huge")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const PRESETS = (process.env.PRESETS || "standard")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const TASKS = process.env.TASKS || "fix-bug";
const REPEAT = process.env.REPEAT || "1";
const MAX_TURNS = process.env.MAX_TURNS || "8";
const san = (s) => s.replace(/[^a-z0-9]+/gi, "-");

const cells = [];
for (const model of MODELS)
  for (const prompt of PROMPTS) for (const preset of PRESETS) cells.push({ model, prompt, preset });
console.log(
  `[matrix] ${cells.length} cells (${MODELS.length} models × ${PROMPTS.length} prompts × ${PRESETS.length} presets), tasks=${TASKS}, repeat=${REPEAT}`,
);
console.log(
  `[matrix] models=${MODELS.join(",")} prompts=${PROMPTS.join(",")} presets=${PRESETS.join(",")}`,
);

// --- start the in-process proxy ---
console.log(`[matrix] starting proxy on :${PORT} ...`);
const serve = spawn("node", [join("scripts", "harness", "serve.mjs"), String(PORT)], {
  stdio: ["ignore", "inherit", "inherit"],
  env: process.env,
});
const health = async () => {
  try {
    const r = await fetch(`http://localhost:${PORT}/health`);
    return r.ok;
  } catch {
    return false;
  }
};
let up = false;
for (let i = 0; i < 60; i++) {
  if (await health()) {
    up = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!up) {
  console.error("[matrix] proxy did not come up");
  serve.kill("SIGKILL");
  process.exit(1);
}
console.log("[matrix] proxy healthy\n");

let done = 0;
for (const { model, prompt, preset } of cells) {
  const label = `mx_${san(model)}_${prompt}_${preset}`;
  console.log(
    `\n[matrix] cell ${++done}/${cells.length}: model=${model} prompt=${prompt} preset=${preset}`,
  );
  spawnSync(
    "node",
    [
      join("scripts", "harness", "run-cell.mjs"),
      "--base-url",
      BASE,
      "--model",
      model,
      "--system",
      join("scripts", "harness", "prompts", `sys_${prompt}.txt`),
      "--tool-preset",
      preset,
      "--tasks",
      TASKS,
      "--repeat",
      REPEAT,
      "--max-turns",
      MAX_TURNS,
      "--label",
      label,
    ],
    { stdio: "inherit", env: process.env },
  );
  await new Promise((r) => setTimeout(r, 2500)); // pace between cells (throttle-friendly)
}

serve.kill("SIGKILL");
console.log(`\n[matrix] done. Analyze with: node scripts/harness/analyze-matrix.mjs`);
