// Tangent #2: can we get CLAUDE to do tool calls? The declarative agent forces GPT
// routing (H8.6), so Claude+tools requires the AGENT-LESS path (Claude tone leaks
// through). Agent-less tool-calling was unreliable (~1/3) under minimal framing; does
// the new `softened` framing make agent-less Claude reliably emit tool fences without
// disengaging? If yes → Claude Sonnet 4.5 as the coding model through the proxy.
//
// Usage: nix develop --command node scripts/claude-tools-probe.mjs [repeat]
process.env.M365_FRAMING_VARIANT = process.env.M365_FRAMING_VARIANT || "softened";
import { getToken, decodeJwt, formatMessages } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

const REPEAT = Number(process.argv[2] || 4);
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
  "There is a bug in calc.py: running python3 check.py fails an assertion. Read the files, find and fix the bug, and make python3 check.py print OK.";
const FENCE = /```(bash|sh|shell|zsh|write_file|edit_file|read_file)\b/;

const token = await getToken();
const claims = decodeJwt(token);
console.log(
  `[claude] framing=${process.env.M365_FRAMING_VARIANT} repeat=${REPEAT} (agent-less; tone is the model selector)`,
);

const TONES = (process.env.TONES || "Claude_Sonnet,Claude_Opus,Claude_Sonnet_Reasoning").split(",");
for (const tone of TONES) {
  // 1) self-id (no tools, agent-less) — confirm which model the tone routes to
  const id = await oneTurn({
    token,
    claims,
    text: "In one short sentence, what AI model are you?",
    agentId: null,
    tone,
  });
  console.log(
    `\n[${tone}] self-id: origin=${id.contentOrigin} disengaged=${id.disengaged}\n   "${(id.fullText || "").replace(/\s+/g, " ").slice(0, 120)}"`,
  );
  await sleep(6000);
  // 2) tool-call propensity (agent-less + softened framing on a coding task)
  let fences = 0,
    dis = 0;
  for (let i = 0; i < REPEAT; i++) {
    const text = formatMessages(
      [{ role: "user", content: TASK }],
      BENCH_TOOLS,
      "auto",
      crypto.randomUUID(),
    );
    const r = await oneTurn({ token, claims, text, agentId: null, tone });
    const f = FENCE.test(r.fullText || "");
    if (f) fences++;
    if (r.disengaged) dis++;
    console.log(
      `   ${tone} #${i + 1}: fence=${f} disengaged=${r.disengaged} origin=${r.contentOrigin} len=${(r.fullText || "").length}`,
    );
    await sleep(6000);
  }
  console.log(`[${tone}] => tool-fence ${fences}/${REPEAT}, disengaged ${dis}/${REPEAT}`);
}
console.log(
  "\nVIABLE Claude-for-tools iff Claude_Sonnet: self-id=Claude AND tool-fence ≈ REPEAT AND disengaged 0.",
);
