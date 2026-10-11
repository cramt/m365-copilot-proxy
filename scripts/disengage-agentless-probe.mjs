// F17 mitigation feasibility: does AGENT-LESS (DeepLeo) + the fenced shell-routing
// framing still (a) avoid the "replace X->Y" Disengage AND (b) emit tool fences?
// If yes, "on Disengaged, retry agent-less" is a viable proxy fix.
//
// Builds the EXACT proxy prompt via formatMessages (minimal framing + the 4 bench
// tools), then sends it two ways: agentId=null (agent-less / DeepLeo) and with the
// real tool agent (control, expected to Disengage). n each, sequential.
//
// Usage: nix develop --command node scripts/disengage-agentless-probe.mjs [repeat]
process.env.M365_FRAMING_VARIANT = process.env.M365_FRAMING_VARIANT || "minimal";

import {
  getToken,
  decodeJwt,
  formatMessages,
  getOrCreateAgent,
} from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

const REPEAT = Number(process.argv[2] || 3);
const COOLDOWN_MS = 25_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const T = (name, description, props) => ({
  type: "function",
  function: {
    name,
    description,
    parameters: {
      type: "object",
      properties: Object.fromEntries(Object.entries(props).map(([k, t]) => [k, { type: t }])),
      required: Object.keys(props).slice(0, 1),
    },
  },
});
const BENCH_TOOLS = [
  T("bash", "Run a shell command and get stdout/stderr.", { command: "string" }),
  T("read_file", "Read a file's contents.", { path: "string" }),
  T("write_file", "Write (create/overwrite) a file.", { path: "string", content: "string" }),
  T("edit_file", "Replace the first occurrence of old with new in a file.", {
    path: "string",
    old: "string",
    new: "string",
  }),
];

const TASK =
  "Edit config.json so the port is 8080 instead of 3000. Leave every other field unchanged.";

const token = await getToken();
const claims = decodeJwt(token);
const agentId = await getOrCreateAgent().catch(() => null);
console.log(
  `[agentless] framing=${process.env.M365_FRAMING_VARIANT} agent=${agentId ?? "none"} repeat=${REPEAT}`,
);

// Fence = a real tool call the proxy would route/execute.
const FENCE = /```(bash|sh|shell|zsh|write_file|edit_file|read_file)\b/;

const modes = [
  { key: "agentless", aid: null },
  { key: "agent_ctrl", aid: agentId },
].filter((m) => m.key === "agentless" || m.aid);

const summary = {};
for (const m of modes) {
  summary[m.key] = { n: 0, dis: 0, fence: 0 };
  for (let i = 0; i < REPEAT; i++) {
    // Fresh convId per call so each is an independent turn-1.
    const text = formatMessages(
      [{ role: "user", content: TASK }],
      BENCH_TOOLS,
      "auto",
      crypto.randomUUID(),
    );
    const r = await oneTurn({ token, claims, text, agentId: m.aid, tone: "magic" });
    const hasFence = FENCE.test(r.fullText || "");
    summary[m.key].n++;
    if (r.disengaged) summary[m.key].dis++;
    if (hasFence) summary[m.key].fence++;
    console.log(
      `  ${m.key.padEnd(10)} #${i + 1}  disengaged=${r.disengaged}  fence=${hasFence}  origin=${r.contentOrigin ?? "?"}  dea=${r.scores?.dea_violation ?? "?"}  len=${(r.fullText || "").length}`,
    );
    await sleep(COOLDOWN_MS);
  }
}

console.log("\n[agentless] === SUMMARY ===");
for (const [k, s] of Object.entries(summary)) {
  console.log(
    `  ${k.padEnd(10)} disengaged ${s.dis}/${s.n}   emitted-tool-fence ${s.fence}/${s.n}`,
  );
}
console.log("\nVIABLE mitigation iff agentless: disengaged 0/N AND fence ≈ N/N");
