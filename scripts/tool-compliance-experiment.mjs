// Tool-call compliance A/B harness. For each (variant) × (prompt) we send a
// fresh conversation and score the response on whether the model produced a
// clean tool call. Designed to answer: which prompt levers actually move
// compliance, and how badly does the Disengaged filter trip as we change them?
//
// Variants tested:
//   baseline       — current prompt as-shipped
//   no_caps        — strip the ALL-CAPS rules (softer wording)
//   no_fewshot     — skip the few-shot
//   with_reply     — inject synthetic reply() tool; "always call a tool" rule
//   minimal        — agent does everything; per-request prompt is just <tools>
//   tool_choice_req — current prompt + tool_choice: "required"
//
// Run unsandboxed inside `nix develop --command`.
//   M365_NO_INTERACTIVE=1 node scripts/tool-compliance-experiment.mjs [--variants a,b] [--no-agent]
//
// Costs roughly N_variants * N_prompts M365 messages (each = fresh conversation).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ModelSession,
  parseToolCalls,
  formatToolDefinitions,
} from "../packages/core/dist/index.mjs";

const args = process.argv.slice(2);
const arg = (k, def = null) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const useAgent = !args.includes("--no-agent");
const VARIANTS_FILTER = (arg("--variants", "") || "").split(",").filter(Boolean);
// Number of independent runs per (variant, prompt) cell. n=1 gives directional
// signal only — for any claim about latency or marginal compliance moves, use
// n>=3 and read variance from the per-run output.
const REPEAT = Math.max(1, parseInt(arg("--repeat", "1"), 10));

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "tool-compliance-out", TS);
mkdirSync(OUT, { recursive: true });

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file from disk",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute path" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list",
      description: "List a directory",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

const REPLY_TOOL = {
  type: "function",
  function: {
    name: "reply",
    description:
      "Send a plain text answer to the user. Use this whenever you would otherwise answer in prose.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
};

const PROMPTS = [
  { q: "Read the file /etc/hostname and tell me the hostname.", expect: "read_file" },
  { q: "List the files in /tmp.", expect: "list" },
  { q: "Run `uname -a` and tell me the kernel.", expect: "bash" },
  { q: "What is 7*8? Reply with just the number.", expect: null }, // pure-prose case
  { q: "What's the largest planet in our solar system?", expect: null },
];

// --- Build the per-variant prompt body ---
function formatVariant(variant, messages) {
  const userMsg = messages[messages.length - 1].content;

  if (variant === "baseline") {
    const tools = TOOLS;
    return formatToolDefinitions(tools) + `\n\n<user>\n${userMsg}\n</user>`;
  }

  if (variant === "no_caps") {
    // Soft-toned variant of the standard prompt
    const defs = TOOLS.map((t) =>
      JSON.stringify(
        {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
        null,
        2,
      ),
    ).join("\n\n");
    return `You are an agent driving real tools. Each tool runs against a real system. When a tool can do the job, call it. Otherwise answer in prose.

To call a tool, output only this JSON:
{"tool": "<tool_name>", "arguments": { ... }}

One tool call per turn, then wait for the <tool_response>.

<tools>
${defs}
</tools>

<user>
${userMsg}
</user>`;
  }

  if (variant === "no_fewshot") {
    // formatToolDefinitions doesn't include a few-shot directly — but our
    // production proxy adds one via tools.ts's formatMessages. This variant
    // uses ONLY the definitions, no example.
    return formatToolDefinitions(TOOLS) + `\n\n<user>\n${userMsg}\n</user>`;
  }

  if (variant === "with_reply") {
    const tools = [REPLY_TOOL, ...TOOLS];
    const body = formatToolDefinitions(tools);
    return (
      body +
      `

EVERY turn MUST be a tool call. If your answer would otherwise be plain prose, call reply(text="...") with the prose as the text argument. Never emit bare text.

<user>
${userMsg}
</user>`
    );
  }

  if (variant === "minimal") {
    // Trust the agent to enforce the format; per-request prompt is just tools + user msg.
    const defs = TOOLS.map((t) =>
      JSON.stringify(
        {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
        null,
        2,
      ),
    ).join("\n\n");
    return `<tools>\n${defs}\n</tools>\n\n<user>\n${userMsg}\n</user>`;
  }

  if (variant === "tool_choice_req") {
    return (
      formatToolDefinitions(TOOLS) +
      `\nYou MUST call at least one tool.\n\n<user>\n${userMsg}\n</user>`
    );
  }

  throw new Error(`unknown variant: ${variant}`);
}

const VARIANT_NAMES = [
  "baseline",
  "no_caps",
  "no_fewshot",
  "with_reply",
  "minimal",
  "tool_choice_req",
];
const VARIANTS = VARIANTS_FILTER.length
  ? VARIANT_NAMES.filter((v) => VARIANTS_FILTER.includes(v))
  : VARIANT_NAMES;

function classify(raw, expect) {
  const parsed = parseToolCalls(raw);
  const got = parsed.hasToolCalls ? parsed.toolCalls[0].function.name : null;
  const stray = (parsed.textContent || "").trim().length;
  const disengaged = raw.length === 0;
  if (disengaged) return "DISENGAGED";
  if (expect === null) {
    if (!parsed.hasToolCalls) return "OK_PROSE";
    if (got === "reply") return "OK_REPLY"; // counts as compliant for with_reply variant
    return `FALSE_TOOL(${got})`;
  }
  if (!parsed.hasToolCalls) return "MISS_PROSE";
  if (got !== expect) return `WRONG_TOOL(${got})`;
  return stray > 0 ? `OK_TOOL+stray(${stray})` : "OK_TOOL_CLEAN";
}

const results = {};
const start = Date.now();
let total = 0;
let disengaged = 0;

for (const variant of VARIANTS) {
  results[variant] = [];
  for (const p of PROMPTS) {
    for (let rep = 0; rep < REPEAT; rep++) {
      total++;
      const session = new ModelSession({ useAgent });
      let raw = "";
      let throttle = null;
      let scores = null;
      let contentOrigin = null;
      const t0 = Date.now();
      try {
        const stream = await session.run(
          formatVariant(variant, [{ role: "user", content: p.q }]),
          "m365-copilot",
        );
        for await (const d of stream) raw += d;
        if (stream.fullText.length > raw.length) raw = stream.fullText;
        throttle = stream.throttle;
        scores = stream.scores;
        contentOrigin = stream.contentOrigin;
      } catch (e) {
        raw = `<error: ${e.message}>`;
      }
      const verdict = classify(raw, p.expect);
      if (verdict === "DISENGAGED") disengaged++;
      const elapsed = Date.now() - t0;
      const summary = {
        q: p.q,
        expect: p.expect,
        rep,
        verdict,
        elapsed_ms: elapsed,
        throttle,
        scores,
        contentOrigin,
        len: raw.length,
        raw: raw.slice(0, 240).replace(/\n/g, "\\n"),
      };
      results[variant].push(summary);
      const dea = scores?.dea_violation;
      const deaStr = typeof dea === "number" ? ` dea=${dea.toExponential(2)}` : "";
      console.log(
        `[${variant.padEnd(16)}] rep${rep} ${verdict.padEnd(20)} ${elapsed}ms${deaStr} «${p.q.slice(0, 50)}»`,
      );
      await new Promise((r) => setTimeout(r, 1500)); // gentle pacing
    }
  }
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function p95(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
}

const scoreboard = {};
for (const variant of VARIANTS) {
  const v = results[variant];
  const good = v.filter((r) => r.verdict.startsWith("OK_")).length;
  const latencies = v.map((r) => r.elapsed_ms);
  const deas = v.map((r) => r.scores?.dea_violation).filter((n) => typeof n === "number");
  scoreboard[variant] = {
    n: v.length,
    score: `${good}/${v.length}`,
    pct: Math.round((good / v.length) * 100),
    latency_ms: {
      median: median(latencies),
      p95: p95(latencies),
      min: Math.min(...latencies),
      max: Math.max(...latencies),
    },
    dea_violation: deas.length
      ? {
          median: median(deas),
          p95: p95(deas),
          min: Math.min(...deas),
          max: Math.max(...deas),
          n: deas.length,
        }
      : null,
    verdicts: v.map((r) => r.verdict),
  };
}

writeFileSync(
  join(OUT, "results.json"),
  JSON.stringify(
    {
      meta: {
        useAgent,
        prompts: PROMPTS.length,
        variants: VARIANTS,
        repeat: REPEAT,
        cells_per_variant: PROMPTS.length * REPEAT,
        total,
        disengaged,
        elapsed_ms: Date.now() - start,
        timestamp: new Date().toISOString(),
      },
      scoreboard,
      details: results,
    },
    null,
    2,
  ),
);

console.log("\n===== SCOREBOARD =====");
console.log(`(n=${REPEAT} per cell, ${PROMPTS.length} cells × ${VARIANTS.length} variants)`);
for (const [variant, s] of Object.entries(scoreboard)) {
  const dea = s.dea_violation ? ` dea_med=${s.dea_violation.median.toExponential(2)}` : "";
  console.log(
    `${variant.padEnd(16)} ${s.score}  med=${s.latency_ms.median}ms p95=${s.latency_ms.p95}ms${dea}`,
  );
}
console.log(
  `\n[done] disengaged: ${disengaged}/${total}, elapsed: ${Math.round((Date.now() - start) / 1000)}s, output: ${OUT}`,
);
