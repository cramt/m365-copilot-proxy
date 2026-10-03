// DECISIVE E2E for native tool-calling via LocalMCP over the raw substrate WS
// (docs/hypotheses.md §12.8/§12.9). No browser, no desktop host — the proxy IS the
// MCP host. Per turn: handshake → send LocalMcpDiscovery → send chat → answer Sydney's
// mcp_describe (tool schema) and invoke_local_plugin (execute + return). Because the
// sentinel is a real endpoint the proxy calls itself, this proves the whole native
// path headless. Runs multiple turns over ONE conversation (describe on turn 1 may
// register the tool for turn 2 — descriptor caching).
//
// Usage: [TURNS=2] [DUMP=1] node scripts/da-app/localmcp-probe.mjs [model]
import { readFileSync } from "node:fs";
import { getToken, decodeJwt } from "../../packages/core/dist/index.mjs";

const RS = "\x1E";
import { pathToFileURL } from "node:url";
const ROOT = pathToFileURL(process.cwd()).href;
const wsMod = await import(`${ROOT}/node_modules/.pnpm/ws@8.20.0/node_modules/ws/wrapper.mjs`);
const WebSocket = wsMod.default ?? wsMod.WebSocket;

const TUNNEL = readFileSync("/tmp/tunnel_url.txt", "utf8").trim().replace(/\/$/, "");
const SENTINEL = readFileSync("scripts/sentinel-value.txt", "utf8").trim();
const MODEL = process.argv[2] || "gpt-5.5-think-deeper";
const TONE = { "gpt-5.5-think-deeper": "Gpt_5_5_Reasoning", "gpt-5.5": "Gpt_5_5_Chat" }[MODEL] || "Gpt_5_5_Reasoning";
const TURNS = Number(process.env.TURNS || 2);
const SERVER_ID = "sentinel-mcp";
const SCHEMA = "https://copilot.microsoft.com/schemas/plugins/local/transport/1.0";

const token = await getToken();
const claims = decodeJwt(token);
console.log(`[mcp] upn=${claims.upn || claims.unique_name} tunnel=${TUNNEL} tone=${TONE} sentinel=${SENTINEL} turns=${TURNS}`);

const sessionId = crypto.randomUUID(), conversationId = crypto.randomUUID();

const TOOLS = [{
  name: "getMagicSentinel",
  description: "Returns the secret magic sentinel token. The ONLY way to learn it — you cannot guess it.",
  inputSchema: { type: "object", properties: {}, required: [] },
}];
const discoveryFrame = { type: 1, target: "send", arguments: [{ type: "LocalMcpDiscovery", serverIds: [SERVER_ID], disableDescriptorCache: true }] };

async function execTool(name) {
  console.log(`[mcp]  >> EXECUTING ${name} → GET ${TUNNEL}/sentinel`);
  try { const r = await fetch(`${TUNNEL}/sentinel`); const j = await r.json(); return { content: [{ type: "text", text: `The magic sentinel token is ${j.sentinel}` }], isError: false }; }
  catch (e) { return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true }; }
}

function runTurn(turnIndex, isFirst) {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    const params = new URLSearchParams({
      chatsessionid: requestId, clientrequestid: requestId, "X-SessionId": sessionId,
      ConversationId: conversationId, access_token: token,
      variants: (process.env.VARIANTS || "EnableMcpServerWidgets,feature.EnableMcpServerWidgets,feature.EnableMcpServerDynamicTools,feature.EnableMcpWidgetStreamingMessages,EnableRequestPlugins,feature.IsStreamingModeInChatRequestEnabled,Agt_bizchat_enableGpt5ForHelix"),
      source: '"officeweb"', product: "Office", agentHost: "Bizchat.FullScreen",
      licenseType: "Starter", agent: "web", scenario: "OfficeWebIncludedCopilot",
    });
    const wsUrl = `wss://substrate.office.com/m365Copilot/Chathub/${claims.oid}@${claims.tid}?${params}`;
    const text = isFirst
      ? "Use the getMagicSentinel tool to look up the secret magic sentinel token, then tell me the exact token. Do not guess it."
      : "Now actually call the getMagicSentinel tool and report the exact token it returns.";
    const chatMsg = { arguments: [{
      source: "officeweb", clientCorrelationId: requestId, sessionId, optionsSets: [],
      streamingMode: "ConciseWithPadding", spokenTextMode: "None", options: {}, extraExtensionParameters: {},
      allowedMessageTypes: ["Chat","Suggestion","InternalSearchQuery","Disengaged","InternalLoaderMessage","Progress","RenderCardRequest","SemanticSerp","GenerateContentQuery","SearchQuery","ConfirmationCard","DeveloperLogs","EndOfRequest","ReferencesListComplete","TriggerPlugin","TriggerConfirmation"],
      sliceIds: [], threadLevelGptId: {}, traceId: requestId, isStartOfSession: isFirst,
      clientInfo: { clientPlatform: "mcmcopilot-web", clientAppName: "Office", clientEntrypoint: "mcmcopilot-officeweb", clientSessionId: sessionId, clientAppType: "Web", deviceOS: "Linux", deviceType: "Desktop" },
      message: { author: "user", inputMethod: "Keyboard", text, entityAnnotationTypes: ["People","File","Event","Email","TeamsMessage"], requestId, locationInfo: { timeZoneOffset: 1, timeZone: "Europe/Copenhagen" }, locale: "en-gb", messageType: "Chat", experienceType: process.env.EXPERIENCE || "Default", adaptiveCards: [], clientPreferences: {} },
      plugins: [], enableConfirmationDialogSkill: true, enableAgentAutoInvoke: true, enableMsgExtAuthSkill: true,
      isSbsSupported: true, tone: TONE, renderReferencesBehindEOS: true, disconnectBehavior: "continue",
    }], invocationId: "0", target: "chat", type: 4 };
    const metrics = { arguments: [{ Timestamps: { ConnectionStart: new Date().toISOString(), UserInputStart: new Date().toISOString(), ConnectionEstablished: new Date().toISOString(), UserInputSubmit: new Date().toISOString() } }], target: "Metrics", type: 1 };

    const ws = new WebSocket(wsUrl, { headers: { Origin: "https://m365.cloud.microsoft", "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:148.0) Gecko/20100101 Firefox/148.0" } });
    let handshakeDone = false, deltaText = "", snapshotText = "", sawDescribe = false, sawInvoke = false, disengaged = false, settled = false;
    const timer = setTimeout(() => done("timeout"), 90000);
    const send = (o) => { try { ws.send(JSON.stringify(o) + RS); } catch {} };
    function done(err) {
      if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch {}
      const full = snapshotText.length >= deltaText.length ? snapshotText : deltaText;
      resolve({ sawDescribe, sawInvoke, disengaged, full, err });
    }
    ws.on("open", () => send({ protocol: "json", version: 1 }));
    ws.on("message", async (data) => {
      for (const f of data.toString().split(RS).filter(Boolean)) {
        let p; try { p = JSON.parse(f); } catch { continue; }
        if (process.env.DUMP) { const isDelta = p.type === 1 && p.target === "update" && p.arguments?.[0]?.writeAtCursor !== undefined && !p.arguments?.[0]?.messages; if (!isDelta) console.log(`[t${turnIndex} f] ${p.type} ${p.target ?? ""} ${p.invocationId ?? ""} ${JSON.stringify(p).slice(0, 320)}`); }
        if (!handshakeDone) { handshakeDone = true; send(discoveryFrame); ws.send(JSON.stringify(chatMsg) + RS + JSON.stringify(metrics) + RS); continue; }
        if (p.type === 6) { send({ type: 6 }); continue; }
        if (p.type === 1 && (p.target === "mcp_describe" || p.target === "mcp_discover") && p.invocationId) {
          sawDescribe = true; const req = p.arguments?.[0] ?? {};
          const payload = JSON.stringify({ servers: [{ server_id: SERVER_ID, name: "Magic Sentinel", transport: { type: "stdio" }, tools: TOOLS, prompts: [], resources: [], resourceTemplates: [] }] });
          send({ type: 3, invocationId: p.invocationId, result: { schema_version: SCHEMA, correlation_id: req.correlation_id, response: { status: "Success", message: "Local MCP servers described successfully", payload } } });
          console.log(`[mcp]  << t${turnIndex} mcp_describe → answered with getMagicSentinel`); continue;
        }
        if (p.type === 1 && p.target === "invoke_local_plugin" && p.invocationId) {
          sawInvoke = true; const req = p.arguments?.[0] ?? {};
          let toolName = ""; try { toolName = (JSON.parse(req.invocation?.payload ?? "{}").method ?? "").replace(/^mcp_/, ""); } catch {}
          console.log(`[mcp]  << t${turnIndex} invoke_local_plugin endpoint=${req.invocation?.local_endpoint} method=${toolName}`);
          const tr = await execTool(toolName || "getMagicSentinel");
          const payload = JSON.stringify({ result: [{ id: req.correlation_id, data: JSON.stringify(tr), type: "text/plain", description_for_model: `Tool invocation result for method ${toolName} on server ${SERVER_ID}` }], jsonrpc: "2.0", id: req.correlation_id });
          send({ type: 3, invocationId: p.invocationId, result: { schema_version: SCHEMA, correlation_id: req.correlation_id, response: { status: "Success", message: `Method ${toolName} invoked successfully.`, payload } } }); continue;
        }
        const args = p.arguments;
        if (Array.isArray(args)) for (const a of args) {
          if (!a || typeof a !== "object") continue;
          if (typeof a.writeAtCursor === "string") deltaText += a.writeAtCursor;
          for (const m of a.messages ?? a.item?.messages ?? []) { if (m?.messageType) { if (m.messageType === "Disengaged") disengaged = true; } else if (m?.author === "bot" && typeof m.text === "string" && m.text.length > snapshotText.length) snapshotText = m.text; }
        }
        if (p.type === 2 && p.item?.messages) for (const m of p.item.messages) if (m?.author === "bot" && typeof m.text === "string" && m.text.length > snapshotText.length) snapshotText = m.text;
        if ((p.type === 3 && p.invocationId === "0") || p.type === 7) done(p.error ?? null);
      }
    });
    ws.on("error", (e) => done(e.message));
    ws.on("close", () => done(null));
  });
}

let anyInvoke = false, anyValue = false;
for (let i = 1; i <= TURNS; i++) {
  const r = await runTurn(i, i === 1);
  const hasVal = r.full.includes(SENTINEL);
  anyInvoke ||= r.sawInvoke; anyValue ||= hasVal;
  console.log(`[mcp] TURN ${i}: describe=${r.sawDescribe} invoke=${r.sawInvoke} value=${hasVal} disengaged=${r.disengaged} reply=${JSON.stringify(r.full.slice(0, 200))}`);
  if (hasVal) break;
}
console.log(`\n[mcp] === VERDICT ===`);
console.log(anyValue ? "🎉🎉 NATIVE TOOL CALL WORKED end-to-end over the raw WS" : anyInvoke ? "◐ Sydney INVOKED our tool (native path proven) — value not echoed; check return shape" : "◐ describe accepted but no invoke — tool registered but model didn't call it");
