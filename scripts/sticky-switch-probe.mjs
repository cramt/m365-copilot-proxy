// Phase-0 probe (.plans/sticky-session.md): can ONE M365 conversation switch
// tone, scenario or agent between turns and keep its history?
//
// Each hypothesis is one fresh conversation, run sequentially with --gap seconds
// between conversations. Verdicts go into docs/hypotheses.md §31.
//   H-S1  tone switch, included: gpt-5.5-quick -> claude-sonnet (no agent)
//   H-S2  scenario switch: claude-sonnet (included) -> claude-sonnet-5 (paid)
//   H-S3  agent switch: m365-copilot WITH agent -> claude-sonnet agent-less -> m365-copilot WITH agent
//   H-S4  codeword recall on every turn after the plant (embedded in H-S1..H-S3; verdict aggregates)
//
// Usage (after `pnpm build`, inside nix develop):
//   nix develop --command bash -c 'node scripts/sticky-switch-probe.mjs --only=H-S1'
//   flags: --only=H-S1,H-S3  --gap=90 (seconds)  --agent-model=m365-copilot
//          --switch-model=claude-sonnet (H-S1/H-S3 target; agent-less Claude is dead on non-premium)  --dry-run
// Cost: 3 fresh threads, 7 turns. H-S2 needs a premium account; a paid turn with no
// content is reported INCONCLUSIVE ("no entitlement?"). result.value "Throttled" stops
// the run at once; nothing is retried.
// Output: scripts/frame-dump-out/sticky-switch-<timestamp>.jsonl (not written by --dry-run).
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, def) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1] ?? def;
const DRY_RUN = process.argv.includes("--dry-run");
const GAP_S = Number(arg("gap", "90"));
const AGENT_MODEL = arg("agent-model", "m365-copilot");
const SWITCH_MODEL = arg("switch-model", "claude-sonnet");
const SWITCH_IS_CLAUDE = /claude|sonnet|opus/i.test(SWITCH_MODEL);
// GPT self-ID rarely names a minor version, so a GPT target is judged on recall alone.
const SWITCH_SELF = SWITCH_IS_CLAUDE
  ? { expectSelf: /claude|sonnet/i, wrongSelf: /\bgpt\b|openai/i }
  : {};
const ONLY =
  arg("only", null)
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? null;
const TURN_PAUSE_MS = 3000;
const OUT_DIR = fileURLToPath(new URL("./frame-dump-out/", import.meta.url));

const WORDS = ["kestrel", "marlin", "juniper", "cobalt", "saffron", "tundra", "lantern", "basalt"];
const CODEWORD = `${WORDS[Math.floor(Math.random() * WORDS.length)]}-${100 + Math.floor(Math.random() * 900)}`;
const SELF_RE = /(?:claude|sonnet|opus|gpt|openai|anthropic)[^\n.,;]{0,40}/i;
const PLANT = `Remember the codeword ${CODEWORD}. Reply only OK.`;
const ASK_SELF =
  "Which model are you (name and version)? And what was the codeword I gave you? Two short sentences at most.";
const ASK_CODE = "What was the codeword I gave you? Reply with only the codeword.";

const HYPOTHESES = [
  {
    id: "H-S1",
    title: "tone switch, included scenario",
    turns: [
      { role: "plant", model: "gpt-5.5-quick", useAgent: false, text: PLANT },
      {
        role: "switch",
        model: SWITCH_MODEL,
        useAgent: false,
        text: ASK_SELF,
        recall: true,
        ...SWITCH_SELF,
      },
    ],
  },
  {
    id: "H-S2",
    title: "scenario switch, included -> paid",
    turns: [
      { role: "plant", model: "claude-sonnet", useAgent: false, text: PLANT },
      {
        role: "switch",
        model: "claude-sonnet-5",
        useAgent: false,
        text: ASK_SELF,
        recall: true,
        expectSelf: /sonnet[\s-]*5(?!\.?\d)/i,
        wrongSelf: /sonnet[\s-]*4\.[56]/i,
      },
    ],
  },
  {
    id: "H-S3",
    title: "agent <-> agent-less switch",
    turns: [
      { role: "plant", model: AGENT_MODEL, useAgent: true, text: PLANT },
      {
        role: "agent-less",
        model: SWITCH_MODEL,
        useAgent: false,
        text: ASK_SELF,
        recall: true,
        ...SWITCH_SELF,
      },
      { role: "back-to-agent", model: AGENT_MODEL, useAgent: true, text: ASK_CODE, recall: true },
    ],
  },
];

const known = new Set(HYPOTHESES.map((h) => h.id));
const selected = ONLY ? HYPOTHESES.filter((h) => ONLY.includes(h.id)) : HYPOTHESES;
const errors = [];
if (!Number.isFinite(GAP_S) || GAP_S < 0) errors.push("--gap must be a number of seconds >= 0");
for (const id of ONLY ?? []) {
  if (!known.has(id))
    errors.push(`unknown hypothesis ${id} (H-S4 is the recall check embedded in H-S1..H-S3)`);
}
if (ONLY && selected.length === 0) errors.push("--only selected nothing");
if (errors.length) {
  for (const e of errors) console.error(`sticky-switch-probe: ${e}`);
  process.exit(2);
}

if (DRY_RUN) {
  console.log(
    "sticky-switch-probe --dry-run: no auth, no network, dist not imported, nothing written",
  );
  console.log(
    `codeword ${CODEWORD} | agent model ${AGENT_MODEL} | ${GAP_S}s cooldown between conversations`,
  );
  let turns = 0;
  for (const h of selected) {
    console.log(`\n${h.id}  ${h.title}`);
    for (const [i, t] of h.turns.entries()) {
      turns++;
      const agent = t.useAgent ? "yes" : "no ";
      console.log(
        `  t${i + 1} ${t.role.padEnd(14)} ${t.model.padEnd(18)} agent=${agent}  ${JSON.stringify(t.text.slice(0, 70))}`,
      );
    }
  }
  console.log(
    `\nplan: ${selected.length} conversations, ${turns} turns, ${Math.max(0, selected.length - 1)} x ${GAP_S}s cooldowns`,
  );
  process.exit(0);
}

async function loadApi() {
  try {
    return await import(new URL("../packages/core/dist/index.mjs", import.meta.url).href);
  } catch (err) {
    console.error(`cannot load packages/core/dist (run pnpm build first): ${err.message}`);
    process.exit(1);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const why = (r) =>
  r.error ??
  `value=${r.resultValue ?? "-"}${r.errorCode ? `/${r.errorCode}` : ""}, msg=${r.messageType ?? "-"}, text=${r.text ? "yes" : "empty"}`;

async function runTurn(session, spec, hyp, turnNo, api, outFile) {
  const t0 = Date.now();
  let stream = null;
  let streamed = "";
  let error = null;
  try {
    stream = await session.run(spec.text, spec.model, undefined, spec.useAgent);
    for await (const d of stream) streamed += d;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const full = stream?.fullText ?? "";
  const body = (full.length > streamed.length ? full : streamed).trim();
  const result = stream?.result ?? null;
  const disengaged = stream?.messageType === "Disengaged";
  const served =
    !error &&
    body.length > 0 &&
    !disengaged &&
    !["InternalError", "Throttled"].includes(result?.value);
  const selfMatch = body.match(SELF_RE)?.[0].trim() ?? null;
  const selfOk = spec.expectSelf ? spec.expectSelf.test(body) : null;

  const rec = {
    ts: new Date().toISOString(),
    hypothesis: hyp.id,
    turn: turnNo,
    role: spec.role,
    model: spec.model,
    tone: api.getToneForModel(spec.model),
    scenario: api.getScenarioForModel(spec.model).scenario,
    useAgent: spec.useAgent,
    proxyPolicyUsesAgent: api.requestUsesAgent(spec.model, false),
    conversationId: session.conversationId,
    resultValue: result?.value ?? null,
    errorCode: result?.errorCode ?? null,
    messageType: stream?.messageType ?? null,
    contentOrigin: stream?.contentOrigin ?? null,
    throttle: stream?.throttle ?? null,
    metering: stream?.metering ?? null,
    served,
    disengaged,
    recalled: spec.recall ? body.toLowerCase().includes(CODEWORD.toLowerCase()) : null,
    selfId: selfMatch,
    selfOk,
    selfWrong: spec.wrongSelf ? !selfOk && spec.wrongSelf.test(body) : null,
    elapsedMs: Date.now() - t0,
    error,
    text: body.length > 400 ? `${body.slice(0, 400)}...` : body,
  };

  const flags = [
    `value=${rec.resultValue ?? "-"}${rec.errorCode ? `/${rec.errorCode}` : ""}`,
    `msg=${rec.messageType ?? "-"}`,
    `origin=${rec.contentOrigin ?? "-"}`,
    `served=${served ? "yes" : "NO"}`,
    rec.recalled === null ? null : `recalled=${rec.recalled}`,
    selfMatch ? `self="${selfMatch}"` : null,
  ].filter(Boolean);
  console.log(
    `[${hyp.id} t${turnNo}] ${spec.model} tone=${rec.tone} scen=${rec.scenario} agent=${spec.useAgent ? "yes" : "no"} cid=${session.conversationId}`,
  );
  console.log(`    ${flags.join(" | ")}`);
  console.log(`    ${JSON.stringify(rec.text.slice(0, 200))}${error ? `  ERR ${error}` : ""}`);
  appendFileSync(outFile, `${JSON.stringify(rec)}\n`);
  return rec;
}

async function runHypothesis(h, api, outFile) {
  const session = new api.ModelSession();
  const recs = [];
  for (const [i, spec] of h.turns.entries()) {
    if (i > 0) await sleep(TURN_PAUSE_MS);
    const rec = await runTurn(session, spec, h, i + 1, api, outFile);
    recs.push(rec);
    if (rec.resultValue === "Throttled") return { recs, throttled: true };
  }
  return { recs, throttled: false };
}

function switchVerdict(h, [plant, sw]) {
  if (!plant.served) return ["INCONCLUSIVE", `plant turn did not serve (${why(plant)})`];
  if (!sw.served) {
    if (h.id === "H-S2" && !sw.text)
      return ["INCONCLUSIVE", `no entitlement? paid scenario returned no content (${why(sw)})`];
    return ["FAIL", `switch turn did not serve (${why(sw)})`];
  }
  if (sw.selfWrong) return ["FAIL", `still self-IDs as the old model: "${sw.selfId}"`];
  if (sw.recalled === false)
    return ["FAIL", "history lost: codeword not recalled after the switch"];
  if (sw.selfOk && sw.recalled)
    return ["PASS", `served, self-ID "${sw.selfId}", codeword recalled`];
  if (sw.selfOk === null && sw.recalled)
    return ["PASS", `served, codeword recalled (self-ID not checked: "${sw.selfId ?? "none"}")`];
  return [
    "INCONCLUSIVE",
    `served, recalled=${sw.recalled}, self-ID not matched (${sw.selfId ?? "none"})`,
  ];
}

function agentVerdict([plant, away, back]) {
  if (!plant.served) return ["INCONCLUSIVE", `agent turn did not serve (${why(plant)})`];
  if (!away.served) return ["FAIL", `agent-less turn did not serve (${why(away)})`];
  if (!back.served) return ["FAIL", `agent turn after the switch did not serve (${why(back)})`];
  const lost = [away, back].filter((r) => r.recalled === false).map((r) => `t${r.turn}`);
  if (lost.length) return ["FAIL", `history lost: codeword not recalled on ${lost.join(", ")}`];
  return [
    "PASS",
    `all three served; codeword recalled on t2 and t3 (t2 self-ID: "${away.selfId ?? "none"}")`,
  ];
}

function verdictFor(h, recs) {
  if (recs.length < h.turns.length)
    return ["INCONCLUSIVE", `stopped after t${recs.length} (Throttled)`];
  return h.id === "H-S3" ? agentVerdict(recs) : switchVerdict(h, recs);
}

function recallVerdict(all) {
  const checks = all.filter((r) => r.recalled !== null && r.served);
  if (!checks.length) return ["INCONCLUSIVE", "no served recall checks ran"];
  const lost = checks.filter((r) => r.recalled === false);
  if (lost.length) {
    return [
      "FAIL",
      `codeword lost at ${lost.map((r) => `${r.hypothesis} t${r.turn} (${r.model})`).join(", ")}`,
    ];
  }
  return [
    "PASS",
    `${checks.length}/${checks.length} served recall checks recalled the codeword after a switch`,
  ];
}

const api = await loadApi();
await api.getToken();
mkdirSync(OUT_DIR, { recursive: true });
const outFile = join(
  OUT_DIR,
  `sticky-switch-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
);
console.log(`codeword ${CODEWORD} | output ${outFile}`);

const verdicts = {};
const allRecs = [];
let stoppedAt = null;

for (const [idx, h] of selected.entries()) {
  if (idx > 0) {
    console.log(`\ncooldown ${GAP_S}s before ${h.id}`);
    await sleep(GAP_S * 1000);
  }
  console.log(`\n== ${h.id} ${h.title}`);
  const { recs, throttled } = await runHypothesis(h, api, outFile);
  allRecs.push(...recs);
  verdicts[h.id] = verdictFor(h, recs);
  if (throttled) {
    stoppedAt = `${h.id} t${recs.at(-1).turn}`;
    break;
  }
}

if (stoppedAt) {
  console.log(
    `\nSTOPPED: Throttled at ${stoppedAt}. No further turns sent; remaining hypotheses not run.`,
  );
}
for (const h of selected) {
  verdicts[h.id] ??= ["INCONCLUSIVE", "not run (throttle stop)"];
}
const h4 = recallVerdict(allRecs);

const header = [
  "hyp",
  "turn",
  "model",
  "agent",
  "scen",
  "result",
  "msgType",
  "served",
  "recall",
  "selfId",
];
const rows = [
  header,
  ...allRecs.map((r) => [
    r.hypothesis,
    `t${r.turn}`,
    r.model,
    r.useAgent ? "yes" : "no",
    r.scenario.replace("OfficeWeb", "").replace("Copilot", ""),
    `${r.resultValue ?? "-"}${r.errorCode ? `/${r.errorCode}` : ""}`,
    r.messageType ?? "-",
    r.served ? "yes" : "no",
    r.recalled === null ? "-" : String(r.recalled),
    r.selfId ? r.selfId.slice(0, 30) : "-",
  ]),
];
const widths = header.map((_, i) => Math.max(...rows.map((r) => r[i].length)));
console.log("\nSUMMARY");
for (const r of rows) console.log(r.map((c, i) => c.padEnd(widths[i])).join("  "));

console.log("\nVERDICTS");
const lines = [...selected.map((h) => [h.id, ...verdicts[h.id]]), ["H-S4", ...h4]];
for (const [id, v, reason] of lines) {
  console.log(`${id}: ${v} (${reason})`);
  appendFileSync(
    outFile,
    `${JSON.stringify({ event: "verdict", hypothesis: id, verdict: v, reason })}\n`,
  );
}
process.exit(0);
