// Read-only: inspect the state of our provisioned agent/bot as the authoring API
// sees it — is it actually published to the M365 (BizChat/MOS3) channel, or only
// created in Dataverse? GET only. Usage:
//   M365_NO_INTERACTIVE=1 node scripts/agent-state-probe.mjs
process.env.M365_DEBUG = process.env.M365_DEBUG ?? "1";

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getTokenForScope } from "../packages/core/dist/index.mjs";

const PP_SCOPES = ["https://api.powerplatform.com/.default"];
const BAP_SCOPES = ["https://api.bap.microsoft.com/.default"];
const BAP_API = "https://api.bap.microsoft.com";

const cache = JSON.parse(readFileSync(join(homedir(), ".config", "m365-proxy", "agent-id.json"), "utf8"));
console.log("[probe] cached agent:", cache.agentId);
console.log("[probe] botId:", cache.botId);

const bapToken = await getTokenForScope(BAP_SCOPES);
const ppToken = await getTokenForScope(PP_SCOPES);
const ppHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${ppToken}`, "x-ms-user-agent": "PVA-Portal/1.0.0 (Web; ReactNative: false)" };

// Resolve the default env host (same derivation as agent.ts).
const defRes = await fetch(`${BAP_API}/providers/Microsoft.BusinessAppPlatform/environments/~default?api-version=2023-06-01`, { headers: { Authorization: `Bearer ${bapToken}` } });
const def = await defRes.json();
const id = def.name.replace(/-/g, "").toLowerCase();
const envUrl = `https://${id.slice(0, -2)}.${id.slice(-2)}.environment.api.powerplatform.com`;
console.log("[probe] envUrl:", envUrl);

// 1. List minimalBots — find OUR bot and dump its full record (publish state, channels).
const listRes = await fetch(`${envUrl}/copilotstudio/minimalBots/api?api-version=2022-03-01-preview`, { headers: ppHeaders });
console.log("[probe] minimalBots list status:", listRes.status);
const bots = await listRes.json();
console.log(`[probe] ${Array.isArray(bots) ? bots.length : "?"} bot(s)`);
const ours = Array.isArray(bots) ? bots.find((b) => (b.botId || b.cdsBotId || "").includes(cache.botId) || (b.shortBotName || "").startsWith("m365-tool-agent")) : null;
console.log("[probe] our bot record:");
console.log(JSON.stringify(ours ?? bots, null, 2).slice(0, 2000));

// 2. Try a per-bot GET (publish status) on a few likely sub-paths.
for (const sub of [
    `/copilotstudio/minimalBots/api/${cache.botId}?api-version=2022-03-01-preview`,
    `/copilotstudio/minimalBots/api/${cache.botId}/publish?api-version=2022-03-01-preview`,
    `/powervirtualagents/bots/${cache.botId}/api/botcomponents?api-version=2022-03-01-preview`,
]) {
    try {
        const r = await fetch(`${envUrl}${sub}`, { headers: ppHeaders });
        const body = await r.text();
        console.log(`\n[probe] GET ${sub.split("?")[0]} -> ${r.status}  ${body.slice(0, 300).replace(/\n/g, " ")}`);
    } catch (e) {
        console.log(`\n[probe] GET ${sub.split("?")[0]} -> ERR ${e.message}`);
    }
}
