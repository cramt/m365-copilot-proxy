// HOLY GRAIL probe (H8.5): attach an MCP server to a minimalBots declarative
// agent and see if BizChat calls OUR tool over the cloudflare tunnel.
//
// Tools attach as a separate BotComponentInsert of $kind:"DialogComponent" whose
// `dialog` is a YAML string (research: microsoft/vscode-copilotstudio fixtures,
// microsoft/MCS-Agent-Builder). We try the bare-URL `kind: McpTool` + `serverUrl`
// form first (no connector provisioning), then fall back to other shapes.
//
// Creates a THROWAWAY agent named m365-mcp-probe-* (distinct from the real
// m365-tool-agent* so cleanup never collides), tests it, then deletes it.
//
// Usage: M365_NO_INTERACTIVE=1 CHROMIUM_PATH=$(which chromium) \
//   node scripts/mcp-agent-probe.mjs <tunnel-base-url> [--shape bareurl|connector|taskdialog]
// Cost: ~2 chat messages + PowerPlatform create/publish/delete (no BizChat quota for those).

import { readFileSync } from "node:fs";
import { getToken, decodeJwt, getTokenForScope, getEnvironmentUrl } from "../packages/core/dist/index.mjs";
import { oneTurn } from "./_probe-chat.mjs";

const TUNNEL = (process.argv[2] || readFileSync("/tmp/tunnel_url.txt", "utf8")).trim().replace(/\/$/, "");
const SHAPE = (() => { const i = process.argv.indexOf("--shape"); return i >= 0 ? process.argv[i + 1] : "bareurl"; })();
const MCP_URL = `${TUNNEL}/mcp`;
const SENTINEL = readFileSync("scripts/sentinel-value.txt", "utf8").trim();

const PP_SCOPES = ["https://api.powerplatform.com/.default"];
const BAP_SCOPES = ["https://api.bap.microsoft.com/.default"];
const NAME = `m365-mcp-probe-${Date.now().toString(36)}`;
const ICON = "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAB3RJTUUH6AMbAAAoLbOJEAAAABl0RVh0Q29tbWVudABDcmVhdGVkIHdpdGggR0lNUFeBDhcAAAAoSURBVFjD7cExAQAAAMKg9U9tDB+gAAAAAAAAAAAAAAAAAAAAAAAA/BgwMAAB/0LuMgAAAABJRU5ErkJggg==";

console.log(`[mcp] tunnel=${TUNNEL}  shape=${SHAPE}  sentinel=${SENTINEL}`);

const ppToken = await getTokenForScope(PP_SCOPES);
const bapToken = await getTokenForScope(BAP_SCOPES);
if (!ppToken || !bapToken) { console.error("missing PP/BAP token"); process.exit(1); }

// --- env discovery (shared with agent.ts) ---
const envUrl = await getEnvironmentUrl(bapToken);
console.log(`[mcp] env=${envUrl}`);

const ppFetch = (url, opts = {}) => fetch(url, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${ppToken}`, "x-ms-user-agent": "PVA-Portal/1.0.0 (Web; ReactNative: false)", ...(opts.headers || {}) } });
const API = `${envUrl}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`;

// --- the tool DialogComponent (try shapes) ---
function toolDialogYaml() {
  if (SHAPE === "bareurl") return `kind: McpTool\nserverUrl: ${MCP_URL}\nallowedTools: []\n`;
  if (SHAPE === "taskdialog") return `kind: TaskDialog\naction:\n  kind: InvokeExternalAgentTaskAction\n  operationDetails:\n    kind: ModelContextProtocolMetadata\n    serverUrl: ${MCP_URL}\n`;
  // connector shape would need a provisioned connector; not attempted here
  return `kind: McpTool\nserverUrl: ${MCP_URL}\n`;
}

const INSTRUCTIONS = `You are a helpful assistant with access to an MCP tool named get_magic_sentinel. When the user asks for the secret magic sentinel token, CALL the get_magic_sentinel tool and report exactly what it returns. Do not make up a value.`;

const ZERO = "00000000-0000-0000-0000-000000000000";
const createBody = {
  botComponentChanges: [
    {
      $kind: "BotComponentInsert",
      component: {
        diagnostics: [], displayName: NAME, id: ZERO,
        metadata: {
          tools: [], conversationStarters: [], diagnostics: [],
          instructions: { $kind: "TemplateLine", segments: [{ $kind: "TextSegment", value: INSTRUCTIONS, diagnostics: [] }], diagnostics: [] },
          knowledgeSources: { diagnostics: [], $kind: "SearchAllKnowledgeSources" },
          $kind: "GptComponentMetadata",
          gptCapabilities: { diagnostics: [], $kind: "GptCapabilities", codeInterpreter: false, generateImages: false, webBrowsing: false, searchOneDriveAndSharePoint: false, searchTeams: false, searchMeetings: false, searchEmails: false, searchPeople: false },
          aISettings: { diagnostics: [], $kind: "AISettings", useModelKnowledge: true },
        },
        schemaName: `${ZERO}.gpt.default`, $kind: "GptComponent", description: "MCP probe agent",
      },
    },
    {
      $kind: "BotComponentInsert",
      component: {
        $kind: "DialogComponent", id: "00000000-0000-0000-0000-000000000001",
        schemaName: `${ZERO}.tool.sentinelmcp`, displayName: "Sentinel MCP",
        description: "Fetches the secret magic sentinel token via MCP",
        dialog: toolDialogYaml(),
      },
    },
  ],
  cloudFlowDefinitionChanges: [], connectorDefinitionChanges: [], environmentVariableChanges: [],
  connectionReferenceChanges: [], aIPluginOperationChanges: [], componentCollectionChanges: [],
  dataverseTableSearchChanges: [], dataverseTableSearchEntityConfigurationChanges: [],
  dataverseTableSearchGlossaryConfigurationChanges: [], dataverseTableSearchEntityColumnSynonymChanges: [],
  aIModelChanges: [], connectedAgentDefinitionChanges: [],
  bot: { authorizedSecurityGroupIds: [], supportedLanguages: [], diagnostics: [], displayName: NAME, language: 1033, schemaName: ZERO, template: "gpt-1.1.0", $kind: "BotEntity", iconBase64: ICON },
};

console.log(`[mcp] creating agent ${NAME} with tool dialog:\n${toolDialogYaml().split("\n").map(l=>"      "+l).join("\n")}`);
const createRes = await ppFetch(API, { method: "POST", body: JSON.stringify(createBody) });
const createText = await createRes.text();
console.log(`[mcp] create → ${createRes.status}`);
if (!createRes.ok) {
  console.log(`[mcp] create FAILED body:\n${createText.slice(0, 1200)}`);
  process.exit(1);
}
const created = JSON.parse(createText);
const botId = created.bot?.schemaName || created.bot?.cdsBotId;
console.log(`[mcp] created botId=${botId}`);

// publish
const pubRes = await ppFetch(`${envUrl}/copilotstudio/minimalBots/api/${botId}/publish?api-version=2022-03-01-preview`, { method: "POST" });
const pubText = await pubRes.text();
console.log(`[mcp] publish → ${pubRes.status}`);
if (!pubRes.ok) { console.log(`[mcp] publish FAILED:\n${pubText.slice(0, 800)}`); }
let titleId = null;
try { titleId = JSON.parse(pubText).TitleId; } catch {}
console.log(`[mcp] titleId=${titleId}`);

async function cleanup() {
  try { const d = await ppFetch(`${envUrl}/copilotstudio/minimalBots/api/${botId}?api-version=2022-03-01-preview`, { method: "DELETE" }); console.log(`[mcp] cleanup delete → ${d.status}`); } catch (e) { console.log(`[mcp] cleanup err ${e.message}`); }
}

if (!titleId) { console.log("[mcp] no titleId — cannot chat-test"); await cleanup(); process.exit(1); }

const agentId = `${titleId}.${botId}.gpt.default`;
console.log(`[mcp] agentId=${agentId}`);

// chat test — ask it to use the tool
const token = await getToken();
const claims = decodeJwt(token);
console.log(`[mcp] chat: asking agent to call get_magic_sentinel ...`);
const r = await oneTurn({
  token, claims, agentId,
  text: "Call the get_magic_sentinel tool now and tell me the exact secret magic sentinel token it returns.",
  extraAllowed: ["TriggerPlugin", "Progress", "InternalLoaderMessage"],
  timeoutMs: 90000,
});
const got = (r.fullText || "");
const calledTool = readFileSync("scripts/sentinel-hits.log", "utf8").includes("tools/call");
const leaked = got.includes(SENTINEL);
console.log(`\n[mcp] === RESULT ===`);
console.log(`[mcp] reply: ${JSON.stringify(got.slice(0, 300))}`);
console.log(`[mcp] msgTypes: ${r.messageTypes.join(",")} disengaged=${r.disengaged} ${r.elapsedMs}ms`);
console.log(`[mcp] OUR MCP SERVER GOT A tools/call: ${calledTool}  ${calledTool ? "🎉 COPILOT CALLED OUR TOOL" : "❌ not called"}`);
console.log(`[mcp] sentinel value present in reply: ${leaked}  ${leaked ? "🎉🎉 END-TO-END TOOL EXECUTION" : ""}`);
await cleanup();
