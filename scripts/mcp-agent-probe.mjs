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

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { getToken, decodeJwt, getTokenForScope, getEnvironmentUrl } from "../packages/core/dist/index.mjs";
import { oneTurn as defaultOneTurn } from "./_probe-chat.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function main({ oneTurn = defaultOneTurn, fetcher = fetch } = {}) {

const TUNNEL = (process.argv[2] || readFileSync("/tmp/tunnel_url.txt", "utf8")).trim().replace(/\/$/, "");
const SHAPE = (() => { const i = process.argv.indexOf("--shape"); return i >= 0 ? process.argv[i + 1] : "bareurl"; })();
const MCP_URL = `${TUNNEL}/mcp`;
const SENTINEL = readFileSync("scripts/sentinel-value.txt", "utf8").trim();

const PP_SCOPES = ["https://api.powerplatform.com/.default"];
const BAP_SCOPES = ["https://api.bap.microsoft.com/.default"];
const NAME = `m365-mcp-probe-${randomUUID()}`;
const ICON = "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAB3RJTUUH6AMbAAAoLbOJEAAAABl0RVh0Q29tbWVudABDcmVhdGVkIHdpdGggR0lNUFeBDhcAAAAoSURBVFjD7cExAQAAAMKg9U9tDB+gAAAAAAAAAAAAAAAAAAAAAAAA/BgwMAAB/0LuMgAAAABJRU5ErkJggg==";

console.log(`[mcp] shape=${SHAPE}`);

const ppToken = await getTokenForScope(PP_SCOPES);
const bapToken = await getTokenForScope(BAP_SCOPES);
if (!ppToken || !bapToken) { console.error("missing PP/BAP token"); process.exit(1); }

// --- env discovery (shared with agent.ts) ---
const envUrl = await getEnvironmentUrl(bapToken);
console.log(`[mcp] env=${envUrl}`);

const ppFetch = (url, opts = {}) => fetcher(url, { ...opts, headers: { "Content-Type": "application/json", Authorization: `Bearer ${ppToken}`, "x-ms-user-agent": "PVA-Portal/1.0.0 (Web; ReactNative: false)", ...(opts.headers || {}) } });
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

console.log(`[mcp] creating temporary agent`);
const createRes = await ppFetch(API, { method: "POST", body: JSON.stringify(createBody) });
const createText = await createRes.text();
console.log(`[mcp] create → ${createRes.status}`);
if (!createRes.ok) throw new Error(`[mcp] create failed (HTTP ${createRes.status})`);
const created = JSON.parse(createText);
const botId = created.bot?.schemaName ?? created.bot?.cdsBotId;
// Existing code accepts either field; constrain it to one literal path segment.
if (typeof botId !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,255}$/.test(botId) || botId === "." || botId === "..") {
  throw new Error("Created agent response has invalid or no bot ID; cannot clean up safely");
}
const ownershipRes = await ppFetch(API, { method: "GET" });
if (!ownershipRes.ok) throw new Error("[mcp] unable to verify agent ownership");
let owners;
try { owners = await ownershipRes.json(); } catch { throw new Error("[mcp] unable to verify agent ownership"); }
if (!Array.isArray(owners) || owners.filter((row) => row?.botId === botId && row?.shortBotName === NAME).length !== 1 || owners.filter((row) => row?.botId === botId || row?.shortBotName === NAME).length !== 1) {
  throw new Error("[mcp] unable to verify agent ownership");
}
const botPath = `${envUrl}/copilotstudio/minimalBots/api/${encodeURIComponent(botId)}`;
console.log(`[mcp] created temporary agent`);

async function cleanup() {
  let response;
  try { response = await ppFetch(`${botPath}?api-version=2022-03-01-preview`, { method: "DELETE" }); }
  catch { throw new Error("[mcp] cleanup failed (transport error)"); }
  if (!response.ok) throw new Error(`[mcp] cleanup failed (HTTP ${response.status})`);
  console.log(`[mcp] cleanup delete → ${response.status}`);
}

let hasPrimaryError = false;
try {
// publish
const pubRes = await ppFetch(`${botPath}/publish?api-version=2022-03-01-preview`, { method: "POST" });
const pubText = await pubRes.text();
console.log(`[mcp] publish → ${pubRes.status}`);
if (!pubRes.ok) throw new Error(`[mcp] publish failed (HTTP ${pubRes.status})`);
let titleId = null;
try { titleId = JSON.parse(pubText).TitleId; } catch {}
console.log(`[mcp] titleId=${titleId}`);

if (!titleId) throw new Error("[mcp] no titleId — cannot chat-test");

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
if (r.attempted === false) throw new Error(`Probe not attempted: ${r.error}`);
const got = (r.fullText || "");
const calledTool = readFileSync("scripts/sentinel-hits.log", "utf8").includes("tools/call");
const leaked = got.includes(SENTINEL);
console.log(`\n[mcp] === RESULT ===`);
console.log(`[mcp] reply received: ${got.length > 0}`);
console.log(`[mcp] transport=${r.transport} msgTypes: ${r.messageTypes.join(",")} disengaged=${r.disengaged} ${r.elapsedMs}ms`);
console.log(`[mcp] OUR MCP SERVER GOT A tools/call: ${calledTool}  ${calledTool ? "🎉 COPILOT CALLED OUR TOOL" : "❌ not called"}`);
console.log(`[mcp] sentinel value present in reply: ${leaked}  ${leaked ? "🎉🎉 END-TO-END TOOL EXECUTION" : ""}`);
} catch (error) {
  hasPrimaryError = true;
  throw error;
} finally {
  try { await cleanup(); }
  catch (error) {
    if (!hasPrimaryError) throw error;
    console.log("[mcp] cleanup failed; temporary agent may remain");
  }
}

}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
