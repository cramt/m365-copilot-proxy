// Reverse-engineering probe: open a raw WebSocket to M365 Copilot and dump
// EVERY field of EVERY frame it sends, plus a structured field-frequency
// summary at the end. Read-only — sends one chat turn and shuts down.
//
// What we're hunting:
//   1. Token counts / usage metrics that M365 sends but we ignore.
//   2. Context-window hints (max prompt tokens, current prompt size, …).
//   3. Unknown messageType values that our schemas drop on the floor.
//   4. Hidden meta we could surface in /v1/chat/completions usage{}.
//
// Usage:
//   M365_NO_INTERACTIVE=1 node scripts/frame-dump-probe.mjs [--many-tools]
//     [--no-agent] [--prompt "your prompt"] [--allowed-extra Foo,Bar]
//
// Outputs (gitignored):
//   scripts/frame-dump-out/<timestamp>/raw-frames.ndjson      — every frame
//   scripts/frame-dump-out/<timestamp>/keys-summary.json      — key freq map
//   scripts/frame-dump-out/<timestamp>/token-candidates.json  — values whose
//     KEY OR VALUE looks token-/context-/usage-related (the actual gold).
//   scripts/frame-dump-out/<timestamp>/sent.json              — what we sent
//
// Run unsandboxed inside `nix develop --command`. Burns ONE M365 message.

import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getToken, getOrCreateAgent, decodeJwt } from "../packages/core/dist/index.mjs";

// `ws` lives in @m365-copilot/core's dependencies, not the workspace root,
// so resolve it via the pnpm store the way studio-dig.mjs does for playwright.
import { pathToFileURL } from "node:url";
const ROOT = pathToFileURL(process.cwd()).href;
const wsMod = await import(`${ROOT}/node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs`);
const WebSocket = wsMod.default ?? wsMod.WebSocket;

const RS = "\x1E";
const args = new Set(process.argv.slice(2));
const arg = (k, def = null) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};

const PROMPT = arg("--prompt", "Reply with the single word: pong");
const USE_AGENT = !args.has("--no-agent");
const MANY_TOOLS = args.has("--many-tools");
const ALLOWED_EXTRA = (arg("--allowed-extra", "") || "").split(",").filter(Boolean);

const TS = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = join(process.cwd(), "scripts", "frame-dump-out", TS);
mkdirSync(OUT, { recursive: true });

console.log(`[probe] out=${OUT}`);
console.log(`[probe] auth...`);
const token = await getToken();
const claims = decodeJwt(token);
console.log(`[probe] oid=${claims.oid} tid=${claims.tid}`);

let agentId = null;
if (USE_AGENT) {
  console.log(`[probe] resolving agent...`);
  agentId = await getOrCreateAgent();
  console.log(`[probe] agent=${agentId ?? "none"}`);
}

// --- Build the chat payload with our most permissive allowed-message-types
// list. We deliberately include guesses for token/usage frames (cheap: M365
// either honors them and we see new frames, or ignores them silently).
const BASE_ALLOWED = [
  "Chat", "Suggestion", "InternalSearchQuery", "Disengaged",
  "InternalLoaderMessage", "Progress", "RenderCardRequest", "SemanticSerp",
  "GenerateContentQuery", "SearchQuery", "ConfirmationCard", "DeveloperLogs",
  "EndOfRequest", "ReferencesListComplete",
];
const TOKEN_GUESSES = [
  "TokenUsage", "Telemetry", "Usage", "ResponseInformation",
  "ContextLimits", "ContextLength", "TokenCount", "Diagnostics",
  "ChatRequestStarted", "InvocationMetrics", "RequestMetrics",
];
const ALLOWED = [...new Set([...BASE_ALLOWED, ...TOKEN_GUESSES, ...ALLOWED_EXTRA])];

// Tool block (lean by default — many-tools is for hunting Disengaged + frames).
const SOME_TOOLS = [
  ["reply", "Send a plain text answer", { text: "string" }],
  ["bash", "Run a shell command", { command: "string" }],
  ["read_file", "Read a file", { path: "string" }],
];
const TOOL_BLOCK = MANY_TOOLS
  ? `<tools>\n${SOME_TOOLS.concat([
      ["edit", "Edit a file", { path: "string", oldString: "string", newString: "string" }],
      ["write", "Write a file", { path: "string", content: "string" }],
      ["glob", "Glob files", { pattern: "string" }],
      ["grep", "Grep contents", { pattern: "string" }],
      ["list", "List a dir", { path: "string" }],
    ]).map(([n, d, p]) => JSON.stringify({ name: n, description: d, parameters: { type: "object", properties: Object.fromEntries(Object.entries(p).map(([k, t]) => [k, { type: t }])) } })).join("\n")}\n</tools>\n`
  : "";

const sessionId = crypto.randomUUID();
const conversationId = crypto.randomUUID();
const requestId = crypto.randomUUID();

const VARIANTS = [
  "EnableMcpServerWidgets", "feature.EnableMcpServerWidgets",
  "feature.IsStreamingModeInChatRequestEnabled", "DeveloperLogs",
  "Agt_bizchat_enableGpt5ForHelix",
].join(",");

const params = new URLSearchParams({
  chatsessionid: requestId,
  clientrequestid: requestId,
  "X-SessionId": sessionId,
  ConversationId: conversationId,
  access_token: token,
  variants: VARIANTS,
  source: '"officeweb"',
  product: "Office",
  agentHost: "Bizchat.FullScreen",
  licenseType: "Starter",
  agent: "web",
  scenario: "OfficeWebIncludedCopilot",
});
const wsUrl = `wss://substrate.office.com/m365Copilot/Chathub/${claims.oid}@${claims.tid}?${params}`;

const chatMsg = {
  arguments: [{
    source: "officeweb",
    clientCorrelationId: requestId,
    sessionId,
    optionsSets: [],
    streamingMode: "ConciseWithPadding",
    spokenTextMode: "None",
    options: {},
    extraExtensionParameters: {},
    allowedMessageTypes: ALLOWED,
    sliceIds: [],
    threadLevelGptId: agentId ? { id: agentId, source: "MOS3" } : {},
    traceId: requestId,
    isStartOfSession: true,
    clientInfo: {
      clientPlatform: "mcmcopilot-web",
      clientAppName: "Office",
      clientEntrypoint: "mcmcopilot-officeweb",
      clientSessionId: sessionId,
      clientAppType: "Web",
      deviceOS: "Linux",
      deviceType: "Desktop",
    },
    message: {
      author: "user",
      inputMethod: "Keyboard",
      text: TOOL_BLOCK + `<user>\n${PROMPT}\n</user>`,
      entityAnnotationTypes: ["People", "File", "Event", "Email", "TeamsMessage"],
      requestId,
      locationInfo: { timeZoneOffset: 1, timeZone: "Europe/Copenhagen" },
      locale: "en-gb",
      messageType: "Chat",
      experienceType: "Default",
      adaptiveCards: [],
      clientPreferences: {},
    },
    ...(agentId
      ? { gpts: [{ id: agentId, source: "MOS3", version: "1.0.0",
          clientOverrides: { capabilities: [], "deepResearchModels@odata.type": "Collection(String)" } }] }
      : { plugins: [{ Id: "BingWebSearch", Source: "BuiltIn" }] }),
    isSbsSupported: true,
    tone: "magic",
    renderReferencesBehindEOS: true,
    disconnectBehavior: "continue",
  }],
  invocationId: "0", target: "chat", type: 4,
};
const metrics = {
  arguments: [{ Timestamps: { ConnectionStart: new Date().toISOString(), UserInputStart: new Date().toISOString(), ConnectionEstablished: new Date().toISOString(), UserInputSubmit: new Date().toISOString() } }],
  target: "Metrics", type: 1,
};

writeFileSync(join(OUT, "sent.json"), JSON.stringify({ wsUrl: wsUrl.split("?")[0] + "?...", chatMsg, metrics, allowedMessageTypes: ALLOWED }, null, 2));

// --- Walk arbitrary JSON, collect every key path + sample value.
const keyFreq = new Map(); // path -> { count, samples: [up to 3] }
const TOKEN_KEY_RE = /token|usage|context|prompt|completion|length|cost|quota|tier|budget|limit|remaining|model[A-Z]|deployment|charge|count|metering/i;
const TOKEN_VAL_RE = /\btokens?\b|context.window|prompt.tokens|completion.tokens|max.{0,4}token|usage|maxTokensPerMessage/i;
const candidates = [];

function walk(obj, path = "") {
  if (obj === null || obj === undefined) return;
  if (typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => walk(item, `${path}[${i}]`));
    return;
  }
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    const slot = keyFreq.get(p) ?? { count: 0, samples: [] };
    slot.count++;
    if (slot.samples.length < 3) {
      try { slot.samples.push(JSON.stringify(v).slice(0, 200)); } catch {}
    }
    keyFreq.set(p, slot);

    // Token/usage candidate detection: key match OR value looks usage-related
    const keyMatch = TOKEN_KEY_RE.test(k);
    let valMatch = false;
    if (typeof v === "string") valMatch = TOKEN_VAL_RE.test(v);
    if (keyMatch) candidates.push({ where: p, kind: "key", key: k, value: typeof v === "object" ? "(object)" : v });
    if (valMatch) candidates.push({ where: p, kind: "value", key: k, value: String(v).slice(0, 240) });

    walk(v, p);
  }
}

console.log(`[probe] connecting...`);
const ws = new WebSocket(wsUrl, {
  headers: {
    "Origin": "https://m365.cloud.microsoft",
    "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0",
  },
});

let handshakeDone = false;
let frameIdx = 0;
const t0 = Date.now();
const rawNdjsonPath = join(OUT, "raw-frames.ndjson");
const messageTypes = new Set();
const targets = new Set();

ws.on("open", () => {
  ws.send(JSON.stringify({ protocol: "json", version: 1 }) + RS);
});

ws.on("message", (data) => {
  const raw = data.toString();
  const frames = raw.split(RS).filter((f) => f.length > 0);

  for (const f of frames) {
    let parsed;
    try { parsed = JSON.parse(f); } catch { parsed = { _raw_unparsable: f }; }

    // Record raw + dt
    appendFileSync(rawNdjsonPath,
      JSON.stringify({ i: frameIdx++, dt_ms: Date.now() - t0, frame: parsed }) + "\n");

    // First frame: SignalR handshake response (usually {}). Send chat next.
    if (!handshakeDone) {
      handshakeDone = true;
      const payload = JSON.stringify(chatMsg) + RS + JSON.stringify(metrics) + RS;
      ws.send(payload);
      continue;
    }

    walk(parsed);

    // Surface messageType/target for the summary
    if (parsed.target) targets.add(parsed.target);
    const args = parsed.arguments;
    if (Array.isArray(args)) {
      for (const a of args) {
        if (a && typeof a === "object") {
          if (Array.isArray(a.messages)) for (const m of a.messages) m?.messageType && messageTypes.add(m.messageType);
          if (a.messageType) messageTypes.add(a.messageType);
        }
      }
    }

    // PING: keep alive
    if (parsed.type === 6) ws.send(JSON.stringify({ type: 6 }) + RS);
    // CLOSE/STREAM-ITEM/COMPLETION: end
    if (parsed.type === 2 || parsed.type === 3 || parsed.type === 7) ws.close();
  }
});

ws.on("close", () => {
  // De-dupe + sort candidates by where-path
  const seen = new Set();
  const deduped = candidates.filter((c) => {
    const k = `${c.kind}|${c.where}|${c.value}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const summary = {
    elapsed_ms: Date.now() - t0,
    distinct_frames: frameIdx,
    messageTypes: [...messageTypes].sort(),
    targets: [...targets].sort(),
    distinct_paths: keyFreq.size,
    allowed_message_types_sent: ALLOWED,
  };

  // Top-line keys by frequency (signal of "this field shows up on every frame")
  const topPaths = [...keyFreq.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 80)
    .map(([p, v]) => ({ path: p, count: v.count, sample: v.samples[0] }));

  writeFileSync(join(OUT, "keys-summary.json"), JSON.stringify({
    summary,
    topPaths,
    all_paths: Object.fromEntries([...keyFreq.entries()].map(([p, v]) => [p, v])),
  }, null, 2));

  writeFileSync(join(OUT, "token-candidates.json"), JSON.stringify({
    summary: `${deduped.length} fields whose key OR value looked token/context/usage-related`,
    candidates: deduped,
  }, null, 2));

  console.log(`\n[probe] DONE. ${frameIdx} frames in ${Date.now() - t0}ms`);
  console.log(`[probe] messageTypes seen: ${[...messageTypes].sort().join(", ") || "(none)"}`);
  console.log(`[probe] targets: ${[...targets].sort().join(", ")}`);
  console.log(`[probe] token/usage candidates: ${deduped.length}`);
  if (deduped.length) {
    console.log("[probe] === candidate sample ===");
    for (const c of deduped.slice(0, 15)) console.log(`  ${c.where} (${c.kind}) = ${c.value}`);
  }
  console.log(`[probe] full output: ${OUT}`);
});

ws.on("error", (err) => {
  console.error(`[probe] WS error:`, err.message);
  process.exit(1);
});
