// RE probe: what gates Claude Sonnet 5's NATIVE server-side tools?
//
// Under `scenario=OfficeWebPaidCopilot` the `Claude_Sonnet` tone serves Claude
// Sonnet 5, and it arrives with its own function-calling toolset (bash_tool,
// create_file, str_replace, view) that executes in a REMOTE sandbox — cwd
// /home/claude, uploads /mnt/user-data/uploads, outputs /mnt/user-data/outputs.
// Those calls surface on the wire as `messageType:"Progress"` frames with
// `contentType:"Code"` ("Coding and executing", the command in `hiddenText`) or
// `contentOrigin:"CreateFileExecutor"`. On the proxy's tool path that sandbox
// competes with the harness's shell (the model inspects the wrong machine and
// reports "no such file"), so we want to know what turns it on.
//
// Hypothesis: the code-interpreter optionsSets the proxy sends on every
// agent-less turn (session.ts CODE_INTERPRETER_OPTIONS_SETS) are the gate.
// Prediction: with them dropped, a "run pwd" ask produces NO Progress/Code frame
// and the model no longer names bash_tool/create_file as its tools.
// Falsified if the native Code frames still appear with optionsSets = [].
//
// Usage: node scripts/sonnet5-native-tools-probe.mjs [cell,cell,...]
// Cost: 1 message (1 fresh thread) per cell. Run sequentially.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getToken, decodeJwt } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

// Mirrors of session.ts (not exported from core). Keep in sync if those change.
const CODE_INTERPRETER = [
  "cwc_code_interpreter", "cwc_code_interpreter_amsfix", "cwc_code_interpreter_citation_fix",
  "code_interpreter_interactive_charts", "code_interpreter_matplotlib_patching",
];
const IMAGE_GEN = [
  "cwc_flux_image", "cwc_flux_v3", "enable_gg_gpt", "flux_v3_progress_messages",
  "flux_v3_image_gen_enable_dimensions", "flux_v3_image_gen_enable_icon_dimensions",
  "flux_v3_image_gen_enable_story",
  "flux_v3_image_gen_enable_designer_dimensions_meta_prompting_in_system_prompts",
  "flux_v3_image_gen_enable_system_text_with_params", "flux_v3_image_gen_enable_non_watermarked_storage",
];
const PROXY_VARIANTS = [
  "EnableMcpServerWidgets", "feature.EnableMcpServerWidgets", "feature.EnableLuForChatCIQ",
  "feature.enableChatCIQPlugin", "EnableRequestPlugins", "feature.EnableSensitivityLabels",
  "EnableUnsupportedUrlDetector", "feature.IsCustomEngineCopilotEnabled", "feature.bizchatfluxv3",
  "feature.enablechatpages", "feature.enableCodeCanvas", "feature.turnOnWorkTabRecommendation",
  "turnOffWorkTabUpsellFromClient", "feature.turnOnDARecommendation",
  "feature.IsStreamingModeInChatRequestEnabled", "IncludeSourceAttributionsConcise",
  "SkipPublishEmptyMessage", "feature.EnableDeduplicatingSourceAttributions",
  "Enable3PActionProgressMessages", "feature.enableClientWebRtc",
  "feature.EnableMeetingRecapOfSeriesMeetingWithCiq", "feature.EnableReferencesListCompleteSignal",
  "feature.StorageMessageSplitDisabled", "feature.EnableCuaTakeControlApi", "feature.cwcallowedos",
  "feature.disabledisallowedmsgs", "feature.enableCitationsForSynthesisData",
  "feature.enableGenerateGraphicArtOptionsSet", "cdximagen",
  "feature.EnableUpdatedUXForConfirmationDialog",
  "feature.EnableClientFileURLSupportForOfficeWebPaidCopilot", "feature.EnableDesignEditorImageGrounding",
  "feature.EnableDesignerEditor", "feature.OfficeWebToHelix", "feature.OfficeDesktopToHelix",
  "feature.M365TeamsHubToHelix", "feature.OwaHubToHelix", "feature.MonarchHubToHelix",
  "feature.Win32OutlookHubToHelix", "feature.MacOutlookHubToHelix", "Agt_bizchat_enableGpt5ForHelix",
].join(",");

const PAID = { scenario: "OfficeWebPaidCopilot", licenseType: "Premium" };
const INCLUDED = { scenario: "OfficeWebIncludedCopilot", licenseType: "Starter" };

const RUN_PWD = "Run the shell command `pwd` and tell me exactly what it printed.";
const LIST_TOOLS = "Without calling any tool, list every tool or function you can call in this conversation, one per line, using each tool's exact name. Then state your current working directory if you have one, or 'none'.";

const CELLS = {
  // what the proxy sends today on the agent-less (Claude) path, tools or not
  "pwd-proxy":     { text: RUN_PWD,    optionsSets: [...CODE_INTERPRETER, ...IMAGE_GEN], ...PAID },
  "pwd-none":      { text: RUN_PWD,    optionsSets: [], ...PAID },
  "pwd-codeonly":  { text: RUN_PWD,    optionsSets: [...CODE_INTERPRETER], ...PAID },
  "pwd-imageonly": { text: RUN_PWD,    optionsSets: [...IMAGE_GEN], ...PAID },
  "list-proxy":    { text: LIST_TOOLS, optionsSets: [...CODE_INTERPRETER, ...IMAGE_GEN], ...PAID },
  "list-none":     { text: LIST_TOOLS, optionsSets: [], ...PAID },
  // Gate hunt after optionsSets were falsified: a fully bare request (no plugins,
  // the helper's minimal variants), and not declaring Progress/GeneratedCode —
  // the server follows a declare-to-receive rule for GraphicArt/native actions.
  "pwd-bare":       { text: RUN_PWD, optionsSets: [], plugins: [], variants: null, extraAllowed: [], ...PAID },
  "pwd-noprogress": { text: RUN_PWD, optionsSets: [], extraAllowed: [],
    baseAllowed: ["Chat", "Suggestion", "Disengaged", "EndOfRequest", "ReferencesListComplete"], ...PAID },
  // Sonnet 4.6 (included scenario) for contrast: M365's python code interpreter, not bash_tool
  "pwd-proxy-included": { text: RUN_PWD, optionsSets: [...CODE_INTERPRETER, ...IMAGE_GEN], ...INCLUDED },
  "pwd-none-included":  { text: RUN_PWD, optionsSets: [], ...INCLUDED },
};

const pick = (process.argv[2] || "pwd-proxy,pwd-none").split(",");
const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "tone-out", `native-tools-${TS}`);
mkdirSync(OUT, { recursive: true });

const token = await getToken();
const claims = decodeJwt(token);
const results = [];

for (const name of pick) {
  const cell = CELLS[name];
  if (!cell) { console.error(`unknown cell ${name}`); continue; }
  const frames = [];
  const r = await oneTurn({
    token, claims, text: cell.text, tone: "Claude_Sonnet",
    optionsSets: cell.optionsSets,
    extraAllowed: cell.extraAllowed ?? ["GeneratedCode"],
    ...(cell.baseAllowed ? { baseAllowed: cell.baseAllowed } : {}),
    ...(cell.plugins ? { plugins: cell.plugins } : {}),
    // `variants: null` → the helper's own minimal default list
    ...(cell.variants === null ? {} : { variants: cell.variants ?? PROXY_VARIANTS }),
    scenario: cell.scenario, licenseType: cell.licenseType, timeoutMs: 180000,
    onFrame: (f) => frames.push(f),
  });
  // Distinct bot messages (last snapshot per messageId wins).
  const byId = new Map();
  for (const f of frames) {
    const msgs = f.type === 1 && f.target === "update" ? (f.arguments || []).flatMap((a) => a.messages || []) : [];
    for (const m of msgs) if (m.author === "bot") byId.set(m.messageId, m);
  }
  const bots = [...byId.values()];
  const native = bots.filter((m) => m.contentType === "Code" || m.contentOrigin === "CreateFileExecutor" || m.messageType === "GeneratedCode");
  const cot = bots.filter((m) => m.contentOrigin === "ChainOfThoughtSummary").map((m) => m.text);
  const row = {
    cell: name, scenario: cell.scenario, optionsSets: cell.optionsSets.length,
    contentOrigin: r.contentOrigin, disengaged: r.disengaged, elapsedMs: r.elapsedMs, error: r.error,
    nativeCalls: native.map((m) => ({ kind: m.contentOrigin || m.contentType || m.messageType, cmd: m.hiddenText ?? m.text })),
    cot, reply: r.fullText,
  };
  results.push(row);
  writeFileSync(join(OUT, `${name}.frames.json`), JSON.stringify(frames, null, 1));
  console.log(`\n[probe] ${name}  scenario=${cell.scenario} optionsSets=${cell.optionsSets.length} origin=${r.contentOrigin} ${r.elapsedMs}ms${r.error ? " error=" + r.error : ""}`);
  console.log(`  native tool calls: ${native.length}${native.map((m) => `\n    - ${m.contentOrigin || m.contentType}: ${JSON.stringify((m.hiddenText ?? m.text ?? "").slice(0, 160))}`).join("")}`);
  for (const c of cot) console.log(`  CoT: ${JSON.stringify(c.slice(0, 300))}`);
  console.log(`  reply: ${JSON.stringify(r.fullText.slice(0, 600))}`);
  await new Promise((res) => setTimeout(res, 8000)); // pace fresh threads
}

writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\n[probe] out: ${OUT}`);
