// E2E: drive a native custom action over the substrate WS via the proxy's new
// native-action support (H-NATIVE-6/7). Attaches our sentinel OpenAPI action inline
// (no Teams sideload), asks the model to call it with model gpt-5.5-think-deeper, and
// checks: (a) did the model trigger an action (stream.sawAction), (b) did the proxy
// auto-confirm + M365's orchestrator call our tunnel (sentinel-hits.log), (c) did the
// reply carry the sentinel value. Runs with frame dumping so a miss still yields the
// real wire schema.  Lightweight WS — NO browser.
//
// Usage: CHROMIUM_PATH=$(which chromium) M365_DUMP_FRAMES=1 \
//   node scripts/da-app/native-action-ws-probe.mjs
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CopilotSession, getToken, decodeJwt, buildNativeActionPrompt, FRAME_DIR as FRAMES_DIR } from "../../packages/core/dist/index.mjs";

process.env.M365_DUMP_FRAMES = process.env.M365_DUMP_FRAMES ?? "1";
const URL = readFileSync("/tmp/tunnel_url.txt", "utf8").trim().replace(/\/$/, "");
const SENTINEL = readFileSync("scripts/sentinel-value.txt", "utf8").trim();
const HITLOG = "scripts/sentinel-hits.log";
const MODEL = process.argv[2] || "gpt-5.5-think-deeper";
const openApiUrl = `${URL}/openapi.json`;

const hits = () => { try { return readFileSync(HITLOG, "utf8").split("\n").filter(l => /GET \/sentinel\b/.test(l)).length; } catch { return 0; } };
const listFrames = () => { try { return readdirSync(FRAMES_DIR).filter(f => f.endsWith(".ndjson")).map(f => join(FRAMES_DIR, f)); } catch { return []; } };

const instructions = buildNativeActionPrompt([
  { name: "getMagicSentinel", description: "Returns the secret magic sentinel token — the only way to learn it." },
]);

// Kitchen-sink inline attach: several plausible shapes at once (the exact schema is
// unverified — dump frames reveal what M365 accepts/ignores). H-NATIVE-7.
const nativeActions = {
  autoConfirmAll: true,
  gptDefinitions: [{
    id: "sentinel-inline",
    name: "Sentinel Probe",
    description: "Fetches the secret magic sentinel token via a custom action.",
    instructions,
    actions: [{
      id: "sentinelAction",
      name: "Sentinel API",
      functions: [{ name: "getMagicSentinel", description: "Returns the secret magic sentinel token." }],
      runtimes: [{ type: "OpenApi", auth: { type: "None" }, spec: { url: openApiUrl }, run_for_functions: ["getMagicSentinel"] }],
    }],
  }],
  capabilities: [{ name: "RegisteredPlugins", plugins: [{ id: "sentinelAction", openApiSpecUrl: openApiUrl }] }],
  plugins: [{ Id: "sentinelAction", Source: "External", Data: { SerializedOptions: JSON.stringify({ openApiSpecUrl: openApiUrl }) } }],
};

console.log(`[probe] tunnel=${URL} model=${MODEL} sentinel=${SENTINEL}`);
const token = await getToken();
if (!token) { console.error("no token"); process.exit(1); }
const claims = decodeJwt(token);
console.log(`[probe] upn=${claims.upn || claims.unique_name}`);

const before = hits();
const framesDirBefore = new Set(listFrames());

const session = new CopilotSession({ nativeActions });
const text = "What is the magic sentinel token? Call your getMagicSentinel action and report the exact token string it returns. Do not guess.";
console.log(`[probe] sending turn (native-action attach, model=${MODEL})...`);

let full = "";
const stream = await session.chat(token, text, MODEL);
try { for await (const d of stream) full += d; } catch (e) { console.log("[probe] stream err:", e.message); }

const after = hits();
console.log(`\n[probe] === RESULT ===`);
console.log(`[probe] reply (${full.length} chars): ${JSON.stringify(full.slice(0, 400))}`);
console.log(`[probe] messageType=${stream.messageType} contentOrigin=${stream.contentOrigin} sawAction=${stream.sawAction} throttle=${JSON.stringify(stream.throttle)}`);
console.log(`[probe] sentinel /sentinel hits: before=${before} after=${after} DELTA=${after - before}`);
console.log(`[probe] reply contains sentinel value: ${full.includes(SENTINEL)}`);
console.log(after > before ? "🎉 ORCHESTRATOR CALLED OUR ENDPOINT — native action fired over the WS" : "❌ no outbound call — see frame dump below for the real schema");

// Surface the interesting frames from this run for schema discovery.
const newFrames = listFrames().filter(f => !framesDirBefore.has(f));
const target = newFrames.sort().pop() || listFrames().sort().pop();
if (target) {
  console.log(`\n[probe] frame dump: ${target}`);
  const lines = readFileSync(target, "utf8").trim().split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const types = new Set();
  for (const { dir, frame } of lines) {
    const args = frame?.arguments;
    if (Array.isArray(args)) for (const a of args) {
      for (const m of a?.messages ?? a?.item?.messages ?? []) if (m?.messageType) types.add(`${dir}:${m.messageType}`);
      if (a?.error) types.add(`ERR:${String(a.error).slice(0,80)}`);
    }
    if (frame?.error) types.add(`ERR:${String(frame.error).slice(0,80)}`);
  }
  console.log(`[probe] frames=${lines.length} messageTypes/errors: ${[...types].join(", ") || "(none)"}`);
  // Print any adaptive-card / plugin-trigger / error frames verbatim (truncated).
  for (const { dir, frame } of lines) {
    const s = JSON.stringify(frame);
    if (/ConfirmationCard|TriggerPlugin|TriggerConfirmation|adaptiveCard|actionId|invocation|plugin|Error|error/i.test(s) && dir === "recv") {
      console.log(`[probe]   recv> ${s.slice(0, 600)}`);
    }
  }
}
